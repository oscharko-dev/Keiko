import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityLogEventRegistration,
  type ActivityLogDiagnosticCondition,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createFileServerLogSink, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  CancelledError,
  CircuitOpenError,
  ProviderError,
  TransportError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { Gateway } from "../packages/keiko-model-gateway/src/gateway.js";
import {
  CircuitBreaker,
  executeWithRetry,
} from "../packages/keiko-model-gateway/src/resilience.js";
import type { ModelGatewayLogEvent } from "../packages/keiko-model-gateway/src/observability.js";
import type {
  Clock,
  GatewayStreamChunk,
  NormalizedResponse,
  ProviderAdapter,
} from "../packages/keiko-model-gateway/src/types.js";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  runSupportQuery,
  type SupportQueryResult,
} from "../packages/keiko-activity-log/src/reader/support-query.js";
import {
  ActivityLogScanner,
  ensureSegmentManifests,
  listActivityLogStoreFiles,
} from "../packages/keiko-activity-log/src/reader/support-segment-scan.js";

function response(finishReason: NormalizedResponse["finishReason"]): NormalizedResponse {
  return {
    modelId: "gateway-query-model",
    content: "answer",
    finishReason,
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "provider-request",
      promptTokens: 1024,
      completionTokens: 64,
      latencyMs: 1,
      costClass: "high",
    },
  };
}

function query(stateDir: string): SupportQueryResult {
  const files = listActivityLogStoreFiles(stateDir);
  const scanner = new ActivityLogScanner(stateDir);
  const pass = ensureSegmentManifests(stateDir, files, scanner, {
    trigger: "query",
    persist: false,
    rebuild: false,
  });
  return runSupportQuery({
    files,
    scanner,
    manifests: pass.manifests,
    manifestStats: pass.stats,
    selection: {
      kind: "closure",
      queryClass: "incident",
      roots: [],
      windows: [{ fromMs: 0, toMs: Date.now() + 1000 }],
      requiredClasses: { kind: "observed-failures" },
      unresolved: false,
    },
    limits: { ...DEFAULT_SUPPORT_QUERY_LIMITS, maxContextEvents: 0 },
  });
}

interface Recorder {
  readonly write: (event: ModelGatewayLogEvent) => void;
  readonly events: ModelGatewayLogEvent[];
}

function recorder(): Recorder {
  const events: ModelGatewayLogEvent[] = [];
  return {
    events,
    write: (event): void => {
      events.push(event);
    },
  };
}

function gatewayFor(log: Recorder, adapter: ProviderAdapter): Gateway {
  return new Gateway(
    {
      providers: [
        {
          modelId: "gateway-query-model",
          baseUrl: "https://provider.example/v1",
          apiKey: "synthetic-test-key",
          timeoutMs: 30_000,
          maxRetries: 0,
          retryBaseDelayMs: 1,
        },
      ],
      circuitBreaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenProbes: 1 },
    },
    { log, adapter },
  );
}

async function completedChat(finishReason: NormalizedResponse["finishReason"]): Promise<Recorder> {
  const log = recorder();
  const gateway = gatewayFor(log, {
    call: (): Promise<NormalizedResponse> => Promise.resolve(response(finishReason)),
  });
  await expect(
    gateway.chat({ modelId: "gateway-query-model", messages: [{ role: "user", content: "q" }] }),
  ).resolves.toMatchObject({ finishReason });
  return log;
}

async function completedStream(buffered: boolean): Promise<Recorder> {
  const log = recorder();
  const callStream = async function* (): AsyncGenerator<GatewayStreamChunk> {
    yield { type: "delta", token: "answer" };
    yield { type: "done", response: await Promise.resolve(response("stop")) };
  };
  const adapter: ProviderAdapter = {
    call: (): Promise<NormalizedResponse> => Promise.resolve(response("stop")),
    ...(buffered ? {} : { callStream }),
  };
  const gateway = gatewayFor(log, adapter);
  const chunks: GatewayStreamChunk[] = [];
  for await (const chunk of gateway.chatStream({
    modelId: "gateway-query-model",
    messages: [{ role: "user", content: "q" }],
  }))
    chunks.push(chunk);
  expect(chunks.at(-1)).toMatchObject({ type: "done", response: { finishReason: "stop" } });
  return log;
}

async function circuitWait(
  outcome: "failed" | "cancelled" | "budget-refused" | "timer",
): Promise<Recorder> {
  const log = recorder();
  let now = 0;
  const controller = new AbortController();
  const sleepFailure = new TypeError("synthetic-clock-failure");
  const clock: Clock = {
    now: () => now,
    sleep: (delay): Promise<void> => {
      if (outcome === "failed") return Promise.reject(sleepFailure);
      if (outcome === "cancelled") controller.abort();
      now += delay;
      return Promise.resolve();
    },
  };
  const breaker = new CircuitBreaker(
    "gateway-query-model",
    {
      failureThreshold: 10,
      cooldownMs: 200,
      halfOpenProbes: 1,
    },
    clock,
    log,
  );
  breaker.assertAllowed().settle("failure", new ProviderError("synthetic-outage", 503, [], 100));
  const admitted = breaker.waitForAdmission({
    remainingMs: outcome === "budget-refused" ? 50 : 1000,
    jitterMs: 1,
    signal: controller.signal,
  });
  if (outcome === "timer") (await admitted).admission.settle("success");
  else if (outcome === "failed") await expect(admitted).rejects.toBe(sleepFailure);
  else
    await expect(admitted).rejects.toBeInstanceOf(
      outcome === "cancelled" ? CancelledError : CircuitOpenError,
    );
  return log;
}

function event(log: Recorder, op: string, field: string, value: string): ModelGatewayLogEvent {
  const found = log.events.find((entry) => entry.op === op && entry.extra?.[field] === value);
  if (found === undefined) throw new TypeError("Actual gateway event was not emitted");
  return found;
}

function expectDiagnosticDeclaration(
  entry: ModelGatewayLogEvent,
  condition: ActivityLogDiagnosticCondition,
): void {
  expect(entry).toMatchObject({ level: "info", extra: { completeness: "complete", loss: "none" } });
  expect(entry.errorKind).toBeUndefined();
  expect(activityLogEventRegistration(entry)).toMatchObject({ diagnosticWhen: [condition] });
}

describe("manual support selection of actual gateway outcomes", () => {
  let stateDir: string;
  let sink: ServerLogSink;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-support-gateway-selection-"));
    sink = createFileServerLogSink(stateDir, { level: "debug" });
  });
  afterEach(() => {
    sink.close?.();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it.each(["error", "cancelled", "length", "content_filter"] as const)(
    "declares actual buffered %s completion diagnostic without changing its result or severity",
    async (finishReason) => {
      const log = await completedChat(finishReason);
      expectDiagnosticDeclaration(
        event(log, "gateway.chat.completed", "finishReason", finishReason),
        {
          field: "finishReason",
          values: ["length", "content_filter", "error", "cancelled"],
        },
      );
    },
  );

  it.each(["error", "cancelled", "length", "content_filter"] as const)(
    "retains the actual buffered %s completion when optional context is exhausted",
    async (finishReason) => {
      const log = await completedChat(finishReason);
      for (const entry of log.events) sink.write(entry);
      sink.flush?.();
      const selected = query(stateDir).events.find(
        (entry) => entry.parsed.view.op === "gateway.chat.completed",
      );
      expect(selected).toBeDefined();
      expect(selected?.parsed.view.extra?.finishReason).toBe(finishReason);
      expect(selected?.role).toBe("closure");
    },
  );

  it.each(["stop", "tool_calls"] as const)(
    "keeps actual buffered %s success optional",
    async (finishReason) => {
      const log = await completedChat(finishReason);
      for (const entry of log.events) sink.write(entry);
      sink.flush?.();
      const result = query(stateDir);
      expect(result.events.some((entry) => entry.parsed.view.op === "gateway.chat.completed")).toBe(
        false,
      );
      expect(result.truncation.omittedContextEventCount).toBeGreaterThan(0);
      expect(result.closure?.rootCount).toBe(0);
    },
  );

  it.each(["failed", "cancelled", "budget-refused"] as const)(
    "declares actual %s admission diagnostic without inventing a request failure",
    async (outcome) => {
      const log = await circuitWait(outcome);
      expectDiagnosticDeclaration(event(log, "gateway.circuit.wait", "outcome", outcome), {
        field: "outcome",
        values: ["cancelled", "failed", "budget-refused"],
      });
    },
  );

  it.each(["failed", "cancelled", "budget-refused"] as const)(
    "retains the actual %s admission despite exhausted optional context",
    async (outcome) => {
      const log = await circuitWait(outcome);
      for (const entry of log.events) sink.write(entry);
      sink.flush?.();
      const selected = query(stateDir).events.find(
        (entry) => entry.parsed.view.op === "gateway.circuit.wait",
      );
      expect(selected).toBeDefined();
      expect(selected?.parsed.view.extra?.outcome).toBe(outcome);
      expect(selected?.role).toBe("window");
    },
  );

  it("keeps actual waiting and elapsed provider cooldown optional", async () => {
    const log = await circuitWait("timer");
    expect(
      log.events
        .filter((entry) => entry.op === "gateway.circuit.wait")
        .map((entry) => entry.extra?.outcome),
    ).toEqual(["started", "timer"]);
    for (const entry of log.events) sink.write(entry);
    sink.flush?.();
    expect(
      query(stateDir).events.some((entry) => entry.parsed.view.op === "gateway.circuit.wait"),
    ).toBe(false);
  });

  it("keeps actual successful streaming and configuration metadata optional", async () => {
    const log = await completedStream(false);
    expect(log.events.map((entry) => entry.op)).toEqual(
      expect.arrayContaining([
        "gateway.config.resolved",
        "gateway.stream.started",
        "gateway.stream.completed",
      ]),
    );
    for (const entry of log.events) sink.write(entry);
    sink.flush?.();
    const result = query(stateDir);
    expect(result.events.some((entry) => entry.parsed.view.category === "gateway")).toBe(false);
    expect(result.closure?.rootCount).toBe(0);
    expect(result.truncation.omittedContextEventCount).toBeGreaterThan(0);
  });

  it("retains actual buffered stream degradation through its existing warning", async () => {
    const log = await completedStream(true);
    expect(
      log.events.find((entry) => entry.op === "gateway.stream.buffered-fallback"),
    ).toMatchObject({ level: "warn", extra: { reason: "adapter-has-no-stream" } });
    for (const entry of log.events) sink.write(entry);
    sink.flush?.();
    expect(
      query(stateDir).events.some(
        (entry) => entry.parsed.view.op === "gateway.stream.buffered-fallback",
      ),
    ).toBe(true);
  });

  it("retains actual rejected calls but keeps their historical recovery counts optional", () => {
    const log = recorder();
    let now = 0;
    const clock: Clock = { now: () => now, sleep: () => Promise.resolve() };
    const breaker = new CircuitBreaker(
      "gateway-query-model",
      {
        failureThreshold: 1,
        cooldownMs: 200,
        halfOpenProbes: 1,
      },
      clock,
      log,
    );
    breaker.assertAllowed().settle("failure");
    for (let index = 0; index < 3; index += 1)
      expect(() => breaker.assertAllowed()).toThrow(CircuitOpenError);
    now = 201;
    const probe = breaker.assertAllowed();
    expect(() => breaker.assertAllowed()).toThrow(CircuitOpenError);
    probe.settle("success");
    expect(
      log.events.find((entry) => entry.op === "gateway.circuit.half-open")?.extra,
    ).toMatchObject({ rejectedWhileOpen: 3 });
    expect(log.events.find((entry) => entry.op === "gateway.circuit.closed")?.extra).toMatchObject({
      rejectedSincePreviousTransition: 1,
    });
    for (const entry of log.events) sink.write(entry);
    sink.flush?.();
    const selected = query(stateDir).events.map((entry) => entry.parsed.view);
    expect(
      selected
        .filter((entry) => entry.op === "gateway.circuit.rejected")
        .map((entry) => entry.level),
    ).toEqual(["warn", "debug", "debug", "warn"]);
    expect(selected.some((entry) => entry.op === "gateway.circuit.half-open")).toBe(false);
    expect(selected.some((entry) => entry.op === "gateway.circuit.closed")).toBe(false);
  });

  it("retains the actual scheduled retry through its existing severity and failure kind", async () => {
    const log = recorder();
    let attempts = 0;
    await expect(
      executeWithRetry(
        () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new TransportError("synthetic-outage"))
            : Promise.resolve("recovered");
        },
        { maxRetries: 1, retryBaseDelayMs: 1 },
        { now: () => 0, sleep: () => Promise.resolve() },
        undefined,
        () => 0,
        { sink: log, modelId: "gateway-query-model" },
      ),
    ).resolves.toBe("recovered");
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({
      op: "gateway.retry.scheduled",
      level: "warn",
      errorKind: "internal",
    });
    for (const entry of log.events) sink.write(entry);
    sink.flush?.();
    expect(
      query(stateDir).events.some((entry) => entry.parsed.view.op === "gateway.retry.scheduled"),
    ).toBe(true);
  });
});
