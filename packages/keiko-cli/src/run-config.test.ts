import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { runAgentCli } from "./run.js";
import type { CliIo } from "./runner.js";
import {
  FIXTURE_API_KEY,
  PROVIDER_CREDENTIALS_KEY,
  REAL_TMPDIR,
  writeGatewayConfig as writeGatewayConfigFixture,
  writeReferenceOnlyGatewayConfig as writeReferenceOnlyGatewayConfigFixture,
} from "./test-support/gateway-config-fixture.js";

function capture(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (t: string): void => {
        out += t;
      },
      err: (t: string): void => {
        err += t;
      },
    },
    out: (): string => out,
    err: (): string => err,
  };
}

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(REAL_TMPDIR, "keiko-run-config-"));
  tempRoots.push(root);
  return root;
}

// Shared config-build args. The pre-refactor run-config fixture emitted providers with no
// capability block, so the CLI falls back to the built-in registry — this is what lets the
// "rejects embedding-only config" test detect that text-embedding-3-large is not a chat model.
const RUN_CONFIG_FIXTURE_DEFAULTS = {
  baseUrl: "https://host.example/v1",
  apiKey: FIXTURE_API_KEY,
  filename: "keiko.config.json",
  capabilityMode: "omit" as const,
  maxRetries: 3,
};

function writeGatewayConfig(modelIds: readonly string[]): string {
  return writeGatewayConfigFixture(tempRoot(), { modelIds, ...RUN_CONFIG_FIXTURE_DEFAULTS });
}

function response(modelId: string): NormalizedResponse {
  return {
    modelId,
    content: "--- a/file\n+++ b/file\n+// dry-run proposed change\n",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "test-run",
      promptTokens: 0,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function capturingModel(seen: string[]): ModelPort {
  return {
    call: (request: GatewayRequest): Promise<NormalizedResponse> => {
      seen.push(request.modelId);
      return Promise.resolve(response(request.modelId));
    },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runAgentCli gateway config resolution", () => {
  it("selects the default chat model from KEIKO_CONFIG_FILE for injected model runs", async () => {
    const configPath = writeGatewayConfig(["example-chat-model"]);
    const seen: string[] = [];
    const c = capture();

    const code = await runAgentCli(
      ["explain-plan", "--file", "src/foo.ts", "--no-evidence"],
      c.io,
      { KEIKO_CONFIG_FILE: configPath },
      { model: capturingModel(seen) },
    );

    expect(code).toBe(0);
    expect(seen).toEqual(["example-chat-model"]);
    expect(c.out()).toContain("run:completed");
    expect(c.err()).toBe("");
  });

  it("selects a model from a migrated reference-only config for injected model runs", async () => {
    const configPath = writeReferenceOnlyGatewayConfigFixture(tempRoot(), {
      modelIds: ["example-chat-model"],
      ...RUN_CONFIG_FIXTURE_DEFAULTS,
    });
    const seen: string[] = [];
    const c = capture();

    const code = await runAgentCli(
      ["explain-plan", "--file", "src/foo.ts", "--no-evidence", "--config", configPath],
      c.io,
      { KEIKO_PROVIDER_CREDENTIALS_KEY: PROVIDER_CREDENTIALS_KEY },
      { model: capturingModel(seen) },
    );

    expect(code).toBe(0);
    expect(seen).toEqual(["example-chat-model"]);
    expect(c.out() + c.err()).not.toContain(FIXTURE_API_KEY);
  });

  it("honors an explicit configured model from --config before calling the model port", async () => {
    const configPath = writeGatewayConfig(["default-chat-model", "explicit-chat-model"]);
    const seen: string[] = [];
    const c = capture();

    const code = await runAgentCli(
      [
        "generate-unit-tests",
        "--file",
        "src/foo.ts",
        "--no-evidence",
        "--config",
        configPath,
        "--model",
        "explicit-chat-model",
      ],
      c.io,
      {},
      { model: capturingModel(seen) },
    );

    expect(code).toBe(0);
    expect(seen).toEqual(["explicit-chat-model"]);
    expect(c.out()).toContain("patch:proposed");
  });

  it("rejects a config that only exposes embedding models before building a gateway port", async () => {
    const configPath = writeGatewayConfig(["text-embedding-3-large"]);
    const c = capture();

    const code = await runAgentCli(
      ["explain-plan", "--file", "src/foo.ts", "--no-evidence", "--config", configPath],
      c.io,
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("no configured chat model");
    expect(c.err()).not.toContain(FIXTURE_API_KEY);
  });
});
