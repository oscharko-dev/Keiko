import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  BUILD_TIMEOUT_MS,
  QUERY_TIMEOUT_MS,
  clearUsearchAnnCacheForGroup,
  clearUsearchAnnCacheForTests,
  searchUsearchAnnIndex,
  type UsearchAnnSearchRequest,
} from "./usearch-ann-index.js";
import { USEARCH_RUNTIME_MANIFEST, usearchRuntimeTargetKey } from "./usearch-runtime-manifest.js";
import {
  USEARCH_COMMAND,
  USEARCH_CONTROL,
  USEARCH_ERROR,
  USEARCH_STATE,
  type UsearchWorkerData,
} from "./usearch-worker-protocol.js";

import type { KnowledgeLogEvent } from "../knowledge-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

interface LifetimeScope {
  readonly data: {
    readonly version: 1;
    readonly pid: number;
    readonly port: import("node:worker_threads").MessagePort;
  };
  readonly dispose: Mock<() => void>;
}

interface LifetimeWorker {
  readonly data: UsearchWorkerData;
  readonly emit: (event: string, ...args: unknown[]) => boolean;
  readonly terminate: Mock<() => Promise<number>>;
}

interface LifetimeHarness {
  mode:
    | "success"
    | "constructor-failure"
    | "early-error"
    | "early-exit"
    | "build-refusal"
    | "build-error"
    | "mixed-ready-error"
    | "build-timeout"
    | "query-failure"
    | "query-timeout";
  scopes: LifetimeScope[];
  workers: LifetimeWorker[];
  events: string[];
}

function simulatedBuildError(): number {
  if (harness.mode === "build-refusal" || harness.mode === "mixed-ready-error")
    return USEARCH_ERROR.runtimeInvalid;
  if (harness.mode === "build-error") return USEARCH_ERROR.buildFailed;
  return USEARCH_ERROR.none;
}

const harness = vi.hoisted<LifetimeHarness>(() => ({
  mode: "success",
  scopes: [],
  workers: [],
  events: [],
}));

vi.mock("@oscharko-dev/keiko-security/process-scope-worker", async () => {
  const { MessageChannel: Channel } = await import("node:worker_threads");
  return {
    createProcessScopeWorkerBridge: (): LifetimeScope => {
      const channel = new Channel();
      const scope = {
        data: { version: 1 as const, pid: 1234, port: channel.port2 },
        dispose: vi.fn(() => {
          harness.events.push("dispose");
          channel.port1.close();
          channel.port2.close();
        }),
      };
      harness.scopes.push(scope);
      return scope;
    },
  };
});

vi.mock("node:worker_threads", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...original,
    Worker: class extends EventEmitter {
      readonly data: UsearchWorkerData;
      readonly terminate = vi.fn(() => {
        harness.events.push("terminate");
        return Promise.resolve(0);
      });
      constructor(
        _url: URL,
        options: {
          readonly workerData: UsearchWorkerData;
          readonly transferList: readonly unknown[];
        },
      ) {
        super();
        if (harness.mode === "constructor-failure") throw new Error("worker construction failed");
        this.data = options.workerData;
        expect(options.transferList).toEqual([this.data.processScope?.port]);
        harness.workers.push(this);
        if (harness.mode !== "build-timeout") {
          queueMicrotask(() => {
            if (harness.mode === "early-error" || harness.mode === "early-exit") {
              this.emit(harness.mode === "early-error" ? "error" : "exit");
              return;
            }
            Atomics.store(
              new Int32Array(this.data.controlBuffer),
              USEARCH_CONTROL.state,
              harness.mode === "build-refusal" || harness.mode === "build-error"
                ? USEARCH_STATE.failed
                : USEARCH_STATE.ready,
            );
            Atomics.store(
              new Int32Array(this.data.controlBuffer),
              USEARCH_CONTROL.error,
              simulatedBuildError(),
            );
            this.emit("message", { kind: "build-complete" });
          });
        }
      }
      unref(): this {
        return this;
      }
    },
  };
});

function request(revision = "one"): UsearchAnnSearchRequest {
  const target = usearchRuntimeTargetKey(process.platform, process.arch);
  if (target === undefined) throw new Error("approved test runtime required");
  return {
    partition: {
      cacheKey: "worker-lifetime",
      cacheGroupKey: "worker-lifetime",
      revision,
      rowCount: 1,
      identity: {
        provider: "test",
        modelId: "lifetime",
        vectorDimensions: 2,
        vectorMetric: "cosine",
        normalization: "l2",
        instructionVersion: "1",
        embeddingSpaceFingerprint: "lifetime",
      },
      loadEntries: () => [{ id: "one", vector: new Float32Array([1, 0]) }],
    },
    queryVector: new Float32Array([1, 0]),
    candidateLimit: 1,
    exactScanThreshold: 0,
    binaryPath: resolve(".usearch", USEARCH_RUNTIME_MANIFEST.version, target, "usearch.node"),
  };
}

function answerQuery(view: Int32Array, index: number): number {
  const owned = harness.workers.find((worker) => worker.data.controlBuffer === view.buffer);
  if (
    owned === undefined ||
    index !== USEARCH_CONTROL.command ||
    Atomics.load(view, index) !== USEARCH_COMMAND.search
  )
    return 0;
  if (harness.mode === "query-timeout") return 0;
  Atomics.store(view, USEARCH_CONTROL.resultCount, harness.mode === "query-failure" ? -1 : 1);
  const sequence = Atomics.load(view, USEARCH_CONTROL.requestSequence);
  queueMicrotask(() => owned.emit("message", { kind: "search-complete", sequence }));
  return 1;
}

beforeEach(() => {
  harness.mode = "success";
  harness.events = [];
  harness.scopes = [];
  harness.workers = [];
  vi.spyOn(Atomics, "notify").mockImplementation(
    (view: Int32Array | BigInt64Array, index: number): number =>
      view instanceof Int32Array ? answerQuery(view, index) : 0,
  );
});

afterEach(() => {
  clearUsearchAnnCacheForTests();
  for (const scope of harness.scopes) scope.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function expectRetired(): void {
  expect(harness.scopes[0]?.dispose).toHaveBeenCalled();
  expect(harness.events.indexOf("dispose")).toBeLessThan(harness.events.indexOf("terminate"));
}

describe("ANN Worker private observation lifetime", () => {
  it.each([
    { mode: "success", workerState: "ready", resolutionState: "resolved" },
    { mode: "build-refusal", workerState: "runtime-invalid", resolutionState: "invalid" },
    { mode: "early-error", workerState: "unavailable", resolutionState: "unavailable" },
    { mode: "early-exit", workerState: "unavailable", resolutionState: "unavailable" },
    { mode: "build-error", workerState: "build-failed", resolutionState: "unavailable" },
    { mode: "build-timeout", workerState: "unavailable", resolutionState: "unavailable" },
  ] as const)(
    "records the final $workerState without runtime paths or content",
    async ({ mode, workerState, resolutionState }) => {
      vi.useFakeTimers();
      harness.mode = mode;
      const events: KnowledgeLogEvent[] = [];
      const input = request();
      const result = searchUsearchAnnIndex({
        ...input,
        logSink: {
          write: (event): void => {
            events.push(event);
          },
        },
      });
      await vi.advanceTimersByTimeAsync(BUILD_TIMEOUT_MS);
      await result;
      const settled = events.filter((event) => event.extra?.workerState !== undefined);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        op: "search.native-runtime-resolved",
        extra: { workerState, resolutionState },
      });
      expect(JSON.stringify(settled)).not.toContain(input.binaryPath);
      const proof = expectActivityLogProof(
        "search.native-runtime-resolved.worker",
        formatActivityLogProofLine(settled[0] ?? {}),
      );
      expect(proof).toMatchObject({ workerState, resolutionState });
    },
  );

  it("revokes the private authority when construction fails", async () => {
    harness.mode = "constructor-failure";
    const events: KnowledgeLogEvent[] = [];
    await expect(
      searchUsearchAnnIndex({
        ...request(),
        logSink: {
          write: (event): void => {
            events.push(event);
          },
        },
      }),
    ).rejects.toThrow("worker construction failed");
    expect(events.filter((event) => event.extra?.workerState !== undefined)).toMatchObject([
      { extra: { workerState: "unavailable", resolutionState: "unavailable" } },
    ]);
    expect(harness.scopes[0]?.dispose).toHaveBeenCalledOnce();
    expect(harness.workers).toHaveLength(0);
  });

  it.each([
    { mode: "mixed-ready-error", reason: "index-build-failed", deadlineMs: 0 },
    { mode: "build-refusal", reason: "index-build-failed", deadlineMs: 0 },
    { mode: "query-failure", reason: "index-query-failed", deadlineMs: 0 },
    { mode: "build-timeout", reason: "index-build-failed", deadlineMs: BUILD_TIMEOUT_MS },
    { mode: "query-timeout", reason: "index-query-failed", deadlineMs: QUERY_TIMEOUT_MS },
  ] as const)("revokes before retiring a $mode Worker", async ({ mode, reason, deadlineMs }) => {
    if (deadlineMs > 0) vi.useFakeTimers();
    harness.mode = mode;
    const result = searchUsearchAnnIndex(request());
    if (deadlineMs > 0) await vi.advanceTimersByTimeAsync(deadlineMs);
    expect(await result).toEqual({ ok: false, reason });
    expectRetired();
  });

  it.each(["reset", "group", "revision"] as const)(
    "revokes a cached Worker on %s eviction",
    async (kind) => {
      expect(await searchUsearchAnnIndex(request())).toMatchObject({ ok: true, mode: "ann" });
      expect(harness.scopes[0]?.dispose).not.toHaveBeenCalled();
      if (kind === "reset") clearUsearchAnnCacheForTests();
      else if (kind === "group") clearUsearchAnnCacheForGroup("worker-lifetime");
      else await searchUsearchAnnIndex(request("two"));
      expectRetired();
    },
  );

  it.each(["error", "exit"] as const)("revokes when the Worker emits %s", async (event) => {
    await searchUsearchAnnIndex(request());
    harness.workers[0]?.emit(event);
    expect(harness.scopes[0]?.dispose).toHaveBeenCalled();
    expect(await searchUsearchAnnIndex(request())).toEqual({
      ok: false,
      reason: "index-query-failed",
    });
  });
});
