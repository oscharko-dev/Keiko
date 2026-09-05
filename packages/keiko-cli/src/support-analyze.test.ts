import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PathDeniedError } from "@oscharko-dev/keiko-workspace";
import {
  causeChain as productionCauseChain,
  createFileServerLogSink,
  keikoStackFrames,
  type ServerLogCategory,
  type ServerLogSink,
} from "@oscharko-dev/keiko-server";
import { redactLogFields } from "@oscharko-dev/keiko-server/runtime/tool-catalog-lifecycle";

import {
  analyzeLogText,
  buildGatewayReplayScript,
  buildReproductionSeed,
  detectSourceKind,
  findTimeline,
  hasIssueToPrJourneyOps,
  renderGatewayReplayScriptFixture,
  renderHumanAllTimelines,
  renderHumanClusters,
  renderHumanReproductionSeed,
  renderHumanTimeline,
  type GatewayReplayScript,
  type IssueToPrJourneyView,
  type LogTimeline,
  type OpCluster,
  type ReproductionSeed,
  type ServerLogLineView,
} from "./support-analyze.js";

function line(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

// ─── Driving the timeline contract from the production emitters, not from hand-written JSON ───────
//
// A support timeline is the ONLY artifact an agent has when a customer's managed root is denied or
// a live workspace watch is revoked, so this file must prove the analyzer carries what the REAL
// emitters write — not what a fixture author guessed they write (AGENTS.md §7: a fixture derives
// its expectation from the production entry point).
//
// Three production seams are reused directly below: `createFileServerLogSink` (the activity log's
// own writer, including its redaction and its hoisting of `extra` onto the line), `keikoStackFrames`
// / `causeChain` (the exact evidence helpers `recordWorkspaceRootDenial` calls), and the real
// `PathDeniedError`, whose `code` IS the `errorKind` the emitter writes.
//
// The emitter FUNCTIONS themselves (`recordWorkspaceRootDenial` in
// `keiko-server/src/workspace-root-denial-log.ts`, `recordWatchAuthorityRevoked` in
// `keiko-server/src/editor/watch/workspaceWatchRoutes.ts`) are module-private and are not part of
// `@oscharko-dev/keiko-server`'s single entry point; booting the BFF here to drive them would
// duplicate keiko-server's own route tests instead of reusing them (AGENTS.md §5). The generated op
// catalog is the seam that keeps the remaining inputs honest: it is produced by scanning every
// production `op:` call site and pinned against them by `npm run check:op-catalog`, so an op that is
// renamed, recategorised or deleted in production moves this file's INPUTS — the test cannot keep
// asserting against an op the product no longer emits.
const OP_CATALOG_PATH = fileURLToPath(
  new URL("../../../docs/observability/op-catalog.generated.json", import.meta.url),
);

interface OpCatalogDocument {
  readonly entries?: readonly { readonly op: string; readonly category: string }[];
}

const OP_CATALOG = JSON.parse(readFileSync(OP_CATALOG_PATH, "utf8")) as OpCatalogDocument;

// `ServerLogCategory` is a compile-time union, so the catalog's string is narrowed through an
// explicit table rather than a cast: a production op that moves to a category this file does not
// model fails loudly here instead of silently logging under the wrong one.
const MODELLED_LOG_CATEGORIES: Readonly<Record<string, ServerLogCategory>> = {
  diagnostic: "diagnostic",
  search: "search",
  security: "security",
};

function productionLogCategory(op: string): ServerLogCategory {
  const entry = OP_CATALOG.entries?.find((candidate) => candidate.op === op);
  if (entry === undefined) {
    throw new Error(`op-catalog registers no production emitter for op "${op}"`);
  }
  const category = MODELLED_LOG_CATEGORIES[entry.category];
  if (category === undefined) {
    throw new Error(`op "${op}" is emitted under unmodelled category "${entry.category}"`);
  }
  return category;
}

// Writes through the real file sink and returns what actually landed in `<stateDir>/logs/server.log`
// — the same bytes `keiko support analyze` is handed — so redaction, field hoisting and the v2
// envelope are all exercised rather than assumed.
function serializedActivityLog(prefix: string, write: (sink: ServerLogSink) => void): string {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  const sink = createFileServerLogSink(stateDir, { level: "debug" });
  try {
    write(sink);
    sink.close?.();
    return readFileSync(join(stateDir, "logs", "server.log"), "utf8");
  } finally {
    sink.close?.();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const CONNECTED_CONTEXT_STARTED = "search.connected-context.started";
const CONNECTED_CONTEXT_COMPLETED = "search.connected-context.completed";
const WORKSPACE_ROOT_DENIED = "workspace.root.denied";
const WATCH_AUTHORITY_REVOKED = "editor.workspace-watch.authority-revoked";

const T0 = "2026-08-21T00:00:00.000Z";
const T1 = "2026-08-21T00:00:01.000Z";
const T2 = "2026-08-21T00:00:02.000Z";
const T3 = "2026-08-21T00:00:03.000Z";

describe("detectSourceKind", () => {
  it("recognises a bundle's manifest first line", () => {
    expect(detectSourceKind(line({ $section: "manifest", schemaVersion: 2 }))).toBe("bundle");
  });

  it("treats a raw log's first line (ts+category+op, no $section) as raw-log", () => {
    expect(detectSourceKind(line({ ts: T0, category: "http", op: "a" }))).toBe("raw-log");
  });

  it("falls back to raw-log for an empty file or unparsable first line", () => {
    expect(detectSourceKind(undefined)).toBe("raw-log");
    expect(detectSourceKind("not json at all")).toBe("raw-log");
  });
});

// Interleaved-pid ordering fixture (spec: "analyzer ordering with interleaved pids"):
//   file order: L4 (pre-v2, no pid/instanceId/seq) < L2 (pid 1111, seq 1) < L1 (pid 1111, seq 2)
//               < L3 (pid 2222, seq 1)
// Expected reconstruction order: L4 (a pre-v2 line ranks by its own file position), then the
// lifetime pid 1111 (first seen at L2) with L2 before L1 by seq, then the lifetime pid 2222 (first
// seen later, at L3).
const L4_PRE_V2 = line({ ts: T0, category: "job", op: "job.spawned", correlationId: "req-1" });
const L2 = line({
  ts: T1,
  category: "http",
  op: "op.a",
  correlationId: "req-1",
  pid: 1111,
  instanceId: "aaaaaaaa",
  seq: 1,
});
const L1 = line({
  ts: T2,
  category: "http",
  op: "op.b",
  correlationId: "req-1",
  pid: 1111,
  instanceId: "aaaaaaaa",
  seq: 2,
  errorKind: "GATEWAY_TIMEOUT",
});
const L3 = line({
  ts: T3,
  category: "http",
  op: "op.c",
  correlationId: "req-1",
  pid: 2222,
  instanceId: "bbbbbbbb",
  seq: 1,
  errorKind: "GATEWAY_5XX",
});
const OTHER_CORRELATION = line({
  ts: "2026-08-21T00:00:04.000Z",
  category: "http",
  op: "op.d",
  correlationId: "req-2",
  pid: 3333,
  instanceId: "cccccccc",
  seq: 1,
});
const NO_CORRELATION_ID = line({
  ts: "2026-08-21T00:00:05.000Z",
  category: "process",
  op: "process.started",
});
const MISSING_CATEGORY = JSON.stringify({ ts: "2026-08-21T00:00:06.000Z", op: "x" });
const GARBAGE = "not-json-at-all{{{";

const FIXTURE_TEXT =
  [L4_PRE_V2, L2, L1, L3, OTHER_CORRELATION, NO_CORRELATION_ID, MISSING_CATEGORY, GARBAGE].join(
    "\n",
  ) + "\n";

describe("analyzeLogText — raw log", () => {
  const result = analyzeLogText(FIXTURE_TEXT);

  it("reconstructs a serialized task-workspace lifecycle failure with correlation and taxonomy", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-support-task-workspace-"));
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    const correlationId = "0123456789abcdef0123456789abcdef";
    try {
      sink.write({
        level: "warn",
        category: "diagnostic",
        op: "task-workspace.lifecycle",
        correlationId,
        errorKind: "LOCK_CONTENTION",
        durationMs: 17,
        extra: {
          operation: "provision",
          outcome: "blocked",
          attempt: 2,
          worktreeCount: 1,
        },
      });
      sink.close?.();

      const serialized = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
      const timeline = findTimeline(analyzeLogText(serialized), correlationId);
      expect(timeline?.correlationId).toBe(correlationId);
      expect(timeline?.errorKinds).toEqual(["LOCK_CONTENTION"]);
      expect(timeline?.lines[0]).toMatchObject({
        category: "diagnostic",
        op: "task-workspace.lifecycle",
        errorKind: "LOCK_CONTENTION",
        extra: { operation: "provision", outcome: "blocked", attempt: 2, worktreeCount: 1 },
      });
    } finally {
      sink.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reconstructs connected-context work diagnostics on one support timeline", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-support-connected-context-"));
    const sink = createFileServerLogSink(stateDir, { level: "debug" });
    const correlationId = "connected-context-support-timeline-0001";
    const scopeIdentitySha256 = "a".repeat(64);
    const queryIdentitySha256 = "b".repeat(64);
    const requestShape = {
      queryKind: "natural-language",
      queryIdentitySha256,
      caseSensitive: false,
      maxResults: 20,
      searchCallsMax: 16,
      filesReadMax: 32,
      excerptBytesMax: 131_072,
      modelInputTokensMax: 116_000,
      modelOutputTokensMax: 4_096,
      elapsedMsMax: 30_000,
      rerankCallsMax: 1,
    } as const;
    const coverageCounters = {
      coverageFilesDiscovered: 120,
      coverageFilesScanned: 80,
      coverageFilesSkipped: 40,
      coverageDepthPruned: 6,
      coverageMaxFilesPruned: 34,
    } as const;
    const structuralCounters = {
      contextCount: 3,
      candidateInventoryBuildCount: 3,
      candidateFileCount: 120,
      candidateDirectoryCount: 42,
      codeIndexBuildCount: 1,
      symbolGraphBuildCount: 1,
      importGraphBuildCount: 1,
      endpointGraphBuildCount: 1,
      fileSearchCount: 8,
      textSearchCount: 4,
    } as const;
    const workspaceIndexCounters = {
      providerStatus: "available",
      searchMode: "persistent-warm",
      loadStatus: "hit",
      saveStatus: "not-attempted",
      searchCount: 4,
      reportCount: 4,
      fallbackSearchCount: 0,
      discoveredEntries: 480,
      retainedEntries: 480,
      indexedRecords: 480,
      reusedRecords: 480,
      staleRecords: 0,
      skippedEntries: 0,
      deletedEntries: 0,
      droppedRecords: 0,
      loadAttempts: 3,
      loadHits: 3,
      loadMisses: 0,
      loadFailures: 0,
      saveAttempts: 0,
      saveSuccesses: 0,
      saveFailures: 0,
    } as const;
    const workspaceIoCounters = {
      readDirCalls: 18,
      readDirEntries: 240,
      statCalls: 96,
      realPathCalls: 82,
      existsCalls: 4,
      contentReadCalls: 64,
      contentReadBytes: 98_304,
    } as const;
    try {
      sink.write({
        category: productionLogCategory(CONNECTED_CONTEXT_STARTED),
        op: CONNECTED_CONTEXT_STARTED,
        correlationId,
        extra: {
          scopeKind: "directory",
          relativePathCount: 1,
          explicitConnection: true,
          scopeIdentitySha256,
          ...requestShape,
        },
      });
      sink.write({
        category: productionLogCategory(CONNECTED_CONTEXT_COMPLETED),
        op: CONNECTED_CONTEXT_COMPLETED,
        correlationId,
        durationMs: 17,
        extra: {
          activityDetailStatus: "complete",
          scopeKind: "directory",
          relativePathCount: 1,
          explicitConnection: true,
          scopeIdentitySha256,
          ...requestShape,
          plannedRingCount: 2,
          usage: {
            searchCalls: 12,
            filesRead: 16,
            excerptBytes: 8_192,
            modelInputTokens: 0,
            modelOutputTokens: 0,
            elapsedMs: 17,
            rerankCalls: 0,
          },
          selectionCounts: { selectedFileCount: 16, omittedCount: 4 },
          structural: structuralCounters,
          workspaceIndex: workspaceIndexCounters,
          workspaceIo: workspaceIoCounters,
          coverage: {
            coverageStatus: "incomplete",
            coverageReasons: ["file-cap"],
            ...coverageCounters,
          },
          uncertainty: {
            count: 3,
            noEvidenceUncertaintyCount: 0,
            staleEvidenceUncertaintyCount: 0,
            scopeIncompleteUncertaintyCount: 2,
            budgetClippedUncertaintyCount: 0,
            toolUnavailableUncertaintyCount: 1,
            lowConfidenceUncertaintyCount: 0,
            unsupportedCitationUncertaintyCount: 0,
            incompleteAnswerUncertaintyCount: 0,
            unsupportedClaimUncertaintyCount: 0,
            entailmentUnavailableUncertaintyCount: 0,
          },
          retrievalStatus: {
            readBudgetBlocked: false,
            elapsedBudgetBlocked: false,
            workspaceIndexProviderStatus: "available",
          },
        },
      });
      sink.close?.();

      const serialized = readFileSync(join(stateDir, "logs", "server.log"), "utf8");
      const timeline = findTimeline(analyzeLogText(serialized), correlationId);
      expect(timeline?.lines.map((entry) => entry.op)).toEqual([
        CONNECTED_CONTEXT_STARTED,
        CONNECTED_CONTEXT_COMPLETED,
      ]);
      expect(timeline?.lines.map((entry) => entry.category)).toEqual([
        productionLogCategory(CONNECTED_CONTEXT_STARTED),
        productionLogCategory(CONNECTED_CONTEXT_COMPLETED),
      ]);
      expect(timeline?.lines[0]?.extra).toMatchObject({
        explicitConnection: true,
        scopeIdentitySha256,
        ...requestShape,
      });
      expect(timeline?.lines[1]?.extra).toMatchObject({
        activityDetailStatus: "complete",
        explicitConnection: true,
        scopeIdentitySha256,
        ...requestShape,
        plannedRingCount: 2,
        selectionCounts: { selectedFileCount: 16, omittedCount: 4 },
        structural: structuralCounters,
        workspaceIndex: workspaceIndexCounters,
        workspaceIo: workspaceIoCounters,
        coverage: {
          coverageStatus: "incomplete",
          coverageReasons: ["file-cap"],
          ...coverageCounters,
        },
        uncertainty: {
          scopeIncompleteUncertaintyCount: 2,
          toolUnavailableUncertaintyCount: 1,
        },
      });
    } finally {
      sink.close?.();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("ranks process lifetimes by first appearance and orders each lifetime by seq; a pre-v2 line ranks by its own file position", () => {
    const req1 = result.timelines.find((t) => t.correlationId === "req-1");
    expect(req1?.lines.map((l) => l.op)).toEqual(["job.spawned", "op.a", "op.b", "op.c"]);
  });

  it("ranks a lifetime that started later AFTER an earlier one even when its pid is numerically smaller", () => {
    // The OS hands out pids in no order an agent may rely on; the file records which lifetime
    // wrote first. Numeric pid order would put pid 100 ahead of pid 900 here, inverting history.
    const first = line({
      ts: T0,
      category: "http",
      op: "first.a",
      correlationId: "r",
      pid: 900,
      instanceId: "e1e1e1e1",
      seq: 1,
    });
    const second = line({
      ts: T1,
      category: "http",
      op: "second.a",
      correlationId: "r",
      pid: 100,
      instanceId: "f2f2f2f2",
      seq: 1,
    });
    const firstAgain = line({
      ts: T2,
      category: "http",
      op: "first.b",
      correlationId: "r",
      pid: 900,
      instanceId: "e1e1e1e1",
      seq: 2,
    });
    const timeline = analyzeLogText([first, second, firstAgain].join("\n") + "\n").timelines[0];
    expect(timeline?.lines.map((l) => l.op)).toEqual(["first.a", "first.b", "second.a"]);
  });

  it("stays a total order when a pre-v2 line sits between two v2 lines of one lifetime", () => {
    // A per-pair rule switch (identity for v2/v2, file order otherwise) is not transitive: v2#2 <
    // pre-v2 < v2#1 by file order while v2#1 < v2#2 by seq, which hands `sort` a cycle and an
    // engine-dependent result. One rank per lifetime makes the outcome deterministic.
    const later = line({
      ts: T0,
      category: "http",
      op: "v2.second",
      correlationId: "r",
      pid: 1,
      instanceId: "a1a1a1a1",
      seq: 2,
    });
    const preV2 = line({ ts: T1, category: "http", op: "pre-v2", correlationId: "r" });
    const earlier = line({
      ts: T2,
      category: "http",
      op: "v2.first",
      correlationId: "r",
      pid: 1,
      instanceId: "a1a1a1a1",
      seq: 1,
    });
    const timeline = analyzeLogText([later, preV2, earlier].join("\n") + "\n").timelines[0];
    expect(timeline?.lines.map((l) => l.op)).toEqual(["v2.first", "v2.second", "pre-v2"]);
  });

  it("counts malformed lines (invalid JSON and JSON missing ts/category/op) without silently skipping them", () => {
    expect(result.malformedLineCount).toBe(2);
  });

  it("groups by correlationId, in first-occurrence order, excluding lines with no correlationId", () => {
    expect(result.timelines.map((t) => t.correlationId)).toEqual(["req-1", "req-2"]);
  });

  it("computes firstTs/lastTs/durationMs across the whole group", () => {
    const req1 = result.timelines.find((t) => t.correlationId === "req-1");
    expect(req1?.firstTs).toBe(T0);
    expect(req1?.lastTs).toBe(T3);
    expect(req1?.durationMs).toBe(3000);
  });

  it("collects distinct errorKinds in (post-sort) first-occurrence order", () => {
    const req1 = result.timelines.find((t) => t.correlationId === "req-1");
    expect(req1?.errorKinds).toEqual(["GATEWAY_TIMEOUT", "GATEWAY_5XX"]);
  });

  it("omits frames entirely (never an empty array) when no line in the timeline carried any", () => {
    const req1 = result.timelines.find((t) => t.correlationId === "req-1");
    expect(req1?.frames).toBeUndefined();
  });
});

// The two workspace-authority security ops #3347 introduced. Each is the LAST evidence a support
// bundle carries when authority is withdrawn mid-operation — a denied managed root, a live watch
// revoked out from under a streaming client — so each must survive the round trip through
// `keiko support analyze` with its correlation, its error kind and its body-free evidence intact.
// A field the analyzer drops here is a defect an agent can no longer reconstruct at all.
describe("support timeline contract — the #3347 workspace-authority security ops", () => {
  const CORRELATION_ID = "33470000abcdef000000000000000001";

  // The denial evidence, built the way `recordWorkspaceRootDenial` builds it: a real
  // `PathDeniedError` (whose `code` IS the emitted `errorKind`) reduced through the production
  // `keikoStackFrames`/`causeChain` helpers. Nothing here restates a shape this test owns.
  function denialEvidence(): {
    readonly error: PathDeniedError;
    readonly frames: readonly string[];
    readonly causes: readonly string[];
  } {
    const error = new PathDeniedError("workspace root denied", "<requested-root>");
    // A denial raised while re-proving a managed root wraps the failure that caused it, which is
    // what gives `causeChain` a non-empty reduction — the emitter spreads the chain in only when it
    // has one, so a cause-less fixture would exercise the empty branch and prove nothing here.
    error.cause = new TypeError("realpath rejected the locus");
    return { error, frames: keikoStackFrames(error), causes: productionCauseChain(error) };
  }

  it("carries the denial's production error code, stack frames and cause chain onto the timeline", () => {
    const { error, frames, causes } = denialEvidence();
    // Fail closed rather than assert vacuously: with no frames or no cause classes the two
    // `toEqual`s below would pass against empty arrays and prove nothing.
    expect(frames.length).toBeGreaterThan(0);
    expect(causes.length).toBeGreaterThan(0);

    const serialized = serializedActivityLog("keiko-support-root-denied-", (sink) => {
      sink.write({
        level: "warn",
        category: productionLogCategory(WORKSPACE_ROOT_DENIED),
        op: WORKSPACE_ROOT_DENIED,
        correlationId: CORRELATION_ID,
        errorKind: error.code,
        extra: { decision: "denied", reason: "denied-locus", frames, causeChain: causes },
      });
    });

    const timeline = findTimeline(analyzeLogText(serialized), CORRELATION_ID);
    expect(timeline?.lines[0]).toMatchObject({
      category: "security",
      op: WORKSPACE_ROOT_DENIED,
      errorKind: error.code,
      extra: { decision: "denied", reason: "denied-locus" },
    });
    // `frames`/`causeChain` are written INSIDE `extra` by the emitter and hoisted onto the line by
    // the sink's own formatter — which is the only reason `keiko support analyze --seed` finds them
    // as typed evidence instead of leaving them buried in `extra`.
    expect(timeline?.lines[0]?.frames).toEqual(frames);
    expect(timeline?.lines[0]?.causeChain).toEqual(causes);
    expect(timeline?.errorKinds).toEqual([error.code]);
  });

  it("reconstructs a denial and a revoked watch that share one correlation as ONE timeline", () => {
    const { error, frames } = denialEvidence();
    const serialized = serializedActivityLog("keiko-support-authority-", (sink) => {
      sink.write({
        level: "warn",
        category: productionLogCategory(WORKSPACE_ROOT_DENIED),
        op: WORKSPACE_ROOT_DENIED,
        correlationId: CORRELATION_ID,
        errorKind: error.code,
        extra: { decision: "denied", reason: "managed-root-resolution-failed", frames },
      });
      sink.write({
        level: "warn",
        category: productionLogCategory(WATCH_AUTHORITY_REVOKED),
        op: WATCH_AUTHORITY_REVOKED,
        correlationId: CORRELATION_ID,
        errorKind: "WATCH_AUTHORITY_REVOKED",
        extra: { decision: "revoked", rootToken: "a".repeat(24) },
      });
    });

    const timeline = findTimeline(analyzeLogText(serialized), CORRELATION_ID);
    expect(timeline?.lines.map((entry) => entry.op)).toEqual([
      WORKSPACE_ROOT_DENIED,
      WATCH_AUTHORITY_REVOKED,
    ]);
    expect(timeline?.lines.map((entry) => entry.category)).toEqual(["security", "security"]);
    expect(timeline?.errorKinds).toEqual([error.code, "WATCH_AUTHORITY_REVOKED"]);
    expect(timeline?.lines[1]?.extra).toEqual({ decision: "revoked", rootToken: "a".repeat(24) });
    // The revocation carries no path, no endpoint and no client identity — only a decision and the
    // body-free root token the watch session is joined on.
    expect(JSON.stringify(timeline?.lines[1]?.extra)).not.toContain("/");
  });

  it("turns the denial into a reproduction seed whose stack frames are the emitter's own", () => {
    const { error, frames, causes } = denialEvidence();
    const serialized = serializedActivityLog("keiko-support-denial-seed-", (sink) => {
      sink.write({
        level: "warn",
        category: productionLogCategory(WORKSPACE_ROOT_DENIED),
        op: WORKSPACE_ROOT_DENIED,
        correlationId: CORRELATION_ID,
        errorKind: error.code,
        extra: { decision: "denied", reason: "denied-locus", frames, causeChain: causes },
      });
    });

    const seed = buildReproductionSeed(serialized, CORRELATION_ID, new Date(T1));

    expect(seed?.stackFrames).toEqual(frames);
    expect(seed?.causeChain).toEqual(causes);
  });

  it("drops the operation from every timeline when an emitter writes no correlationId at all", () => {
    // The sanctioned fallback is `UNKNOWN_CORRELATION_ID`, never an absent field: an emitter that
    // omits the id entirely loses its own timeline, and this pin makes that cost visible instead of
    // letting a future emitter discover it in production. The line is still ACCOUNTED for — it is
    // neither malformed nor silently discarded — so a cluster read still surfaces the op.
    const serialized = serializedActivityLog("keiko-support-no-correlation-", (sink) => {
      sink.write({
        level: "warn",
        category: productionLogCategory(WATCH_AUTHORITY_REVOKED),
        op: WATCH_AUTHORITY_REVOKED,
        errorKind: "WATCH_AUTHORITY_REVOKED",
        extra: { decision: "revoked", rootToken: "b".repeat(24) },
      });
    });

    const result = analyzeLogText(serialized);

    expect(result.timelines).toEqual([]);
    expect(result.malformedLineCount).toBe(0);
    expect(result.clusters.map((cluster) => cluster.op)).toEqual([WATCH_AUTHORITY_REVOKED]);
  });

  it("fails closed when an op this contract covers is no longer emitted anywhere in production", () => {
    // The catalog is generated from the real `op:` call sites, so a rename or a deletion moves this
    // file's inputs rather than leaving it asserting against an op the product stopped emitting.
    for (const op of [WORKSPACE_ROOT_DENIED, WATCH_AUTHORITY_REVOKED]) {
      expect(productionLogCategory(op)).toBe("security");
    }
    expect(() => productionLogCategory("workspace.root.denied.removed")).toThrow(
      /registers no production emitter/,
    );
  });
});

describe("analyzeLogText — Wave 6: LogTimeline.frames union", () => {
  it("unions every line's frames[] across a timeline, in first-occurrence order, deduplicated", () => {
    const first = line({
      ts: T0,
      category: "gateway",
      op: "gateway.chat.failed",
      correlationId: "req-frames",
      frames: ["packages/keiko-server/dist/a.js:1:1", "packages/keiko-server/dist/b.js:2:2"],
    });
    const second = line({
      ts: T1,
      category: "gateway",
      op: "gateway.retry.exhausted",
      correlationId: "req-frames",
      frames: ["packages/keiko-server/dist/b.js:2:2", "packages/keiko-server/dist/c.js:3:3"],
    });

    const result = analyzeLogText(`${first}\n${second}\n`);

    expect(findTimeline(result, "req-frames")?.frames).toEqual([
      "packages/keiko-server/dist/a.js:1:1",
      "packages/keiko-server/dist/b.js:2:2",
      "packages/keiko-server/dist/c.js:3:3",
    ]);
  });
});

describe("analyzeLogText — Wave 6: clusters", () => {
  it("groups every parsed line by (category, op, errorKind) regardless of correlationId", () => {
    const a = line({
      ts: T0,
      category: "gateway",
      op: "gateway.retry.scheduled",
      correlationId: "req-a",
      errorKind: "GATEWAY_RATE_LIMIT",
    });
    const b = line({
      ts: T1,
      category: "gateway",
      op: "gateway.retry.scheduled",
      correlationId: "req-b",
      errorKind: "GATEWAY_RATE_LIMIT",
    });
    const c = line({ ts: T2, category: "http", op: "request", correlationId: "req-a" });

    const result = analyzeLogText(`${a}\n${b}\n${c}\n`);

    expect(result.clusters).toEqual([
      {
        category: "gateway",
        op: "gateway.retry.scheduled",
        errorKind: "GATEWAY_RATE_LIMIT",
        count: 2,
        sampleCorrelationIds: ["req-a", "req-b"],
      },
      {
        category: "http",
        op: "request",
        errorKind: null,
        count: 1,
        sampleCorrelationIds: ["req-a"],
      },
    ]);
  });

  it("reports an empty clusters array, not an omitted field, when there are no parsed lines", () => {
    expect(analyzeLogText("").clusters).toEqual([]);
  });
});

describe("analyzeLogText — bundle auto-detect", () => {
  it("skips the manifest line without counting it as malformed, and analyzes the rest identically", () => {
    const manifestLine = line({ $section: "manifest", schemaVersion: 2 });
    const bundleText = `${manifestLine}\n${FIXTURE_TEXT}`;

    const result = analyzeLogText(bundleText);

    expect(result.malformedLineCount).toBe(2);
    expect(result.timelines.map((t) => t.correlationId)).toEqual(["req-1", "req-2"]);
  });
});

describe("analyzeLogText — extra fields and frames", () => {
  it("buckets unknown top-level keys under extra, and passes a frames array through typed", () => {
    const withExtras = line({
      ts: T0,
      category: "client",
      op: "client.diagnostic",
      correlationId: "req-extra",
      clientNote: "connection dropped",
      frames: ["packages/keiko-server/dist/observability/server-log.js:128:18"],
    });

    const result = analyzeLogText(`${withExtras}\n`);

    const timeline = findTimeline(result, "req-extra");
    expect(timeline?.lines[0]?.extra).toEqual({ clientNote: "connection dropped" });
    expect(timeline?.lines[0]?.frames).toEqual([
      "packages/keiko-server/dist/observability/server-log.js:128:18",
    ]);
  });

  it("omits extra entirely when no unknown key survives (never emits an empty object)", () => {
    const plain = line({ ts: T0, category: "http", op: "a", correlationId: "req-plain" });

    const result = analyzeLogText(`${plain}\n`);

    expect(findTimeline(result, "req-plain")?.lines[0]?.extra).toBeUndefined();
  });

  // Regression: `JSON.parse` defines a `"__proto__"` key as an ordinary OWN property (via
  // `[[DefineOwnProperty]]`), never as a prototype link — but assigning that key onto a plain
  // `{}` accumulator via `extra[key] = value` invokes `Object.prototype`'s inherited `__proto__`
  // setter instead of defining an own property. Before the fix, the setter silently replaces
  // `extra`'s own prototype (for an object value) instead of recording the field, so
  // `JSON.stringify(extra)` comes back `"{}"` even though a hostile line's `__proto__` key was
  // present — the exact silent skip this module must never perform. Constructed as a raw JSON
  // string (not an object literal): `{ __proto__: {...} }` as literal syntax sets the new
  // object's prototype directly and would never reach this code path at all.
  it("keeps a __proto__ key from a log line as its own field under extra, not as a prototype change", () => {
    const raw = `{"ts":"${T0}","category":"http","op":"a","correlationId":"req-evil","__proto__":{"polluted":true}}`;

    const result = analyzeLogText(`${raw}\n`);

    const extra = findTimeline(result, "req-evil")?.lines[0]?.extra;
    expect(extra).toBeDefined();
    expect(JSON.stringify(extra)).toBe('{"__proto__":{"polluted":true}}');
  });
});

const PROC_STARTED = line({
  ts: T0,
  category: "process",
  op: "process.started",
  pid: 4242,
  instanceId: "dddddddd",
  seq: 1,
  nodeVersion: "v24.18.0",
  port: 1983,
});
const PROC_HEARTBEAT = line({
  ts: T1,
  category: "process",
  op: "process.heartbeat",
  pid: 4242,
  instanceId: "dddddddd",
  seq: 2,
});
const PROC_EXITING = line({
  ts: T2,
  category: "process",
  op: "process.exiting",
  pid: 4242,
  instanceId: "dddddddd",
  seq: 3,
  reason: "SIGTERM",
});

describe("analyzeLogText — process lifetimes", () => {
  it("summarises a process lifetime across lifecycle lines that carry no correlationId", () => {
    const text = `${[PROC_STARTED, PROC_HEARTBEAT, PROC_EXITING].join("\n")}\n`;

    const result = analyzeLogText(text);

    expect(result.processes).toHaveLength(1);
    const summary = result.processes[0];
    expect(summary?.pid).toBe(4242);
    expect(summary?.instanceId).toBe("dddddddd");
    expect(summary?.firstSeq).toBe(1);
    expect(summary?.lastSeq).toBe(3);
    expect(summary?.lineCount).toBe(3);
    expect(summary?.firstTs).toBe(T0);
    expect(summary?.lastTs).toBe(T2);
    expect(summary?.started).toEqual({ nodeVersion: "v24.18.0", port: 1983 });
    expect(summary?.exitReason).toBe("SIGTERM");
  });

  it("ranks processes by first file appearance, the same rule timelines use", () => {
    const writtenFirst = line({
      ts: T0,
      category: "process",
      op: "process.started",
      pid: 900,
      instanceId: "e1e1e1e1",
      seq: 1,
    });
    const writtenSecond = line({
      ts: T1,
      category: "process",
      op: "process.started",
      pid: 100,
      instanceId: "f2f2f2f2",
      seq: 1,
    });
    // Written in this order — the numerically smaller pid must NOT jump ahead of it.
    const result = analyzeLogText(`${writtenFirst}\n${writtenSecond}\n`);

    expect(result.processes.map((p) => p.pid)).toEqual([900, 100]);
  });

  it("never summarises a lifecycle line missing the full v2 identity triple", () => {
    const result = analyzeLogText(`${NO_CORRELATION_ID}\n`);

    expect(result.processes).toEqual([]);
  });
});

describe("analyzeLogText — legacy line accounting and warnings", () => {
  it("reports zero legacy lines and no warning when every parsed line carries the full v2 identity triple", () => {
    const result = analyzeLogText(`${L2}\n`);

    expect(result.legacyLineCount).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("counts lines lacking the full identity triple as legacy and emits exactly one named warning", () => {
    const result = analyzeLogText(FIXTURE_TEXT);

    // FIXTURE_TEXT's legacy lines: L4_PRE_V2 (no pid/instanceId/seq) and NO_CORRELATION_ID
    // (a process.started line with no identity triple either).
    expect(result.legacyLineCount).toBe(2);
    expect(result.warnings).toEqual([
      "2 line(s) predate the v2 envelope and were ordered by file position",
    ]);
  });
});

describe("human-readable rendering — processes and warnings", () => {
  it("renders a warning line naming the legacy line count", () => {
    const rendered = renderHumanAllTimelines(analyzeLogText(FIXTURE_TEXT));
    expect(rendered).toContain(
      "warning: 2 line(s) predate the v2 envelope and were ordered by file position",
    );
  });

  it("renders a process summary section with pid, instanceId, seq range, and exitReason", () => {
    const text = `${PROC_STARTED}\n${PROC_EXITING}\n`;
    const rendered = renderHumanAllTimelines(analyzeLogText(text));
    expect(rendered).toContain("Processes: 1");
    expect(rendered).toContain("pid=4242 instanceId=dddddddd");
    expect(rendered).toContain("seq=1-3");
    expect(rendered).toContain("exitReason=SIGTERM");
  });

  it("omits both sections when there are no lines at all", () => {
    const rendered = renderHumanAllTimelines(analyzeLogText(""));
    expect(rendered).not.toContain("Processes:");
    expect(rendered).not.toContain("warning:");
  });
});

describe("findTimeline", () => {
  it("returns undefined for a correlation id that is not present", () => {
    const result = analyzeLogText(FIXTURE_TEXT);
    expect(findTimeline(result, "does-not-exist")).toBeUndefined();
  });
});

describe("analyzeLogText — line-splitting and value-shape edge cases", () => {
  it("keeps the last line when the text has no trailing newline", () => {
    // splitLines only pops the single empty artifact a TRAILING newline produces; text that
    // already ends on real content must not lose that last line.
    const result = analyzeLogText(L2);

    expect(findTimeline(result, "req-1")?.lines).toHaveLength(1);
  });

  it("counts a line that parses as JSON but is not a plain object as malformed", () => {
    // `JSON.parse` succeeds for "42" (a bare number), but classifyLine needs an object shaped
    // like a log record — distinct from GARBAGE above, which fails JSON.parse itself.
    const result = analyzeLogText("42\n");

    expect(result.malformedLineCount).toBe(1);
    expect(result.timelines).toEqual([]);
  });

  it("buckets level and durationMs onto the view when the line carries them", () => {
    const withLevelAndDuration = line({
      ts: T0,
      category: "http",
      op: "req.a",
      correlationId: "req-level",
      level: "warn",
      durationMs: 42,
    });

    const result = analyzeLogText(`${withLevelAndDuration}\n`);

    const view = findTimeline(result, "req-level")?.lines[0];
    expect(view?.level).toBe("warn");
    expect(view?.durationMs).toBe(42);
  });

  it("skips a non-manifest $section line as bundle metadata, not as malformed", () => {
    // Wave 1 only ever sees the manifest's own `$section: "manifest"` at index 0 (already
    // stripped before classifyLine runs), but classifyLine's own check covers ANY `$section`
    // value so a future interstitial section marker is skipped, not counted as corruption.
    const result = analyzeLogText('{"$section":"notes"}\n');

    expect(result.malformedLineCount).toBe(0);
    expect(result.timelines).toEqual([]);
    expect(result.processes).toEqual([]);
  });

  it("deduplicates a repeated errorKind within one timeline", () => {
    const first = line({
      ts: T0,
      category: "http",
      op: "req.a",
      correlationId: "req-dup",
      errorKind: "TIMEOUT",
    });
    const second = line({
      ts: T1,
      category: "http",
      op: "req.b",
      correlationId: "req-dup",
      errorKind: "TIMEOUT",
    });

    const result = analyzeLogText(`${first}\n${second}\n`);

    expect(findTimeline(result, "req-dup")?.errorKinds).toEqual(["TIMEOUT"]);
  });

  it("falls back to a zero durationMs when the group's timestamps do not parse as dates", () => {
    const first = line({
      ts: "garbage-ts",
      category: "http",
      op: "req.a",
      correlationId: "req-garbage-ts",
    });
    const second = line({
      ts: "zzzzzzzz",
      category: "http",
      op: "req.b",
      correlationId: "req-garbage-ts",
    });

    const result = analyzeLogText(`${first}\n${second}\n`);

    expect(findTimeline(result, "req-garbage-ts")?.durationMs).toBe(0);
  });
});

describe("analyzeLogText — process lifetimes: first line is process.exiting", () => {
  it("omits exitReason and still summarises the lifetime when its only line is a reason-less process.exiting", () => {
    // The first (and here only) line seen for a lifetime is not always process.started — a
    // truncated/rotated log can open directly on a later lifecycle line. exitReasonOf must also
    // fall back to undefined when the `reason` field is absent, not just when it is the wrong type.
    const exitingFirst = line({
      ts: T0,
      category: "process",
      op: "process.exiting",
      pid: 6161,
      instanceId: "ffffffff",
      seq: 1,
    });

    const result = analyzeLogText(`${exitingFirst}\n`);

    expect(result.processes).toHaveLength(1);
    const summary = result.processes[0];
    expect(summary?.pid).toBe(6161);
    expect(summary?.started).toBeUndefined();
    expect(summary?.exitReason).toBeUndefined();
  });
});

describe("analyzeLogText — process lifetimes: out-of-order merge", () => {
  it("widens firstTs backward, leaves lastTs unchanged, updates started, and leaves exitReason unset on an out-of-order, reason-less merge", () => {
    // Three lines for one lifetime, processed in file order: a process.started (establishes the
    // lifetime), a SECOND process.started with an EARLIER ts and its own extra payload (must pull
    // firstTs backward, must NOT move lastTs, and must overwrite `started`), and a process.exiting
    // with no `reason` field (must leave exitReason unset even though the lifetime already exists).
    const startedFirst = line({
      ts: T1,
      category: "process",
      op: "process.started",
      pid: 5555,
      instanceId: "eeeeeeee",
      seq: 1,
      nodeVersion: "v1",
    });
    const startedAgainEarlier = line({
      ts: T0,
      category: "process",
      op: "process.started",
      pid: 5555,
      instanceId: "eeeeeeee",
      seq: 2,
      nodeVersion: "v2",
    });
    const exitingNoReason = line({
      ts: T2,
      category: "process",
      op: "process.exiting",
      pid: 5555,
      instanceId: "eeeeeeee",
      seq: 3,
    });

    const result = analyzeLogText(`${startedFirst}\n${startedAgainEarlier}\n${exitingNoReason}\n`);

    expect(result.processes).toHaveLength(1);
    const summary = result.processes[0];
    expect(summary?.lineCount).toBe(3);
    expect(summary?.firstSeq).toBe(1);
    expect(summary?.lastSeq).toBe(3);
    expect(summary?.firstTs).toBe(T0);
    expect(summary?.lastTs).toBe(T2);
    expect(summary?.started).toEqual({ nodeVersion: "v2" });
    expect(summary?.exitReason).toBeUndefined();
  });
});

describe("renderHumanTimeline — no lines", () => {
  it("renders only the header when a timeline has no lines", () => {
    const empty: LogTimeline = {
      correlationId: "req-empty",
      lines: [],
      firstTs: T0,
      lastTs: T0,
      durationMs: 0,
      errorKinds: [],
    };

    expect(renderHumanTimeline(empty)).toBe(`correlationId=req-empty lines=0 durationMs=0\n`);
  });
});

describe("human-readable rendering", () => {
  const timeline: LogTimeline = {
    correlationId: "req-1",
    lines: [
      { ts: T0, seq: 1, category: "http", op: "op.a", level: "info" },
      {
        ts: T1,
        seq: 2,
        category: "http",
        op: "op.b",
        level: "error",
        errorKind: "TIMEOUT",
        durationMs: 42,
      },
    ],
    firstTs: T0,
    lastTs: T1,
    durationMs: 1000,
    errorKinds: ["TIMEOUT"],
  };

  it("renders one line per event with seq, level, category, op, and bracketed errorKind/durationMs", () => {
    const rendered = renderHumanTimeline(timeline);
    expect(rendered).toContain("correlationId=req-1");
    expect(rendered).toContain(`${T0} 1 info http op.a`);
    expect(rendered).toContain(`${T1} 2 error http op.b [TIMEOUT] [42ms]`);
  });

  it("renders a fallback line for zero timelines", () => {
    expect(
      renderHumanAllTimelines({
        timelines: [],
        malformedLineCount: 0,
        processes: [],
        legacyLineCount: 0,
        warnings: [],
        clusters: [],
      }),
    ).toBe("No correlated events found.\n");
  });
});

describe("analyzeLogText — causeChain passthrough and aggregation", () => {
  it("carries a line's causeChain onto its view, and buildReproductionSeed aggregates it", () => {
    const withCauseChain = line({
      ts: T0,
      category: "client",
      op: "client.diagnostic",
      correlationId: "req-cause",
      pid: 9001,
      instanceId: "c3c3c3c3",
      seq: 1,
      causeChain: ["ECONNRESET", "socket hang up"],
    });

    const result = analyzeLogText(`${withCauseChain}\n`);
    const timeline = findTimeline(result, "req-cause");
    expect(timeline?.lines[0]?.causeChain).toEqual(["ECONNRESET", "socket hang up"]);

    const seed = buildReproductionSeed(`${withCauseChain}\n`, "req-cause", new Date(T1));
    expect(seed?.causeChain).toEqual(["ECONNRESET", "socket hang up"]);
  });
});

describe("analyzeLogText — Wave 6: cluster sample id cap", () => {
  it("caps sampleCorrelationIds at MAX_CLUSTER_SAMPLE_IDS while count keeps growing", () => {
    const lines = Array.from({ length: 6 }, (_, index) =>
      line({
        ts: T0,
        category: "gateway",
        op: "gateway.retry.scheduled",
        correlationId: `req-cap-${String(index)}`,
        errorKind: "GATEWAY_RATE_LIMIT",
      }),
    );

    const result = analyzeLogText(`${lines.join("\n")}\n`);

    const cluster = result.clusters.find((c) => c.op === "gateway.retry.scheduled");
    expect(cluster?.count).toBe(6);
    expect(cluster?.sampleCorrelationIds).toHaveLength(5);
    expect(cluster?.sampleCorrelationIds).not.toContain("req-cap-5");
  });
});

describe("renderHumanClusters", () => {
  it("renders only the header, with zero count, when there are no clusters", () => {
    expect(renderHumanClusters([])).toBe("Clusters: 0\n");
  });

  it("omits the sample= suffix for a cluster with no correlationId, and includes it otherwise", () => {
    const withId: OpCluster = {
      category: "gateway",
      op: "gateway.retry.scheduled",
      errorKind: "GATEWAY_RATE_LIMIT",
      count: 1,
      sampleCorrelationIds: ["req-a"],
    };
    const withoutId: OpCluster = {
      category: "process",
      op: "process.heartbeat",
      errorKind: null,
      count: 3,
      sampleCorrelationIds: [],
    };

    const rendered = renderHumanClusters([withId, withoutId]);

    expect(rendered).toContain("Clusters: 2");
    expect(rendered).toContain(
      "gateway gateway.retry.scheduled [GATEWAY_RATE_LIMIT] count=1 sample=req-a",
    );
    expect(rendered).toContain("process process.heartbeat [-] count=3");
    expect(rendered).not.toContain("process process.heartbeat [-] count=3 sample=");
  });
});

describe("buildGatewayReplayScript — outcome classification and attempt fallbacks", () => {
  it("classifies GATEWAY_TIMEOUT as timeout and GATEWAY_TRANSPORT as transport-error", () => {
    const timeoutLine: ServerLogLineView = {
      ts: T0,
      category: "gateway",
      op: "gateway.chat.failed",
      errorKind: "GATEWAY_TIMEOUT",
    };
    const transportLine: ServerLogLineView = {
      ts: T1,
      category: "gateway",
      op: "gateway.stream.failed",
      errorKind: "GATEWAY_TRANSPORT",
    };

    const script = buildGatewayReplayScript([timeoutLine, transportLine]);

    expect(script?.attempts[0]?.outcome).toBe("timeout");
    expect(script?.attempts[1]?.outcome).toBe("transport-error");
  });

  it("falls back to unknown-model, a zero durationMs, and no firstTokenMs when the line carries no extra", () => {
    const attemptLine: ServerLogLineView = {
      ts: T0,
      category: "gateway",
      op: "gateway.chat.failed",
      errorKind: "GATEWAY_TIMEOUT",
    };

    const script = buildGatewayReplayScript([attemptLine]);

    expect(script?.modelId).toBe("unknown-model");
    expect(script?.attempts[0]?.durationMs).toBe(0);
    expect(script?.attempts[0]?.firstTokenMs).toBeUndefined();
  });

  it("carries firstTokenMs through when the attempt's extra has it", () => {
    const attemptLine: ServerLogLineView = {
      ts: T0,
      category: "gateway",
      op: "gateway.stream.completed",
      extra: { firstTokenMs: 120 },
    };

    const script = buildGatewayReplayScript([attemptLine]);

    expect(script?.attempts[0]?.outcome).toBe("success");
    expect(script?.attempts[0]?.firstTokenMs).toBe(120);
  });
});

describe("buildReproductionSeed — indexingJob with no extra fields", () => {
  it("returns an indexingJob object with every field undefined when the started line carries no extra", () => {
    const started = line({
      ts: T0,
      category: "indexing",
      op: "indexing.job.started",
      correlationId: "req-job-bare",
      pid: 1,
      instanceId: "d4d4d4d4",
      seq: 1,
    });

    const seed = buildReproductionSeed(`${started}\n`, "req-job-bare", new Date(T1));

    expect(seed?.indexingJob).toBeDefined();
    expect(seed?.indexingJob?.sourceCount).toBeUndefined();
    expect(seed?.indexingJob?.tokenizerKind).toBeUndefined();
  });
});

describe("buildReproductionSeed — storeFingerprint edge cases", () => {
  it("treats an empty storeFingerprints array in the manifest as no fingerprints", () => {
    const manifest = line({ $section: "manifest", schemaVersion: 2, storeFingerprints: [] });
    const requestLine = line({
      ts: T0,
      category: "http",
      op: "request",
      correlationId: "req-empty-fp",
      pid: 1,
      instanceId: "e5e5e5e5",
      seq: 1,
    });

    const seed = buildReproductionSeed(
      `${manifest}\n${requestLine}\n`,
      "req-empty-fp",
      new Date(T1),
    );

    expect(seed?.storeFingerprint).toBeUndefined();
  });

  it("warns about a bundle manifest with no storeFingerprints, distinct from the raw-log warning", () => {
    const manifest = line({ $section: "manifest", schemaVersion: 2 });
    const requestLine = line({
      ts: T0,
      category: "http",
      op: "request",
      correlationId: "req-bundle-no-fp",
      pid: 1,
      instanceId: "f6f6f6f6",
      seq: 1,
    });

    const seed = buildReproductionSeed(
      `${manifest}\n${requestLine}\n`,
      "req-bundle-no-fp",
      new Date(T1),
    );

    expect(seed?.sourceArtifact.kind).toBe("bundle");
    expect(seed?.warnings).toContain(
      "no store fingerprints found in this bundle's manifest — either the exporter predates " +
        "Wave 4a, or every store was unavailable at export time",
    );
  });
});

describe("buildReproductionSeed — frames present suppresses the missing-frames warning", () => {
  it("omits the missing-frames warning and includes stackFrames when the timeline carries frames", () => {
    const withFrames = line({
      ts: T0,
      category: "gateway",
      op: "gateway.chat.failed",
      correlationId: "req-frames-present",
      pid: 1,
      instanceId: "a7a7a7a7",
      seq: 1,
      frames: ["packages/keiko-server/dist/a.js:1:1"],
    });

    const seed = buildReproductionSeed(`${withFrames}\n`, "req-frames-present", new Date(T1));

    expect(seed?.stackFrames).toEqual(["packages/keiko-server/dist/a.js:1:1"]);
    expect(seed?.warnings).not.toContain(
      "no frames recorded for this correlationId — either no error occurred on this call, or " +
        "this artifact predates Wave 2's frame capture",
    );
  });
});

describe("renderHumanReproductionSeed — Wave 6 sub-field rendering", () => {
  function baseSeed(overrides: Partial<ReproductionSeed> = {}): ReproductionSeed {
    return {
      schemaVersion: 1,
      generatedAt: T0,
      sourceArtifact: { kind: "raw-log", lineCount: 1, sha256: "a".repeat(64) },
      correlationId: "req-seed",
      timeline: [],
      warnings: ["no prompt/response body was ever logged by design"],
      ...overrides,
    };
  }

  it("renders httpRequest, indexingJob, storeFingerprint, stackFrames, and causeChain when present", () => {
    const seed = baseSeed({
      httpRequest: { method: "POST", routeTemplate: "/api/chat", status: 200 },
      indexingJob: { sourceCount: 4, tokenizerKind: "qwen3" },
      storeFingerprint: [
        {
          store: "ui",
          schemaVersion: 1,
          migrationsApplied: ["0001-initial"],
          tableRowCounts: { conversations: 1 },
          quickCheckOk: true,
          encryptionMode: "plaintext",
        },
      ],
      stackFrames: ["packages/keiko-server/dist/a.js:1:1"],
      causeChain: ["ECONNRESET", "socket hang up"],
    });

    const rendered = renderHumanReproductionSeed(seed);

    expect(rendered).toContain('httpRequest: {"method":"POST"');
    expect(rendered).toContain('indexingJob: {"sourceCount":4');
    expect(rendered).toContain('storeFingerprint: [{"store":"ui"');
    expect(rendered).toContain("stackFrames:\n  packages/keiko-server/dist/a.js:1:1");
    expect(rendered).toContain("causeChain: ECONNRESET -> socket hang up");
  });

  it("omits every optional section, including stackFrames/causeChain defined but empty", () => {
    const seed = baseSeed({ stackFrames: [], causeChain: [] });

    const rendered = renderHumanReproductionSeed(seed);

    expect(rendered).not.toContain("httpRequest:");
    expect(rendered).not.toContain("indexingJob:");
    expect(rendered).not.toContain("storeFingerprint:");
    expect(rendered).not.toContain("stackFrames:");
    expect(rendered).not.toContain("causeChain:");
  });
});

describe("renderGatewayReplayScriptFixture — attempt field fallbacks", () => {
  function parsedEntries(script: GatewayReplayScript): Record<string, unknown>[] {
    const rendered = renderGatewayReplayScriptFixture(script);
    const match = /= (\[[\s\S]*\]);\n$/.exec(rendered ?? "");
    return JSON.parse(match?.[1] ?? "[]") as Record<string, unknown>[];
  }

  it("falls back to a stop finish_reason for a successful attempt with no finishReason", () => {
    const script: GatewayReplayScript = {
      modelId: "example-chat-model",
      attempts: [{ outcome: "success", durationMs: 10 }],
    };

    const entries = parsedEntries(script);

    const body = entries[0]?.bodyJson as { choices: { finish_reason: string }[] };
    expect(body.choices[0]?.finish_reason).toBe("stop");
  });

  it("falls back to the outcome's default status and omits headers when retryAfterMs is absent", () => {
    const script: GatewayReplayScript = {
      modelId: "example-chat-model",
      attempts: [{ outcome: "timeout", durationMs: 5 }],
    };

    const entries = parsedEntries(script);

    expect(entries[0]?.status).toBe(504);
    expect(entries[0]).not.toHaveProperty("headers");
  });

  it("includes a retry-after header derived from retryAfterMs, rounded up to whole seconds", () => {
    const script: GatewayReplayScript = {
      modelId: "example-chat-model",
      attempts: [{ outcome: "rate-limit", durationMs: 3, retryAfterMs: 1500 }],
    };

    const entries = parsedEntries(script);

    expect(entries[0]?.status).toBe(429);
    expect(entries[0]?.headers).toEqual({ "retry-after": "2" });
  });
});
