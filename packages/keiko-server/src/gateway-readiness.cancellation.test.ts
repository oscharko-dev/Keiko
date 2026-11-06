import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultChatCapability, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import { runGatewayReadiness } from "./gateway-readiness.js";
import { defaultServerDiagnosticSink } from "./diagnostics-log.js";
import { closeFileServerLogSinks } from "./observability/index.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";

// #4271 L1.1: a readiness probe that Keiko itself cancelled (server shutdown) is not a gateway
// failure, and a lost connection is an outage rather than an internal fault. Both are driven
// through the real probe and the real diagnostic sink, then read back from the persisted line.

const MODEL = "cancellation-model";

function config(): GatewayConfig {
  return {
    providers: [
      {
        modelId: MODEL,
        baseUrl: "https://llm-gateway.internal/v1",
        apiKey: "secret-token",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 0,
      },
    ],
    capabilities: [createDefaultChatCapability(MODEL)],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

function depsFor(fetchImpl: typeof fetch, signal?: AbortSignal): UiHandlerDeps {
  const gateway = config();
  return {
    config: gateway,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    gatewayReadinessFetch: fetchImpl,
    ...(signal === undefined ? {} : { gatewayReadinessSignal: signal }),
    diagnostics: defaultServerDiagnosticSink,
    gatewayConfig: {
      storagePath: "/dev/null",
      current: () => gateway,
      present: () => true,
      set: () => undefined,
      verification: () => UNVERIFIED_GATEWAY,
      generation: () => 7,
      recordVerification: () => undefined,
      verifiedCapability: () => undefined,
      recordVerifiedCapability: () => undefined,
      clearVerifiedCapability: () => true,
    },
  };
}

describe("gateway readiness probe failure classification (#4271 L1.1)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-readiness-cancellation-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    closeFileServerLogSinks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function diagnosticLine(): ReturnType<typeof expectActivityLogProof> {
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "server.diagnostic.failure",
    );
    expect(lines).toHaveLength(1);
    return expectActivityLogProof("server.diagnostic.failure.activity-log-line", lines[0] ?? "");
  }

  it("records a probe cancelled by shutdown as a cancelled warning, not an error", async () => {
    const controller = new AbortController();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      });
    }) as unknown as typeof fetch;
    const run = runGatewayReadiness(
      { modelId: MODEL, options: { probes: ["chat"] } },
      depsFor(fetchImpl, controller.signal),
      "readiness-shutdown-001",
    );
    await started;
    controller.abort();
    await run;

    expect(diagnosticLine()).toMatchObject({
      level: "warn",
      correlationId: "readiness-shutdown-001",
      errorKind: "cancelled",
      diagnosticOutcome: "request-cancelled",
    });
  });

  it("keeps a lost connection an error but names it unavailable, never internal", async () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(
        new TypeError("fetch failed", { cause: reset }),
      ) as unknown as typeof fetch;

    await runGatewayReadiness(
      { modelId: MODEL, options: { probes: ["chat"] } },
      depsFor(fetchImpl),
      "readiness-reset-001",
    );

    expect(diagnosticLine()).toMatchObject({
      level: "error",
      correlationId: "readiness-reset-001",
      errorKind: "unavailable",
      code: "ECONNRESET",
    });
  });

  it("keeps a TypeError with no network cause an internal error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("bug")) as unknown as typeof fetch;

    await runGatewayReadiness(
      { modelId: MODEL, options: { probes: ["chat"] } },
      depsFor(fetchImpl),
      "readiness-bug-001",
    );

    expect(diagnosticLine()).toMatchObject({ level: "error", errorKind: "internal" });
  });
});
