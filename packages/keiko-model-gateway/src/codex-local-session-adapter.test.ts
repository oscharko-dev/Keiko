import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  ConfigInvalidError,
  ProviderError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { CodexLocalSessionAdapter, type CodexCliCommandRunner } from "./codex-local-session-adapter.js";
import type {
  GatewayRequest,
  ModelProviderConfig,
  ResponseFormat,
} from "./types.js";

const CONFIG: ModelProviderConfig = {
  providerType: "openai-codex-local-session",
  modelId: "gpt-5.4",
  credentialResolver: { kind: "codex-cli" },
  timeoutMs: 30_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};

const REQUEST: GatewayRequest = {
  modelId: "gpt-5.4",
  messages: [{ role: "user", content: "Say hi" }],
};

function okDoctor(): string {
  return JSON.stringify({
    overallStatus: "ok",
    codexVersion: "codex-cli 0.138.0-alpha.7",
    checks: {
      "auth.credentials": { status: "ok", summary: "auth is configured" },
      "network.websocket_reachability": { status: "ok", summary: "handshake succeeded" },
    },
  });
}

function okCatalog(): string {
  return JSON.stringify({
    models: [
      {
        slug: "gpt-5.4",
        visibility: "list",
        supported_in_api: true,
        shell_type: "shell_command",
        description: "General local coding model",
      },
      {
        slug: "codex-auto-review",
        visibility: "hide",
        supported_in_api: true,
        shell_type: "shell_command",
      },
    ],
  });
}

function execJsonl(content: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: content } }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 12, output_tokens: 4, reasoning_output_tokens: 0 },
    }),
  ].join("\n");
}

function runner(
  responses: Readonly<Record<string, { readonly stdout: string; readonly exitCode?: number }>>,
): CodexCliCommandRunner {
  return async (input) => {
    const key = `${input.command}:${input.modelId ?? ""}`;
    const result = responses[key];
    if (result === undefined) {
      throw new Error(`unexpected command ${key}`);
    }
    return {
      stdout: result.stdout,
      stderr: "",
      exitCode: result.exitCode ?? 0,
      terminatedBySignal: null,
    };
  };
}

function adapter(commandRunner: CodexCliCommandRunner): CodexLocalSessionAdapter {
  let current = 1000;
  return new CodexLocalSessionAdapter({
    commandRunner,
    requestId: "req-1",
    costClass: "medium",
    now: () => (current += 25),
  });
}

function jsonSchema(schema: Record<string, unknown>): ResponseFormat {
  return { type: "json_schema", schema };
}

describe("CodexLocalSessionAdapter", () => {
  it("discovers visible supported models through the codex catalog", async () => {
    const subject = adapter(
      runner({
        "version:": { stdout: "codex-cli 0.138.0-alpha.7" },
        "doctor-json:": { stdout: okDoctor() },
        "debug-models:": { stdout: okCatalog() },
      }),
    );
    const models = await subject.discoverModels(CONFIG);
    expect(models).toEqual(["gpt-5.4"]);
  });

  it("probes local-session capabilities with workflow eligibility and no gateway tool-calling", async () => {
    const subject = adapter(
      runner({
        "version:": { stdout: "codex-cli 0.138.0-alpha.7" },
        "doctor-json:": { stdout: okDoctor() },
        "debug-models:": { stdout: okCatalog() },
      }),
    );
    const capabilities = await subject.probeCapabilities(CONFIG);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]).toMatchObject({
      id: "gpt-5.4",
      workflowEligible: true,
      toolCalling: false,
      structuredOutput: true,
      streaming: false,
    });
  });

  it("invokes codex exec JSONL and returns a normalized text response", async () => {
    const subject = adapter(
      runner({
        "version:": { stdout: "codex-cli 0.138.0-alpha.7" },
        "doctor-json:": { stdout: okDoctor() },
        "exec-json:gpt-5.4": { stdout: execJsonl("Hello from Codex") },
      }),
    );
    const result = await subject.call(REQUEST, CONFIG);
    expect(result).toMatchObject({
      modelId: "gpt-5.4",
      content: "Hello from Codex",
      finishReason: "stop",
      toolCalls: [],
      structuredOutput: null,
    });
    expect(result.usage).toMatchObject({
      requestId: "req-1",
      promptTokens: 12,
      completionTokens: 4,
      costClass: "medium",
    });
    expect(result.usage.latencyMs).toBeGreaterThan(0);
  });

  it("parses JSON-schema responses into structuredOutput", async () => {
    const subject = adapter(
      runner({
        "version:": { stdout: "codex-cli 0.138.0-alpha.7" },
        "doctor-json:": { stdout: okDoctor() },
        "exec-json:gpt-5.4": { stdout: execJsonl('{\"answer\":42}') },
      }),
    );
    const result = await subject.call(
      { ...REQUEST, responseFormat: jsonSchema({ type: "object", properties: { answer: { type: "number" } } }) },
      CONFIG,
    );
    expect(result.structuredOutput).toEqual({ answer: 42 });
  });

  it("fails closed when gateway tool definitions are requested", async () => {
    const subject = adapter(
      runner({
        "version:": { stdout: "codex-cli 0.138.0-alpha.7" },
        "doctor-json:": { stdout: okDoctor() },
      }),
    );
    await expect(
      subject.call(
        {
          ...REQUEST,
          tools: [{ name: "search", description: "search", parameters: { type: "object" } }],
        },
        CONFIG,
      ),
    ).rejects.toBeInstanceOf(ConfigInvalidError);
  });

  it("classifies missing local authentication as an AuthenticationError", async () => {
    const subject = adapter(
      runner({
        "version:": { stdout: "codex-cli 0.138.0-alpha.7" },
        "doctor-json:": {
          stdout: JSON.stringify({
            overallStatus: "fail",
            checks: {
              "auth.credentials": { status: "fail", summary: "auth missing" },
              "network.websocket_reachability": { status: "fail", summary: "not attempted" },
            },
          }),
        },
        "login-status:": { stdout: "", exitCode: 1 },
      }),
    );
    await expect(subject.call(REQUEST, CONFIG)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("fails on malformed local-session JSONL output", async () => {
    const subject = adapter(
      runner({
        "version:": { stdout: "codex-cli 0.138.0-alpha.7" },
        "doctor-json:": { stdout: okDoctor() },
        "exec-json:gpt-5.4": { stdout: JSON.stringify({ type: "turn.completed", usage: {} }) },
      }),
    );
    await expect(subject.call(REQUEST, CONFIG)).rejects.toBeInstanceOf(ProviderError);
  });
});
