// Activity Log scenario matrix (#3532): the model-gateway surface — Gateway chat/stream calls, http
// egress, the circuit breaker, and the gateway's own log-sink loss path. Each scenario drives a
// production `Gateway` entry point with the real production file writer under a temporary
// `KEIKO_STATE_DIR`, wired to the file sink exactly as keiko-server composes it in production
// (`processServerLogSink()`, gateway-instance-cache.ts), and reconstructs the persisted log through
// `keiko support analyze` to a complete report (tests/support/activity-log-scenario.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Gateway,
  createScriptedGatewayClock,
  createScriptedGatewayFetch,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  type CircuitBreakerConfig,
  type GatewayConfig,
  type GatewayStreamChunk,
  type ModelProviderConfig,
  type NormalizedResponse,
  type ProviderAdapter,
} from "@oscharko-dev/keiko-model-gateway";
import { TransportError } from "@oscharko-dev/keiko-security/errors/gateway";

import {
  resetServerLogger,
  type ServerLogEvent,
  type ServerLogLevel,
} from "../../packages/keiko-server/src/observability/index.js";
import {
  processServerLogSink,
  type ProcessServerLogSink,
} from "../../packages/keiko-server/src/process-log-sink.js";
import {
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../support/activity-log-proof.js";
import { expectActivityLogScenario } from "../support/activity-log-scenario.js";

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "example-chat-model",
    baseUrl: "https://provider.example/v1",
    apiKey: ["sk-", "model-gateway-scenario-key-1234567890ab"].join(""),
    timeoutMs: 30_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function config(
  providers: readonly ModelProviderConfig[],
  circuitBreaker: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
): GatewayConfig {
  return { providers: [...providers], circuitBreaker };
}

const REQUEST = {
  modelId: "example-chat-model",
  messages: [{ role: "user" as const, content: "hello" }],
};

function okResponse(modelId: string): NormalizedResponse {
  return {
    modelId,
    content: "answer",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
  };
}

// Reads the scenario's ACTUAL persisted line — not a captured in-memory event — exactly as the
// production file sink wrote it under `stateDir`, the same source `expectActivityLogScenario`
// reconstructs from.
function persistedLine(raw: string, op: string, occurrence = 0): Record<string, unknown> {
  const lines = persistedActivityLogLines(raw, op);
  const line = lines[occurrence];
  if (line === undefined) {
    throw new Error(
      `expected a persisted '${op}' line at index ${String(occurrence)}, saw ${String(lines.length)}`,
    );
  }
  return JSON.parse(line) as Record<string, unknown>;
}

describe("Activity Log scenario: model-gateway", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-scenario-model-gateway-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
    resetServerLogger();
  });

  afterEach(() => {
    resetServerLogger();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reconstructs a mid-stream abandonment to a complete crash lifecycle", async () => {
    const startedAtMs = Date.now();
    const adapter: ProviderAdapter = {
      call: () => Promise.resolve(okResponse("example-chat-model")),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        yield { type: "delta", token: "a" };
        yield { type: "delta", token: "b" };
        yield { type: "done", response: await Promise.resolve(okResponse("example-chat-model")) };
      },
    };
    const gateway = new Gateway(config([provider()]), {
      adapter,
      clock: createScriptedGatewayClock(),
      log: processServerLogSink(),
    });

    for await (const chunk of gateway.chatStream(REQUEST)) {
      expect(chunk.type).toBe("delta");
      break;
    }

    const trace = expectActivityLogScenario("model-gateway.crash", {
      stateDir,
      startedAtMs,
      expectedOps: ["gateway.stream.started", "gateway.stream.abandoned"],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["gateway-stream-call"]));

    const raw = readPersistedActivityLog(stateDir);
    const started = persistedLine(raw, "gateway.stream.started");
    const abandoned = persistedLine(raw, "gateway.stream.abandoned");
    expect(abandoned.correlationId).toBe(started.correlationId);
    expect(abandoned).toMatchObject({ chunkCount: 1, reason: "consumer-stopped-iterating" });
  });

  it("reconstructs a failed transport call to a complete dependency-failure lifecycle", async () => {
    const startedAtMs = Date.now();
    const clock = createScriptedGatewayClock();
    const fetchImpl = createScriptedGatewayFetch([{ networkError: true }], clock);
    const gateway = new Gateway(config([provider()]), {
      clock,
      fetchImpl,
      log: processServerLogSink(),
    });

    await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(TransportError);

    const trace = expectActivityLogScenario("model-gateway.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: [
        "gateway.chat.started",
        "chat.request.dispatch",
        "http.gateway.fetch.started",
        "http.gateway.fetch.failed",
        "gateway.chat.failed",
      ],
    });
    expect(trace.failureClasses).toEqual(
      expect.arrayContaining(["gateway-chat-call", "gateway-http-fetch"]),
    );

    const raw = readPersistedActivityLog(stateDir);
    const started = persistedLine(raw, "gateway.chat.started");
    const failed = persistedLine(raw, "gateway.chat.failed");
    const fetchFailed = persistedLine(raw, "http.gateway.fetch.failed");
    expect(failed.correlationId).toBe(started.correlationId);
    expect(fetchFailed.correlationId).toBe(started.correlationId);
  });

  it("reconstructs a circuit-breaker rejection to a complete rejection lifecycle", async () => {
    const startedAtMs = Date.now();
    const clock = createScriptedGatewayClock();
    const adapter: ProviderAdapter = {
      call: () => Promise.reject(new TransportError("scenario-fault-injection: provider down")),
    };
    const gateway = new Gateway(
      config([provider()], { failureThreshold: 1, cooldownMs: 60_000, halfOpenProbes: 1 }),
      { adapter, clock, log: processServerLogSink() },
    );

    await expect(gateway.chat(REQUEST)).rejects.toBeInstanceOf(TransportError);
    await expect(gateway.chat(REQUEST)).rejects.toThrow();

    const trace = expectActivityLogScenario("model-gateway.rejection", {
      stateDir,
      startedAtMs,
      expectedOps: [
        "gateway.chat.started",
        "gateway.circuit.opened",
        "gateway.circuit.rejected",
        "gateway.chat.failed",
      ],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["gateway-circuit-breaker"]));

    const raw = readPersistedActivityLog(stateDir);
    const rejected = persistedLine(raw, "gateway.circuit.rejected");
    const secondFailed = persistedLine(raw, "gateway.chat.failed", 1);
    expect(rejected.correlationId).toBe(secondFailed.correlationId);
    expect(rejected).toMatchObject({ state: "open", reason: "cooldown" });
  });

  it("reconstructs a failing log sink to a complete loss lifecycle", async () => {
    const startedAtMs = Date.now();
    let dropped = false;
    const droppingSink: ProcessServerLogSink = {
      write(event: ServerLogEvent): void {
        if (!dropped && event.op === "gateway.config.resolved") {
          dropped = true;
          throw new Error("scenario-fault-injection: model-gateway sink failure");
        }
        processServerLogSink().write(event);
      },
      enabled(level: ServerLogLevel): boolean {
        return processServerLogSink().enabled(level);
      },
    };
    const adapter: ProviderAdapter = {
      call: (): Promise<NormalizedResponse> => Promise.resolve(okResponse("example-chat-model")),
    };
    const gateway = new Gateway(config([provider()]), {
      adapter,
      clock: createScriptedGatewayClock(),
      log: droppingSink,
    });

    await expect(gateway.chat(REQUEST)).resolves.toMatchObject({ content: "answer" });

    const trace = expectActivityLogScenario("model-gateway.loss", {
      stateDir,
      startedAtMs,
      expectedOps: ["gateway.log.sink-failed", "gateway.chat.started", "gateway.chat.completed"],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["activity-log-sink-failure"]));

    const raw = readPersistedActivityLog(stateDir);
    expect(persistedActivityLogLines(raw, "gateway.config.resolved")).toEqual([]);
    const sinkFailed = persistedLine(raw, "gateway.log.sink-failed");
    expect(sinkFailed).toMatchObject({ droppedOp: "gateway.config.resolved" });
  });
});
