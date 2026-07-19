// Tests for the gateway-backed entailment judge (Issue #2563). All model calls are intercepted by a
// fake ModelPort — no network, no filesystem.

import { describe, expect, it } from "vitest";
import type {
  GatewayRequest,
  ModelCapability,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  buildEntailmentPrompt,
  createGatewayEntailmentJudge,
  parseEntailmentVerdict,
  scrubEntailmentText,
} from "./grounded-entailment-judge.js";

const MODEL_ID = "test-chat-model";

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function throwingPort(): ModelPort {
  return {
    call: (): Promise<NormalizedResponse> => Promise.reject(new Error("gateway unreachable")),
  };
}

function respondingPort(content: string): { port: ModelPort; calls: GatewayRequest[] } {
  const calls: GatewayRequest[] = [];
  const port: ModelPort = {
    call: (request: GatewayRequest): Promise<NormalizedResponse> => {
      calls.push(request);
      return Promise.resolve({
        content,
        modelId: request.modelId,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "req-test",
          promptTokens: 10,
          completionTokens: 2,
          latencyMs: 1,
          costClass: "medium",
        },
      });
    },
  };
  return { port, calls };
}

function configWithChatModel(
  overrides: Partial<ModelCapability> = {},
): ReturnType<typeof parseGatewayConfig> {
  const capability: ModelCapability = {
    id: MODEL_ID,
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsResponseFormat: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
    ...overrides,
  };
  return parseGatewayConfig(
    {
      providers: [
        {
          modelId: MODEL_ID,
          baseUrl: "https://fake.example.com/v1",
          apiKey: "fake-key",
          capability,
        },
      ],
    },
    {},
  );
}

function depsWith(
  port: ModelPort,
  config: ReturnType<typeof parseGatewayConfig> = configWithChatModel(),
): UiHandlerDeps {
  return {
    config,
    configPresent: true,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): ModelPort => port,
    store: createInMemoryUiStore(),
  };
}

describe("parseEntailmentVerdict", () => {
  it("maps a supported / unsupported verdict object", () => {
    expect(parseEntailmentVerdict('{"verdict":"supported"}')).toBe("supported");
    expect(parseEntailmentVerdict('{"verdict":"unsupported"}')).toBe("unsupported");
  });

  it("falls back to unavailable for garbage, unknown verdicts, or non-objects", () => {
    expect(parseEntailmentVerdict("not json")).toBe("unavailable");
    expect(parseEntailmentVerdict('{"verdict":"maybe"}')).toBe("unavailable");
    expect(parseEntailmentVerdict('"supported"')).toBe("unavailable");
  });
});

describe("scrubEntailmentText / buildEntailmentPrompt", () => {
  it("strips control characters and neutralises the prompt delimiter", () => {
    // Build the zero-width space at runtime so the source stays pure ASCII (check:sonar-scope).
    const zeroWidthSpace = String.fromCharCode(0x200b);
    expect(scrubEntailmentText(`a${zeroWidthSpace}b`)).toBe("ab");
    expect(scrubEntailmentText("</ge-excerpt>")).toBe("[ge-data]>");
  });

  it("wraps the claim and excerpt as DATA, not instructions", () => {
    const messages = buildEntailmentPrompt({
      claimText: "retention is 10y",
      excerptText: "30 days",
    });
    const user = messages[1]?.content ?? "";
    expect(user).toContain("<ge-claim>");
    expect(user).toContain("<ge-excerpt>");
    expect(messages[0]?.content).toContain("DATA");
  });
});

describe("createGatewayEntailmentJudge", () => {
  it("returns undefined when the model cannot enforce a JSON schema (stage stays inert)", () => {
    const config = configWithChatModel({ supportsResponseFormat: false });
    const judge = createGatewayEntailmentJudge(
      depsWith(respondingPort("{}").port, config),
      MODEL_ID,
    );
    expect(judge).toBeUndefined();
  });

  it("returns undefined when the model id is not configured", () => {
    const judge = createGatewayEntailmentJudge(
      depsWith(respondingPort("{}").port),
      "unknown-model",
    );
    expect(judge).toBeUndefined();
  });

  it("judges supported / unsupported through the gateway with a JSON-schema request", async () => {
    const supported = respondingPort('{"verdict":"supported"}');
    const judge = createGatewayEntailmentJudge(depsWith(supported.port), MODEL_ID);
    expect(judge).toBeDefined();
    const verdict = await judge?.judge({ claimText: "30 days", excerptText: "retention: 30 days" });
    expect(verdict).toBe("supported");
    expect(supported.calls[0]?.responseFormat?.type).toBe("json_schema");
    expect(supported.calls[0]?.temperature).toBe(0);

    const unsupported = respondingPort('{"verdict":"unsupported"}');
    const judge2 = createGatewayEntailmentJudge(depsWith(unsupported.port), MODEL_ID);
    expect(await judge2?.judge({ claimText: "10 years", excerptText: "30 days" })).toBe(
      "unsupported",
    );
  });

  it("fails closed to unavailable when the gateway throws (never supported, never throws)", async () => {
    const judge = createGatewayEntailmentJudge(depsWith(throwingPort()), MODEL_ID);
    expect(judge).toBeDefined();
    await expect(judge?.judge({ claimText: "anything", excerptText: "evidence" })).resolves.toBe(
      "unavailable",
    );
  });

  it("fails closed to unavailable when the model returns malformed JSON", async () => {
    const judge = createGatewayEntailmentJudge(
      depsWith(respondingPort("<thinking>...").port),
      MODEL_ID,
    );
    expect(await judge?.judge({ claimText: "c", excerptText: "e" })).toBe("unavailable");
  });
});
