import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigInvalidError,
  type EnvSource,
  type GatewayConfig,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { createEvaluationModelProvider } from "./model-provider.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function response(content: string): NormalizedResponse {
  return {
    modelId: "eval-model",
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "eval-request",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

const LIVE_CONFIG: GatewayConfig = {
  providers: [
    {
      modelId: "eval-model",
      baseUrl: "https://models.example.invalid/openai/v1",
      apiKey: "test-key",
      timeoutMs: 30_000,
      maxRetries: 2,
      retryBaseDelayMs: 500,
    },
  ],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
};

function writeConfig(): string {
  const dir = tmp("keiko-eval-config-");
  const path = join(dir, "keiko.config.json");
  writeFileSync(path, JSON.stringify(LIVE_CONFIG), "utf8");
  return path;
}

describe("createEvaluationModelProvider", () => {
  it("uses scripted offline replay and ignores live config loader inputs", async () => {
    const configLoader = vi.fn(() => LIVE_CONFIG);
    const port = createEvaluationModelProvider({
      mode: "offline",
      transcript: [response("offline response")],
      modelId: "eval-model",
      configPath: "/ignored/config.json",
      env: { KEIKO_CONFIG_FILE: "/ignored/env.json" },
      configLoader,
    });

    await expect(
      port.call({ modelId: "eval-model", messages: [], tools: [] }, new AbortController().signal),
    ).resolves.toMatchObject({ content: "offline response" });
    expect(configLoader).not.toHaveBeenCalled();
  });

  it("loads live config through the injected loader at an explicit config path", () => {
    const env: EnvSource = { KEIKO_CONFIG_FILE: "/env/config.json" };
    const configLoader = vi.fn(() => LIVE_CONFIG);

    const port = createEvaluationModelProvider({
      mode: "live",
      transcript: [],
      modelId: "eval-model",
      configPath: "/explicit/config.json",
      env,
      configLoader,
    });

    expect(port.call).toEqual(expect.any(Function));
    expect(configLoader).toHaveBeenCalledWith("/explicit/config.json", env);
  });

  it("falls back to KEIKO_CONFIG_FILE for live injected config loading", () => {
    const env: EnvSource = { KEIKO_CONFIG_FILE: "/env/config.json" };
    const configLoader = vi.fn(() => LIVE_CONFIG);

    const port = createEvaluationModelProvider({
      mode: "live",
      transcript: [],
      modelId: "eval-model",
      env,
      configLoader,
    });

    expect(port.call).toEqual(expect.any(Function));
    expect(configLoader).toHaveBeenCalledWith("/env/config.json", env);
  });

  it("uses the default live config loader when no loader is injected", () => {
    const configPath = writeConfig();

    const port = createEvaluationModelProvider({
      mode: "live",
      transcript: [],
      modelId: "eval-model",
      configPath,
    });

    expect(port.call).toEqual(expect.any(Function));
  });

  it("fails closed when live mode has no config source", () => {
    expect(() =>
      createEvaluationModelProvider({
        mode: "live",
        transcript: [],
        modelId: "eval-model",
      }),
    ).toThrow(ConfigInvalidError);
  });
});
