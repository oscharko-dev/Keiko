import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { PathDeniedError } from "@oscharko-dev/keiko-workspace";
import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  activityLogLossCounters,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  causeChain as productionCauseChain,
  createFileServerLogSink,
  formatServerLogLine,
  keikoStackFrames,
  redactLogFields,
  type ServerLogCategory,
  type ServerLogSink,
} from "@oscharko-dev/keiko-activity-log";
import { readPersistedActivityLog } from "../../../../tests/support/activity-log-proof.js";

import {
  analyzeLogText,
  buildGatewayReplayScript,
  buildReproductionSeed,
  detectSourceKind,
  findUpdateAttempt,
  findTimeline,
  hasIssueToPrJourneyOps,
  renderGatewayReplayScriptFixture,
  renderHumanAllTimelines,
  renderHumanClusters,
  renderHumanReproductionSeed,
  renderHumanTimeline,
  type GatewayReplayScript,
  type LogTimeline,
  type OpCluster,
  type ReproductionSeed,
  type ServerLogLineView,
} from "./support-analyze.js";

function line(fields: Record<string, unknown>): string {
  const carriesIdentity = ["pid", "instanceId", "seq"].some((key) => fields[key] !== undefined);
  return JSON.stringify({
    ...(carriesIdentity && fields.schemaVersion === undefined ? { schemaVersion: 2 } : {}),
    ...fields,
  });
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
  new URL("../../../../docs/observability/op-catalog.generated.json", import.meta.url),
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
  process: "process",
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

// The file sink contributes its real registered safe-open line. The supplied fixtures then cross
// the production formatter without the physical sink's registration gate: this analyzer suite
// deliberately needs legacy and adversarial record shapes, while server-log.test.ts separately
// proves that those shapes cannot reach a current production file.
//
// The physical sink refuses every fixture shape written here (they are deliberately unregistered),
// and that refusal is what lets the first fixture's correlation reach the sink's own safe-open line
// without persisting a second copy of the fixture. The refusal is counted as `schema-rejected` and
// announced on stderr; the count is asserted and the notice captured, so priming can neither leak
// output into this suite nor start persisting a fixture unnoticed.
function primeFileSink(
  fileSink: ServerLogSink,
  event: Parameters<ServerLogSink["write"]>[0],
): void {
  const rejectedBefore = activityLogLossCounters()["schema-rejected"];
  const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    fileSink.write(event);
  } finally {
    stderrWrite.mockRestore();
  }
  expect(activityLogLossCounters()["schema-rejected"]).toBe(rejectedBefore + 1);
}

function serializedActivityLog(prefix: string, write: (sink: ServerLogSink) => void): string {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  const fileSink = createFileServerLogSink(stateDir, { level: "debug" });
  const fixtureLines: string[] = [];
  let primed = false;
  const fixtureSink: ServerLogSink = {
    write(event): void {
      if (!primed) {
        primeFileSink(fileSink, event);
        primed = true;
      }
      fixtureLines.push(formatServerLogLine(event));
    },
  };
  try {
    write(fixtureSink);
    fileSink.close?.();
    return `${readPersistedActivityLog(stateDir)}${fixtureLines.join("")}`;
  } finally {
    fileSink.close?.();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const CONNECTED_CONTEXT_STARTED = "search.connected-context.started";
const CONNECTED_CONTEXT_COMPLETED = "search.connected-context.completed";
const WORKSPACE_ROOT_DENIED = "workspace.root.denied";
const WATCH_AUTHORITY_REVOKED = "editor.workspace-watch.authority-revoked";
const UPDATE_CANDIDATE_ISSUED = "update.candidate.issued";
const UPDATE_CANDIDATE_CONSUMED = "update.candidate.consumed";
const UPDATE_SESSION_LIFECYCLE = "update.session.lifecycle";
const UPDATE_RUNTIME_EVENT = "update.runtime.event";

const T0 = "2026-08-21T00:00:00.000Z";
const T1 = "2026-08-21T00:00:01.000Z";
const T2 = "2026-08-21T00:00:02.000Z";
const T3 = "2026-08-21T00:00:03.000Z";

const SAFE_OPEN_EXTRA = {
  artifactClass: "activity-log",
  persistenceStatus: "opened",
  permissionAssurance: "verified-private",
  containmentAssurance: "private-root-guarded",
  completeness: "complete",
  loss: "none",
} as const;

function expectCorrelatedSafeOpen(view: ServerLogLineView | undefined): void {
  expect(view).toMatchObject({
    category: "diagnostic",
    op: "server-log.safe-open",
  });
  expect(view?.errorKind).toBeUndefined();
  expect(view?.extra).toEqual(SAFE_OPEN_EXTRA);
}

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

describe("analyzeLogText — governed update attempts", () => {
  it("reconstructs one body-free attempt across request and background lineage", () => {
    const candidateId = "candidate-3405-0123456789abcdef";
    const requestId = "request-3405-0123456789abcdef";
    const recoveryId = "recovery-3405-0123456789abcdef";
    const sessionId = "session-3405-0123456789abcdef";
    const serialized = serializedActivityLog("keiko-support-update-attempt-", (sink) => {
      sink.write({
        level: "info",
        category: productionLogCategory(UPDATE_CANDIDATE_ISSUED),
        op: UPDATE_CANDIDATE_ISSUED,
        correlationId: candidateId,
        extra: { candidateId, targetVersion: "0.3.18" },
      });
      sink.write({
        level: "info",
        category: productionLogCategory(UPDATE_CANDIDATE_CONSUMED),
        op: UPDATE_CANDIDATE_CONSUMED,
        correlationId: requestId,
        extra: { candidateId, targetVersion: "0.3.18" },
      });
      sink.write({
        level: "info",
        category: productionLogCategory(UPDATE_SESSION_LIFECYCLE),
        op: UPDATE_SESSION_LIFECYCLE,
        correlationId: requestId,
        extra: { candidateId, sessionId, phase: "preparing", eventKind: "started" },
      });
      sink.write({
        level: "warn",
        category: productionLogCategory(UPDATE_RUNTIME_EVENT),
        op: UPDATE_RUNTIME_EVENT,
        correlationId: recoveryId,
        parentCorrelationId: requestId,
        extra: { sessionId, type: "portable-relaunch-result", status: "recovery-required" },
      });
      sink.write({
        level: "info",
        category: productionLogCategory(UPDATE_RUNTIME_EVENT),
        op: UPDATE_RUNTIME_EVENT,
        correlationId: requestId,
        extra: { sessionId, type: "remediation-completed", status: "completed" },
      });
    });

    const result = analyzeLogText(serialized);
    const attempt = findUpdateAttempt(result, recoveryId);

    expect(attempt).toMatchObject({
      candidateId,
      sessionId,
      correlationIds: [candidateId, requestId, recoveryId],
    });
    expectCorrelatedSafeOpen(attempt?.lines[0]);
    expect(attempt?.lines.map((entry) => entry.op)).toEqual([
      "server-log.safe-open",
      UPDATE_CANDIDATE_ISSUED,
      UPDATE_CANDIDATE_CONSUMED,
      UPDATE_SESSION_LIFECYCLE,
      UPDATE_RUNTIME_EVENT,
      UPDATE_RUNTIME_EVENT,
    ]);
    expect(attempt?.lines[4]).toMatchObject({
      parentCorrelationId: requestId,
      status: "recovery-required",
      extra: { type: "portable-relaunch-result" },
    });
    expect(serialized).not.toContain("executionToken");
    expect(serialized).not.toContain("releaseNoteBullets");
    expect(serialized).not.toContain("summary");
  });

  it("does not infer an attempt from version or timestamp proximity", () => {
    const serialized = serializedActivityLog("keiko-support-update-unbound-", (sink) => {
      sink.write({
        level: "info",
        category: "diagnostic",
        op: "unrelated.update-like-event",
        correlationId: "unbound-3405-0123456789abcdef",
        extra: { candidateId: "not-production-update-op", targetVersion: "0.3.18" },
      });
    });

    expect(analyzeLogText(serialized).updateAttempts).toEqual([]);
  });

  it("reconstructs a large corpus of distinct explicit candidates", () => {
    const candidateCount = 1024;
    const text = Array.from({ length: candidateCount }, (_, index) => {
      const candidateId = `candidate-large-${String(index)}`;
      return line({
        ts: T0,
        category: "diagnostic",
        op: "update.candidate.issued",
        correlationId: `request-large-${String(index)}`,
        candidateId,
      });
    }).join("\n");

    const attempts = analyzeLogText(text).updateAttempts;

    expect(attempts).toHaveLength(candidateCount);
    expect(attempts.map((attempt) => attempt.candidateId)).toEqual(
      Array.from({ length: candidateCount }, (_, index) => `candidate-large-${String(index)}`),
    );
    expect(attempts[0]).toMatchObject({
      correlationIds: ["request-large-0"],
      lines: [{ op: "update.candidate.issued" }],
    });
    expect(attempts.at(-1)).toMatchObject({
      correlationIds: [`request-large-${String(candidateCount - 1)}`],
      lines: [{ op: "update.candidate.issued" }],
    });
  });

  it("retains fixed-point correlation discovery order across a child, grandchild, and sibling", () => {
    const candidateId = "candidate-discovery-order";
    const attempt = findUpdateAttempt(
      analyzeLogText(
        [
          line({
            ts: T0,
            category: "diagnostic",
            op: "update.candidate.issued",
            correlationId: "root-request",
            candidateId,
          }),
          line({
            ts: T0,
            category: "diagnostic",
            op: "update.runtime.event",
            correlationId: "child",
            parentCorrelationId: "root-request",
          }),
          line({
            ts: T0,
            category: "diagnostic",
            op: "update.runtime.event",
            correlationId: "grandchild",
            parentCorrelationId: "child",
          }),
          line({
            ts: T0,
            category: "diagnostic",
            op: "update.runtime.event",
            correlationId: "sibling",
            parentCorrelationId: "root-request",
          }),
        ].join("\n"),
      ),
      candidateId,
    );

    expect(attempt?.correlationIds).toEqual(["root-request", "child", "grandchild", "sibling"]);
  });

  it("reconstructs a large reverse-ordered descendant lineage", () => {
    const descendantCount = 1024;
    const candidateId = "candidate-reverse-lineage";
    const descendantLines = Array.from({ length: descendantCount }, (_, offset) => {
      const index = descendantCount - offset - 1;
      return line({
        ts: T0,
        category: "diagnostic",
        op: "update.runtime.event",
        correlationId: `descendant-${String(index)}`,
        parentCorrelationId: index === 0 ? "root-request" : `descendant-${String(index - 1)}`,
        marker: `descendant-${String(index)}`,
      });
    });
    const result = analyzeLogText(
      [
        line({
          ts: T0,
          category: "diagnostic",
          op: "update.candidate.issued",
          correlationId: "root-request",
          candidateId,
        }),
        ...descendantLines,
      ].join("\n"),
    );
    const attempt = findUpdateAttempt(result, candidateId);

    expect(attempt?.correlationIds).toEqual([
      "root-request",
      ...Array.from({ length: descendantCount }, (_, index) => `descendant-${String(index)}`),
    ]);
    expect(attempt?.lines.map((entry) => entry.extra?.marker)).toEqual([
      undefined,
      ...Array.from(
        { length: descendantCount },
        (_, offset) => `descendant-${String(descendantCount - offset - 1)}`,
      ),
    ]);
  });

  it("deduplicates shared lineage, terminates cycles, and retains source line order", () => {
    const candidateA = "candidate-shared-a";
    const candidateB = "candidate-shared-b";
    const result = analyzeLogText(
      [
        line({
          ts: T0,
          category: "diagnostic",
          op: "update.candidate.issued",
          correlationId: "request-a",
          candidateId: candidateA,
          marker: "candidate-a",
        }),
        line({
          ts: T0,
          category: "diagnostic",
          op: "update.candidate.issued",
          correlationId: "request-b",
          candidateId: candidateB,
          marker: "candidate-b",
        }),
        line({
          ts: T0,
          category: "diagnostic",
          op: "update.runtime.event",
          correlationId: "shared",
          parentCorrelationId: "request-a",
          marker: "shared-from-a",
        }),
        line({
          ts: T0,
          category: "diagnostic",
          op: "update.runtime.event",
          correlationId: "shared",
          parentCorrelationId: "request-b",
          marker: "shared-from-b",
        }),
        line({
          ts: T0,
          category: "diagnostic",
          op: "update.runtime.event",
          correlationId: "cycle",
          parentCorrelationId: "shared",
          marker: "cycle",
        }),
        line({
          ts: T0,
          category: "diagnostic",
          op: "update.runtime.event",
          correlationId: "shared",
          parentCorrelationId: "cycle",
          marker: "shared-from-cycle",
        }),
      ].join("\n"),
    );

    expect(result.updateAttempts.map((attempt) => attempt.candidateId)).toEqual([
      candidateA,
      candidateB,
    ]);
    for (const candidateId of [candidateA, candidateB]) {
      const attempt = findUpdateAttempt(result, candidateId);
      expect(attempt?.correlationIds).toEqual([
        candidateId === candidateA ? "request-a" : "request-b",
        "shared",
        "cycle",
      ]);
      expect(attempt?.lines.map((entry) => entry.extra?.marker)).toEqual(
        candidateId === candidateA
          ? ["candidate-a", "shared-from-a", "shared-from-b", "cycle", "shared-from-cycle"]
          : ["candidate-b", "shared-from-a", "shared-from-b", "cycle", "shared-from-cycle"],
      );
    }
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
    const correlationId = "0123456789abcdef0123456789abcdef";
    const serialized = serializedActivityLog("keiko-support-task-workspace-", (sink) => {
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
    });
    const timeline = findTimeline(analyzeLogText(serialized), correlationId);
    expect(timeline?.correlationId).toBe(correlationId);
    expect(timeline?.errorKinds).toEqual(["LOCK_CONTENTION"]);
    expectCorrelatedSafeOpen(timeline?.lines[0]);
    expect(timeline?.lines[1]).toMatchObject({
      category: "diagnostic",
      op: "task-workspace.lifecycle",
      errorKind: "LOCK_CONTENTION",
      extra: { operation: "provision", outcome: "blocked", attempt: 2, worktreeCount: 1 },
    });
  });

  it("reconstructs connected-context work diagnostics on one support timeline", () => {
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
    const serialized = serializedActivityLog("keiko-support-connected-context-", (sink) => {
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
    });

    const timeline = findTimeline(analyzeLogText(serialized), correlationId);
    expectCorrelatedSafeOpen(timeline?.lines[0]);
    expect(timeline?.lines.map((entry) => entry.op)).toEqual([
      "server-log.safe-open",
      CONNECTED_CONTEXT_STARTED,
      CONNECTED_CONTEXT_COMPLETED,
    ]);
    expect(timeline?.lines.map((entry) => entry.category)).toEqual([
      "diagnostic",
      productionLogCategory(CONNECTED_CONTEXT_STARTED),
      productionLogCategory(CONNECTED_CONTEXT_COMPLETED),
    ]);
    expect(timeline?.lines[1]?.extra).toMatchObject({
      explicitConnection: true,
      scopeIdentitySha256,
      ...requestShape,
    });
    expect(timeline?.lines[2]?.extra).toMatchObject({
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
    expectCorrelatedSafeOpen(timeline?.lines[0]);
    expect(timeline?.lines[1]).toMatchObject({
      category: "security",
      op: WORKSPACE_ROOT_DENIED,
      errorKind: error.code,
      extra: { decision: "denied", reason: "denied-locus" },
    });
    // `frames`/`causeChain` are written INSIDE `extra` by the emitter and hoisted onto the line by
    // the sink's own formatter — which is the only reason `keiko support analyze --seed` finds them
    // as typed evidence instead of leaving them buried in `extra`.
    expect(timeline?.lines[1]?.frames).toEqual(frames);
    expect(timeline?.lines[1]?.causeChain).toEqual(causes);
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
    expectCorrelatedSafeOpen(timeline?.lines[0]);
    expect(timeline?.lines.map((entry) => entry.op)).toEqual([
      "server-log.safe-open",
      WORKSPACE_ROOT_DENIED,
      WATCH_AUTHORITY_REVOKED,
    ]);
    expect(timeline?.lines.map((entry) => entry.category)).toEqual([
      "diagnostic",
      "security",
      "security",
    ]);
    expect(timeline?.errorKinds).toEqual([error.code, "WATCH_AUTHORITY_REVOKED"]);
    expect(timeline?.lines[2]?.extra).toEqual({ decision: "revoked", rootToken: "a".repeat(24) });
    // The revocation carries no path, no endpoint and no client identity — only a decision and the
    // body-free root token the watch session is joined on.
    expect(JSON.stringify(timeline?.lines[2]?.extra)).not.toContain("/");
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

  it("keeps an uncorrelated caller out of timelines while accounting for safe-open fallback", () => {
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

    // The writer's own storage lifecycle lines use the same sanctioned fallback: the segment opened
    // (safe-open) and sealed on close with no request correlation in scope (#3530).
    expect(result.timelines).toEqual([
      expect.objectContaining({
        correlationId: "unknown-correlation-id",
        lines: [
          expect.objectContaining({ op: "server-log.safe-open" }),
          expect.objectContaining({ op: "activity-log.segment.sealed" }),
        ],
      }),
    ]);
    expect(result.malformedLineCount).toBe(0);
    expect(result.clusters.map((cluster) => cluster.op)).toEqual([
      "server-log.safe-open",
      "activity-log.segment.sealed",
      WATCH_AUTHORITY_REVOKED,
    ]);
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

  it("reconstructs the run-correlated repository and workspace selected for trust", () => {
    const correlationId = "originating-run-correlation";
    const serialized = serializedActivityLog("keiko-support-workbench-trust-", (sink) => {
      sink.write({
        level: "warn",
        category: productionLogCategory("client.diagnostic"),
        op: "client.diagnostic",
        correlationId,
        extra: {
          clientNote: "[keiko] coding workbench repository trust bound",
          repositoryId: "repository-a",
          workspaceId: "workspace-a",
        },
      });
    });

    const timeline = findTimeline(analyzeLogText(serialized), correlationId);
    expectCorrelatedSafeOpen(timeline?.lines[0]);
    expect(timeline?.lines[1]).toMatchObject({
      op: "client.diagnostic",
      extra: {
        repositoryId: "repository-a",
        workspaceId: "workspace-a",
      },
    });
  });

  it("reconstructs run-correlated failed and passed coding verifier summaries", () => {
    const correlationId = "originating-verification-run";
    const op = "coding-runtime.verification-summarized";
    const verificationTargetDigest = "d".repeat(64);
    const serialized = serializedActivityLog("keiko-support-coding-verification-", (sink) => {
      for (const [eventId, verificationStatus, passedCount, failedCount] of [
        ["verification-1", "failed", 0, 1],
        ["verification-2", "passed", 4, 0],
      ] as const) {
        sink.write({
          category: productionLogCategory(op),
          op,
          correlationId,
          extra: {
            runId: correlationId,
            verificationEventId: eventId,
            verificationKind: "targeted-test",
            verificationStatus,
            passedCount,
            failedCount,
            skippedCount: 0,
            verificationTargetDigest,
          },
        });
      }
    });

    const timeline = findTimeline(analyzeLogText(serialized), correlationId);
    expectCorrelatedSafeOpen(timeline?.lines[0]);
    expect(timeline?.lines.map(({ op: lineOp, extra }) => ({ op: lineOp, extra }))).toEqual([
      {
        op: "server-log.safe-open",
        extra: SAFE_OPEN_EXTRA,
      },
      {
        op,
        extra: {
          runId: correlationId,
          verificationEventId: "verification-1",
          verificationKind: "targeted-test",
          verificationStatus: "failed",
          passedCount: 0,
          failedCount: 1,
          skippedCount: 0,
          verificationTargetDigest,
        },
      },
      {
        op,
        extra: {
          runId: correlationId,
          verificationEventId: "verification-2",
          verificationKind: "targeted-test",
          verificationStatus: "passed",
          passedCount: 4,
          failedCount: 0,
          skippedCount: 0,
          verificationTargetDigest,
        },
      },
    ]);
  });

  it("reconstructs the body-free target of a bounded workspace read", () => {
    const correlationId = "originating-workspace-read";
    const op = "coding-runtime.workspace-read";
    const targetPathSha256 = "e".repeat(64);
    const serialized = serializedActivityLog("keiko-support-workspace-read-", (sink) => {
      sink.write({
        category: productionLogCategory(op),
        op,
        correlationId,
        extra: { state: "completed", targetPathSha256, startLine: 4, maxLines: 20 },
      });
    });

    const timeline = findTimeline(analyzeLogText(serialized), correlationId);
    expectCorrelatedSafeOpen(timeline?.lines[0]);
    expect(timeline?.lines[1]).toMatchObject({
      op,
      extra: { state: "completed", targetPathSha256, startLine: 4, maxLines: 20 },
    });
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

  // Regression (epic #3384): `KNOWN_ENVELOPE_KEYS` reserves "status" for the envelope's own
  // NUMERIC HTTP-like status (`ServerLogEvent.status`, applied by `applyEnvelopeFields`). Several
  // real emitters (e.g. `logGitDeliveryMutation` in `gitDelivery/execution.ts`) instead put a
  // closed-vocabulary STRING under `extra.status` (`GitMutationOutcome["status"]`, e.g.
  // "completed"/"blocked"/"failed") with no numeric envelope `status` on the same line at all.
  // Before the fix, `extraFields` excluded ANY key named "status" unconditionally, so that string
  // was silently dropped from every timeline and seed — reconstructing exactly nothing about
  // whether the mutation completed, was blocked, or failed. The numeric case (asserted second)
  // must keep behaving exactly as before: still excluded from `extra`, still the typed
  // `ServerLogLineView.status` field.
  it("keeps a STRING extra.status (no numeric envelope status on the line) inside extra, never dropping it", () => {
    const withStringStatus = line({
      ts: T0,
      category: "diagnostic",
      op: "git.delivery.mutation.completed",
      correlationId: "req-string-status",
      actionKind: "commit",
      status: "blocked",
    });

    const result = analyzeLogText(`${withStringStatus}\n`);

    const view = findTimeline(result, "req-string-status")?.lines[0];
    expect(view?.status).toBeUndefined();
    expect(view?.extra).toEqual({ actionKind: "commit", status: "blocked" });
  });

  it("still excludes a NUMERIC status from extra, reading it as the typed envelope field instead", () => {
    const withNumericStatus = line({
      ts: T0,
      category: "security",
      op: "git.delivery.commit.approval.minted",
      correlationId: "req-numeric-status",
      status: 200,
      operation: "commit",
    });

    const result = analyzeLogText(`${withNumericStatus}\n`);

    const view = findTimeline(result, "req-numeric-status")?.lines[0];
    expect(view?.status).toBe(200);
    expect(view?.extra).toEqual({ operation: "commit" });
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
  it("reports the newest valid event timestamp and its process instance", () => {
    const newer = line({
      ts: T2,
      category: "process",
      op: "process.heartbeat",
      pid: 5252,
      instanceId: "eeeeeeee",
      seq: 2,
    });
    const invalid = line({
      ts: "not-a-timestamp",
      category: "process",
      op: "process.heartbeat",
      pid: 6262,
      instanceId: "ffffffff",
      seq: 3,
    });

    const result = analyzeLogText(`${newer}\n${PROC_STARTED}\n${invalid}\n`);

    expect(result.latestTimestamp).toBe(T2);
    expect(result.latestInstanceId).toBe("eeeeeeee");
  });

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
      "2 corrupt Activity Log line(s)",
    ]);
  });
});

describe("analyzeLogText — strict v2 identity and compatibility classification", () => {
  const base = {
    ts: T0,
    level: "info",
    category: "gateway",
    op: "gateway.instance.reused",
    generation: 1,
    completeness: "complete",
    loss: "none",
    schemaVersion: 2,
    registryVersion: ACTIVITY_LOG_REGISTRY_VERSION,
    schemaDigest: ACTIVITY_LOG_SCHEMA_DIGEST,
    catalogDigest: ACTIVITY_LOG_CATALOG_DIGEST,
    buildClass: "node-esm",
    releaseClass: "stable",
    platformClass: "linux-x64",
    productVersion: "1.0.0",
    compatibilityState: "supported",
    writerCapability: "active",
    pid: 4242,
    instanceId: "deadbeef",
    seq: 1,
  };

  it("distinguishes supported, legacy, unsupported, corrupt, truncated, and incomplete evidence", () => {
    const records = [
      line(base),
      line({ ts: T0, category: "process", op: "legacy.none" }),
      line({ ...base, schemaVersion: 7, op: "future.unsupported" }),
      line({ ...base, pid: 0, op: "identity.corrupt" }),
      line({ ...base, seq: undefined, op: "identity.incomplete" }),
      "{truncated",
    ];

    const result = analyzeLogText(records.join("\n"));

    expect(result.evidence).toMatchObject({
      classification: "corrupt",
      supportedLineCount: 1,
      legacyLineCount: 1,
      unsupportedLineCount: 1,
      corruptLineCount: 1,
      truncatedLineCount: 1,
      incompleteLineCount: 1,
    });
    expect(result.malformedLineCount).toBe(3);
    expect(result.legacyLineCount).toBe(1);
    expect(result.timelines).toEqual([]);
  });

  it.each([
    ["missing schemaVersion", { schemaVersion: undefined }, "incomplete"],
    ["missing pid", { pid: undefined }, "incomplete"],
    ["missing instanceId", { instanceId: undefined }, "incomplete"],
    ["missing seq", { seq: undefined }, "incomplete"],
    ["invalid pid with missing seq", { pid: "attacker", seq: undefined }, "corrupt"],
    ["fractional schemaVersion", { schemaVersion: 2.5 }, "corrupt"],
    ["zero pid", { pid: 0 }, "corrupt"],
    ["fractional pid", { pid: 1.5 }, "corrupt"],
    ["oversized pid", { pid: 2_147_483_648 }, "corrupt"],
    ["empty instanceId", { instanceId: "" }, "corrupt"],
    ["unsafe instanceId", { instanceId: "contains space" }, "corrupt"],
    ["noncanonical instanceId", { instanceId: "journey1" }, "corrupt"],
    ["zero seq", { seq: 0 }, "corrupt"],
    ["fractional seq", { seq: 1.5 }, "corrupt"],
    ["future schemaVersion", { schemaVersion: 3 }, "unsupported"],
  ] as const)("classifies %s without accepting it as legacy", (_name, override, expected) => {
    const result = analyzeLogText(`${line({ ...base, ...override })}\n`);

    expect(result.evidence.classification).toBe(expected);
    expect(result.evidence.legacyLineCount).toBe(0);
    expect(result.processes).toEqual([]);
  });

  it.each([
    ["catalog digest mismatch", { catalogDigest: "0".repeat(64) }, "unsupported"],
    ["partial registry identity", { writerCapability: undefined }, "incomplete"],
    ["degraded writer", { writerCapability: "degraded" }, "incomplete"],
    ["unknown writer capability", { writerCapability: "future" }, "corrupt"],
    ["unknown compatibility state", { compatibilityState: "future" }, "corrupt"],
    ["unknown operation", { op: "gateway.instance.unknown" }, "corrupt"],
    ["missing registered field", { generation: undefined }, "incomplete"],
    ["unknown registered field", { unexpected: "value" }, "corrupt"],
    ["unknown error kind", { errorKind: "provider prose is forbidden" }, "corrupt"],
    ["missing persisted level", { level: undefined }, "corrupt"],
    ["non-ISO timestamp", { ts: "September 17, 2026" }, "corrupt"],
  ] as const)("classifies %s from the generated registry contract", (_name, override, expected) => {
    const result = analyzeLogText(`${line({ ...base, ...override })}\n`);

    expect(result.evidence.classification).toBe(expected);
    expect(result.timelines).toEqual([]);
  });

  it("validates a registered string status as an operation field while preserving it in extra", () => {
    const correlationId = "request-status-0123456789abcdef";
    const record = {
      ...base,
      category: "diagnostic",
      op: "git.delivery.mutation.completed",
      correlationId,
      generation: undefined,
      completeness: "complete",
      loss: "none",
      actionId: "action-0123456789abcdef",
      actionKind: "commit",
      status: "blocked",
      phaseReached: "result",
      policyOutcome: "blocked",
      preflightFindingCount: 1,
      preflightBlockingCount: 1,
      requiredApproverCount: 0,
    };

    const result = analyzeLogText(`${line(record)}\n`);

    expect(result.evidence.classification).toBe("supported");
    const view = findTimeline(result, correlationId)?.lines[0];
    expect(view?.status).toBeUndefined();
    expect(view?.extra).toMatchObject({ status: "blocked", actionKind: "commit" });
  });

  it("keeps a registered numeric status in the envelope rather than operation fields", () => {
    const correlationId = "request-http-status-0123456789";
    const result = analyzeLogText(`${line({ ...base, correlationId, status: 204 })}\n`);

    expect(result.evidence.classification).toBe("supported");
    const view = findTimeline(result, correlationId)?.lines[0];
    expect(view?.status).toBe(204);
    expect(view?.extra).not.toHaveProperty("status");
  });

  it("classifies an invalid terminal fragment as truncated but invalid terminated JSON as corrupt", () => {
    const truncated = analyzeLogText("{partial");
    const corrupt = analyzeLogText("{partial\n");

    expect(truncated.evidence).toMatchObject({
      classification: "truncated",
      truncatedLineCount: 1,
      corruptLineCount: 0,
    });
    expect(corrupt.evidence).toMatchObject({
      classification: "corrupt",
      truncatedLineCount: 0,
      corruptLineCount: 1,
    });
  });

  it("retains a copied terminal-fragment signal in a support bundle", () => {
    const bundle = `${line({ $section: "manifest" })}\n${line({
      $section: "config-snapshot",
    })}\n{"ts":`;

    expect(analyzeLogText(bundle).evidence).toMatchObject({
      classification: "truncated",
      truncatedLineCount: 1,
      corruptLineCount: 0,
    });
  });
});

describe("analyzeLogText — process sequence integrity", () => {
  it("reports each gap, duplicate, decrease, and reset exactly once", () => {
    const event = (seq: number, op: string): string =>
      line({
        ts: T0,
        category: "process",
        op,
        pid: 5151,
        instanceId: "abc12345",
        seq,
      });
    const result = analyzeLogText(
      `${[event(1, "one"), event(3, "three"), event(3, "duplicate"), event(2, "down"), event(1, "reset")].join("\n")}\n`,
    );

    expect(result.evidence.classification).toBe("incomplete");
    expect(result.evidence.sequenceAnomalies).toEqual([
      expect.objectContaining({
        kind: "gap",
        fileIndex: 1,
        previousSeq: 1,
        seq: 3,
        missingFrom: 2,
        missingTo: 2,
      }),
      expect.objectContaining({ kind: "duplicate", fileIndex: 2, previousSeq: 3, seq: 3 }),
      expect.objectContaining({ kind: "decreasing", fileIndex: 3, previousSeq: 3, seq: 2 }),
      expect.objectContaining({ kind: "duplicate", fileIndex: 4, previousSeq: 2, seq: 1 }),
      expect.objectContaining({ kind: "reset", fileIndex: 4, previousSeq: 2, seq: 1 }),
      expect.objectContaining({ kind: "decreasing", fileIndex: 4, previousSeq: 2, seq: 1 }),
    ]);
    expect(renderHumanAllTimelines(result)).toContain(
      "gap pid=5151 instanceId=abc12345 fileIndex=1 previousSeq=1 seq=3 missing=2-2",
    );
  });

  it("reports a missing lifetime prefix as a gap from sequence one", () => {
    const result = analyzeLogText(
      `${line({ ts: T0, category: "process", op: "late", pid: 8, instanceId: "feedface", seq: 4 })}\n`,
    );

    expect(result.evidence.sequenceAnomalies).toEqual([
      expect.objectContaining({
        kind: "gap",
        previousSeq: 0,
        seq: 4,
        missingFrom: 1,
        missingTo: 3,
      }),
    ]);
    expect(result.evidence.classification).toBe("supported");
  });

  it("does not mistake process-wide allocations in another state directory for missing evidence", () => {
    const event = (seq: number): string =>
      line({
        ts: T0,
        category: "process",
        op: `state-a-${String(seq)}`,
        pid: 5151,
        instanceId: "c0c0d1a0",
        seq,
      });

    const result = analyzeLogText(`${event(1)}\n${event(3)}\n`);

    expect(result.evidence.classification).toBe("supported");
    expect(result.evidence.sequenceAnomalies).toEqual([
      expect.objectContaining({ kind: "gap", previousSeq: 1, seq: 3 }),
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

  it("includes a request's whole timeline when its validated gateway line links it to a run", () => {
    const serialized = [
      line({
        ts: T0,
        category: "coding",
        op: "coding-runtime.run.started",
        correlationId: "run-1",
      }),
      line({
        ts: T1,
        category: "model",
        op: "coding-sidecar.gateway.request-validated",
        correlationId: "request-1",
        parentCorrelationId: "run-1",
      }),
      line({
        ts: T2,
        category: "model",
        op: "chat.request.dispatch",
        correlationId: "request-1",
      }),
      line({
        ts: T3,
        category: "diagnostic",
        op: "server.diagnostic.failure",
        correlationId: "request-1",
        errorKind: "GATEWAY_PROVIDER_ERROR",
      }),
      line({
        ts: T3,
        category: "model",
        op: "coding-sidecar.gateway.turn-failed",
        correlationId: "request-1",
        parentCorrelationId: "run-1",
      }),
      line({
        ts: T3,
        category: "model",
        op: "chat.request.dispatch",
        correlationId: "request-unrelated",
      }),
    ].join("\n");
    const result = analyzeLogText(`${serialized}\n`);

    expect(findTimeline(result, "run-1")?.lines.map((entry) => entry.op)).toEqual([
      "coding-runtime.run.started",
      "coding-sidecar.gateway.request-validated",
      "chat.request.dispatch",
      "server.diagnostic.failure",
      "coding-sidecar.gateway.turn-failed",
    ]);
    expect(findTimeline(result, "request-1")?.lines).toHaveLength(4);
  });

  it("does not attach unrelated unknown-correlation events to a linked run", () => {
    const serialized = [
      line({
        ts: T0,
        category: "coding",
        op: "coding-runtime.run.started",
        correlationId: "run-1",
      }),
      line({
        ts: T1,
        category: "model",
        op: "coding-sidecar.gateway.turn-failed",
        correlationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
        parentCorrelationId: "run-1",
      }),
      line({
        ts: T2,
        category: "diagnostic",
        op: "server.diagnostic.failure",
        correlationId: ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
      }),
    ].join("\n");
    const result = analyzeLogText(`${serialized}\n`);

    expect(findTimeline(result, "run-1")?.lines.map((entry) => entry.op)).toEqual([
      "coding-runtime.run.started",
      "coding-sidecar.gateway.turn-failed",
    ]);
    expect(findTimeline(result, ACTIVITY_LOG_UNKNOWN_CORRELATION_ID)?.lines).toHaveLength(2);
  });

  it("orders linked request and run lifetimes by their first file appearance", () => {
    const serialized = [
      line({
        ts: T0,
        category: "model",
        op: "child-a",
        correlationId: "request-1",
        parentCorrelationId: "run-1",
        pid: 100,
        instanceId: "aaaaaaaa",
        seq: 1,
      }),
      line({
        ts: T1,
        category: "coding",
        op: "parent-b",
        correlationId: "run-1",
        pid: 200,
        instanceId: "bbbbbbbb",
        seq: 1,
      }),
      line({
        ts: T2,
        category: "coding",
        op: "parent-a",
        correlationId: "run-1",
        pid: 100,
        instanceId: "aaaaaaaa",
        seq: 2,
      }),
    ].join("\n");

    expect(
      findTimeline(analyzeLogText(`${serialized}\n`), "run-1")?.lines.map((entry) => entry.op),
    ).toEqual(["child-a", "parent-a", "parent-b"]);
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

  it("rejects non-ISO timestamps before timeline duration calculation", () => {
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

    expect(findTimeline(result, "req-garbage-ts")).toBeUndefined();
    expect(result.evidence).toMatchObject({
      classification: "corrupt",
      corruptLineCount: 2,
    });
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
        sourceKind: "raw-log",
        latestTimestamp: undefined,
        latestInstanceId: undefined,
        timelines: [],
        malformedLineCount: 0,
        evidence: {
          classification: "supported",
          supportedLineCount: 0,
          legacyLineCount: 0,
          unsupportedLineCount: 0,
          corruptLineCount: 0,
          truncatedLineCount: 0,
          incompleteLineCount: 0,
          sequenceAnomalies: [],
        },
        processes: [],
        legacyLineCount: 0,
        warnings: [],
        clusters: [],
        updateAttempts: [],
        sufficiency: analyzeLogText("").sufficiency,
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
  it("classifies typed and legacy timeout kinds while retaining legacy transport detail", () => {
    const timeoutLine: ServerLogLineView = {
      ts: T0,
      category: "gateway",
      op: "gateway.chat.failed",
      errorKind: "timeout",
    };
    const legacyTimeoutLine: ServerLogLineView = {
      ts: T1,
      category: "gateway",
      op: "gateway.stream.failed",
      errorKind: "GATEWAY_TIMEOUT",
    };
    const transportLine: ServerLogLineView = {
      ts: T2,
      category: "gateway",
      op: "gateway.stream.failed",
      errorKind: "GATEWAY_TRANSPORT",
    };

    const script = buildGatewayReplayScript([timeoutLine, legacyTimeoutLine, transportLine]);

    expect(script?.attempts[0]?.outcome).toBe("timeout");
    expect(script?.attempts[1]?.outcome).toBe("timeout");
    expect(script?.attempts[2]?.outcome).toBe("transport-error");
  });

  it("classifies typed and retained legacy rate-limit kinds", () => {
    const typedLine: ServerLogLineView = {
      ts: T0,
      category: "gateway",
      op: "gateway.retry.scheduled",
      errorKind: "rate-limited",
    };
    const legacyLine: ServerLogLineView = {
      ts: T1,
      category: "gateway",
      op: "gateway.retry.scheduled",
      errorKind: "GATEWAY_RATE_LIMIT",
    };

    const script = buildGatewayReplayScript([typedLine, legacyLine]);

    expect(script?.attempts.map(({ outcome }) => outcome)).toEqual(["rate-limit", "rate-limit"]);
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
      sufficiency: analyzeLogText("").sufficiency,
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

// ─── Epic #3384: issue-to-PR journey reconstruction ────────────────────────────────────────────
//
// Every line below is hand-constructed JSON (the `line()` helper), matching the on-disk envelope
// shape (`extra` flattened onto the top level) the real production emitters listed in
// `support-analyze.ts`'s own header comment actually write — the exact op/field names were read
// off those emitters (`gitDelivery/execution.ts`, `commitRoutes.ts`/`pushRoutes.ts`/`prRoutes.ts`,
// `mergeExecution.ts`, `prDescriptionProjection.ts`/`prDescriptionReceiptStore.ts`,
// `journeyObservationService.ts`/`journeyRoutes.ts`, `githubIssueReaderAuthorization.ts`,
// `gitChangeRoutes.ts`), never guessed. The redactor under test is the REAL
// `@oscharko-dev/keiko-server/runtime/tool-catalog-lifecycle` `redactLogFields` — the exact
// choke point `keiko support analyze` wires in production (`support.ts`'s `loadToolAnalysisOptions`).
describe("issueToPrJourney — epic #3384 reconstruction", () => {
  const OPTIONS = { toolDiagnosticRedactor: redactLogFields };
  const GENERATED = new Date("2026-09-05T00:00:00.000Z");

  function journeyLine(
    seq: number,
    correlationId: string,
    fields: Record<string, unknown>,
  ): string {
    return line({ ts: T0, pid: 9001, instanceId: "a0b0c0d0", seq, correlationId, ...fields });
  }

  describe("a successful journey across every phase", () => {
    const CORRELATION_ID = "journey-success-0001";
    const SUCCESS_LINES: readonly string[] = [
      journeyLine(1, CORRELATION_ID, {
        category: "security",
        op: "coding-context.github-remote.evaluated",
        outcome: "clean",
      }),
      journeyLine(2, CORRELATION_ID, {
        category: "process",
        op: "git-change.chat.connected",
        relationshipId: "rel-1",
        remoteDigestPrefix: "abcd1234",
        fileCount: 3,
        hasPullRequest: false,
      }),
      journeyLine(3, CORRELATION_ID, {
        category: "security",
        op: "coding-context.github-authorization.evaluated",
        decision: "authorized",
        authorized: true,
        repositoryId: "repo-1",
        revision: 3,
      }),
      journeyLine(4, CORRELATION_ID, {
        category: "security",
        op: "git.delivery.authority.admitted",
        status: 200,
        operation: "commit",
        phase: "admission",
        runId: "run-42",
      }),
      journeyLine(5, CORRELATION_ID, {
        category: "security",
        op: "git.delivery.buffers.checked",
        state: "clean",
        editorSessionCount: 0,
        dirtySessionCount: 0,
      }),
      journeyLine(6, CORRELATION_ID, {
        category: "security",
        op: "git.delivery.commit.approval.minted",
        status: 200,
        operation: "commit",
        runId: "run-42",
      }),
      journeyLine(7, CORRELATION_ID, {
        category: "diagnostic",
        op: "git.delivery.mutation.completed",
        actionId: "action-1",
        actionKind: "commit",
        status: "completed",
        phaseReached: "committed",
        policyOutcome: "allow",
        preflightFindingCount: 0,
        preflightBlockingCount: 0,
        requiredApproverCount: 0,
      }),
      journeyLine(8, CORRELATION_ID, {
        category: "security",
        op: "git.delivery.push.approval.minted",
        status: 200,
        operation: "push",
        runId: "run-42",
      }),
      journeyLine(9, CORRELATION_ID, {
        category: "diagnostic",
        op: "git.delivery.mutation.completed",
        actionId: "action-2",
        actionKind: "push",
        status: "completed",
        phaseReached: "pushed",
        policyOutcome: "allow",
        preflightFindingCount: 0,
        preflightBlockingCount: 0,
        requiredApproverCount: 0,
      }),
      journeyLine(10, CORRELATION_ID, {
        category: "security",
        op: "git.delivery.pr.approval.minted",
        status: 200,
        operation: "pr",
        runId: "run-42",
      }),
      journeyLine(11, CORRELATION_ID, {
        category: "diagnostic",
        op: "git.delivery.mutation.completed",
        actionId: "action-3",
        actionKind: "pr-create",
        status: "completed",
        phaseReached: "pr-created",
        policyOutcome: "allow",
        preflightFindingCount: 0,
        preflightBlockingCount: 0,
        requiredApproverCount: 0,
      }),
      journeyLine(12, CORRELATION_ID, {
        category: "process",
        op: "git.delivery.readiness.observed",
        state: "observed",
        providerError: false,
        count: 5,
      }),
      // #3389: draft PR -> ready (mark-ready) — the mint half of the approval pair, then a
      // successful execution of the governed mutation itself.
      journeyLine(13, CORRELATION_ID, {
        category: "security",
        op: "git.delivery.pr-mark-ready.approval.minted",
        runId: "run-42",
        prExternalId: "pr-7",
      }),
      journeyLine(14, CORRELATION_ID, {
        category: "process",
        op: "git.delivery.pr-mark-ready.executed",
        prExternalId: "pr-7",
        outcome: "succeeded",
      }),
      // Chat's description-generation admission gate, ahead of the Model Gateway.
      journeyLine(15, CORRELATION_ID, {
        category: "security",
        op: "pr-description.chat.turn.admitted",
        relationshipId: "rel-1",
      }),
      journeyLine(16, CORRELATION_ID, {
        category: "process",
        op: "git.pr-description",
        phase: "apply",
        reason: "applied",
        state: "current",
        effect: "confirmed",
        snapshotDigest: "sha256:snap1",
        artifactDigest: "sha256:art1",
        bodyDigest: "sha256:body1",
      }),
      journeyLine(17, CORRELATION_ID, {
        category: "process",
        op: "git.pr-description.receipt",
        phase: "record",
        revision: 1,
        state: "current",
        scopeDigest: "sha256:scope1",
      }),
      journeyLine(18, CORRELATION_ID, {
        category: "process",
        op: "git.journey-observation",
        phase: "observed",
        runId: "run-42",
        reason: "human-review-ready",
        state: "ready-for-human-review",
        evidenceRef: "journey-abc123",
        headSha: "abc123def456",
        merged: false,
        unresolvedCount: 0,
        issueState: "open",
        descriptionState: "current",
        complete: true,
      }),
      journeyLine(19, CORRELATION_ID, {
        category: "process",
        op: "git.journey-outcome.recorded",
        runId: "run-42",
        state: "ready-for-human-review",
        reason: "human-review-ready",
        recorded: true,
      }),
    ];
    const TEXT = `${SUCCESS_LINES.join("\n")}\n`;

    it("has clusters recognising every issue-to-PR journey op, and hasIssueToPrJourneyOps reports it", () => {
      const basic = analyzeLogText(TEXT);
      expect(hasIssueToPrJourneyOps(basic)).toBe(true);
      const mutationCluster = basic.clusters.find(
        (cluster) => cluster.op === "git.delivery.mutation.completed",
      );
      expect(mutationCluster?.count).toBe(3);
      expect(mutationCluster?.sampleCorrelationIds).toEqual([CORRELATION_ID]);
    });

    it("reports no journey ops for a log that carries none", () => {
      expect(hasIssueToPrJourneyOps(analyzeLogText(FIXTURE_TEXT))).toBe(false);
    });

    // These four ops are correctly mapped in JOURNEY_OP_PHASE but, unlike the ops above, are not
    // otherwise exercised by the success/blocked fixtures — a standalone correlation covers them.
    it("recognises the coding-repository-handler and coding-context.github op families", () => {
      const correlationId = "journey-search-authz-0006";
      const text =
        [
          journeyLine(1, correlationId, {
            category: "search",
            op: "coding-repository-handler.started",
          }),
          journeyLine(2, correlationId, {
            category: "search",
            op: "coding-repository-handler.settled",
            state: "completed",
            reason: "none",
            resultCount: 3,
          }),
          journeyLine(3, correlationId, {
            category: "process",
            op: "coding-context.github.read",
            outcome: "succeeded",
            byteCount: 128,
          }),
          journeyLine(4, correlationId, {
            category: "security",
            op: "coding-context.github-authorization.changed",
            repositoryId: "repo-1",
            authorized: true,
            revision: 4,
          }),
        ].join("\n") + "\n";

      const seed = buildReproductionSeed(text, correlationId, GENERATED, OPTIONS);
      const steps = seed?.issueToPrJourney?.steps ?? [];

      expect(steps).toHaveLength(4);
      expect(steps[0]).toMatchObject({ phase: "intake", op: "coding-repository-handler.started" });
      expect(steps[1]).toMatchObject({
        phase: "intake",
        op: "coding-repository-handler.settled",
        status: "completed",
        reason: "none",
      });
      expect(steps[2]).toMatchObject({
        phase: "intake",
        op: "coding-context.github.read",
        status: "succeeded",
      });
      expect(steps[3]).toMatchObject({
        phase: "authority",
        op: "coding-context.github-authorization.changed",
      });
    });

    // #3401 review finding 20: the coding-runtime automatic-description dispatch lifecycle logged
    // through a template-literal `op` (`coding-runtime.description.${event}`) that this journey's
    // phase map could not recognise under any name. Failing before the `JOURNEY_OP_PHASE` mapping
    // is added: `phaseForLine` returns `undefined` for the fixed `coding-runtime.description` op
    // below and the line never becomes a step at all (`steps` stays empty).
    it("recognises the coding-runtime.description dispatch-lifecycle op as the description phase", () => {
      const correlationId = "journey-description-dispatch-0007";
      const text =
        journeyLine(1, correlationId, {
          category: "process",
          op: "coding-runtime.description",
          runId: "run-42",
          event: "blocked",
          reason: "provider-failed",
          errorKind: "Error",
        }) + "\n";

      const seed = buildReproductionSeed(text, correlationId, GENERATED, OPTIONS);
      const steps = seed?.issueToPrJourney?.steps ?? [];

      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        phase: "description",
        op: "coding-runtime.description",
        reason: "provider-failed",
        errorKind: "Error",
      });
    });

    it("reconstructs one timeline covering every phase, in order, with the closed-vocabulary values verbatim", () => {
      const seed = buildReproductionSeed(TEXT, CORRELATION_ID, GENERATED, OPTIONS);
      const journey = seed?.issueToPrJourney;

      expect(journey?.steps).toHaveLength(19);
      expect(journey?.phasesObserved).toEqual([
        "intake",
        "authority",
        "commit",
        "push",
        "pr",
        "readiness",
        "description",
        "outcome",
      ]);
      expect(journey?.redactionViolationCount).toBe(0);
      expect(journey?.steps.every((step) => step.redactionVerified)).toBe(true);
    });

    it("maps each step's status/reason/digests off the real emitter's own extra fields, never inventing one", () => {
      const seed = buildReproductionSeed(TEXT, CORRELATION_ID, GENERATED, OPTIONS);
      const steps = seed?.issueToPrJourney?.steps ?? [];

      expect(steps[6]).toMatchObject({
        phase: "commit",
        op: "git.delivery.mutation.completed",
        status: "completed",
      });
      expect(steps[12]).toMatchObject({
        phase: "readiness",
        op: "git.delivery.pr-mark-ready.approval.minted",
        digests: { runId: "run-42", prExternalId: "pr-7" },
      });
      expect(steps[13]).toMatchObject({
        phase: "readiness",
        op: "git.delivery.pr-mark-ready.executed",
        status: "succeeded",
        digests: { prExternalId: "pr-7" },
      });
      expect(steps[14]).toMatchObject({
        phase: "description",
        op: "pr-description.chat.turn.admitted",
        digests: { relationshipId: "rel-1" },
      });
      expect(steps[15]).toMatchObject({
        phase: "description",
        op: "git.pr-description",
        status: "current",
        reason: "applied",
        digests: {
          snapshotDigest: "sha256:snap1",
          artifactDigest: "sha256:art1",
          bodyDigest: "sha256:body1",
        },
      });
      expect(steps[17]).toMatchObject({
        phase: "outcome",
        op: "git.journey-observation",
        status: "ready-for-human-review",
        reason: "human-review-ready",
        digests: {
          runId: "run-42",
          evidenceRef: "journey-abc123",
          headSha: "abc123def456",
        },
      });
      expect(steps[18]).toMatchObject({
        phase: "outcome",
        op: "git.journey-outcome.recorded",
        status: "ready-for-human-review",
        reason: "human-review-ready",
        digests: { runId: "run-42" },
      });
    });

    it("carries the journey in the human rendering and the seed's warnings never flag it as missing or unverified", () => {
      const seed = buildReproductionSeed(TEXT, CORRELATION_ID, GENERATED, OPTIONS);
      if (seed === undefined) throw new Error("expected a seed for a known correlationId");

      const rendered = renderHumanReproductionSeed(seed);

      expect(rendered).toContain("issueToPrJourney:");
      expect(seed.warnings.some((warning) => warning.includes("no redaction verifier"))).toBe(
        false,
      );
      expect(
        seed.warnings.some((warning) => warning.includes("issue-to-PR journey evidence")),
      ).toBe(false);
    });
  });

  describe("a blocked and failed journey", () => {
    const CORRELATION_ID = "journey-blocked-0002";
    const BLOCKED_LINES: readonly string[] = [
      journeyLine(1, CORRELATION_ID, {
        category: "security",
        op: "git.delivery.authority.denied",
        status: 403,
        operation: "push",
        phase: "admission",
        reason: "authority-changed",
      }),
      journeyLine(2, CORRELATION_ID, {
        category: "security",
        op: "git.delivery.commit.approval.required",
        status: 200,
        operation: "commit",
        runId: "run-99",
      }),
      journeyLine(3, CORRELATION_ID, {
        category: "diagnostic",
        op: "git.delivery.mutation.failed",
        errorKind: "WORKSPACE_UNAVAILABLE",
        actionKind: "commit",
        phaseReached: "snapshot",
      }),
      journeyLine(4, CORRELATION_ID, {
        category: "security",
        op: "git.delivery.dispatch.no-spawn",
        status: 403,
        operation: "push",
      }),
      journeyLine(5, CORRELATION_ID, {
        category: "process",
        op: "git.delivery.readiness.observed",
        level: "warn",
        errorKind: "internal",
        state: "unknown",
        providerError: true,
        count: 0,
      }),
      // #3389: mark-ready blocked on approval, then the branch moved under it (drift) — the
      // precondition-failed variant of the mutation, never folded into `.executed`.
      journeyLine(6, CORRELATION_ID, {
        category: "security",
        op: "git.delivery.pr-mark-ready.approval.required",
        runId: "run-99",
        prExternalId: "pr-9",
      }),
      journeyLine(7, CORRELATION_ID, {
        category: "process",
        op: "git.delivery.pr-mark-ready.drift",
        prExternalId: "pr-9",
        outcome: "failed",
      }),
      journeyLine(8, CORRELATION_ID, {
        category: "security",
        op: "pr-description.chat.turn.denied",
        errorKind: "authority-denied",
        relationshipId: "rel-9",
      }),
      journeyLine(9, CORRELATION_ID, {
        category: "process",
        op: "git.pr-description",
        level: "warn",
        errorKind: "internal",
        phase: "approval",
        reason: "approval-required",
        state: "blocked",
        effect: "none",
      }),
      journeyLine(10, CORRELATION_ID, {
        category: "process",
        op: "git.journey-observation",
        phase: "unavailable",
        runId: "run-99",
        reason: "authority-denied",
      }),
    ];
    const TEXT = `${BLOCKED_LINES.join("\n")}\n`;

    it("reconstructs the blocked/failed phases with the emitter's own reasons, never a happy-path label", () => {
      const seed = buildReproductionSeed(TEXT, CORRELATION_ID, GENERATED, OPTIONS);
      const steps = seed?.issueToPrJourney?.steps ?? [];

      expect(seed?.issueToPrJourney?.phasesObserved).toEqual([
        "authority",
        "commit",
        "push",
        "readiness",
        "description",
        "outcome",
      ]);
      expect(steps[0]).toMatchObject({ phase: "authority", reason: "authority-changed" });
      expect(steps[1]).toMatchObject({ phase: "commit", digests: { runId: "run-99" } });
      expect(steps[2]).toMatchObject({
        phase: "commit",
        op: "git.delivery.mutation.failed",
        errorKind: "WORKSPACE_UNAVAILABLE",
      });
      expect(steps[3]).toMatchObject({ phase: "push", op: "git.delivery.dispatch.no-spawn" });
      expect(steps[4]).toMatchObject({
        phase: "readiness",
        status: "unknown",
        errorKind: "internal",
      });
      expect(steps[5]).toMatchObject({
        phase: "readiness",
        op: "git.delivery.pr-mark-ready.approval.required",
        digests: { runId: "run-99", prExternalId: "pr-9" },
      });
      expect(steps[6]).toMatchObject({
        phase: "readiness",
        op: "git.delivery.pr-mark-ready.drift",
        status: "failed",
        digests: { prExternalId: "pr-9" },
      });
      expect(steps[7]).toMatchObject({
        phase: "description",
        op: "pr-description.chat.turn.denied",
        errorKind: "authority-denied",
        digests: { relationshipId: "rel-9" },
      });
      expect(steps[8]).toMatchObject({
        phase: "description",
        status: "blocked",
        reason: "approval-required",
      });
      expect(steps[9]).toMatchObject({
        phase: "outcome",
        status: "unavailable",
        reason: "authority-denied",
        digests: { runId: "run-99" },
      });
    });
  });

  describe("redaction re-verification", () => {
    it("withholds a step's content and reports it unverified when no redactor is supplied at all", () => {
      const correlationId = "journey-unverified-0003";
      const text = `${journeyLine(1, correlationId, {
        category: "security",
        op: "git.delivery.commit.approval.minted",
        status: 200,
        operation: "commit",
        runId: "run-1",
      })}\n`;

      const seed = buildReproductionSeed(text, correlationId, GENERATED);
      const steps = seed?.issueToPrJourney?.steps ?? [];

      expect(steps).toHaveLength(1);
      expect(steps[0]).toEqual({
        phase: "commit",
        op: "git.delivery.commit.approval.minted",
        ts: T0,
        redactionVerified: false,
      });
      expect(seed?.warnings.some((warning) => warning.includes("no redaction verifier"))).toBe(
        true,
      );
    });

    // The negative case this reconstruction exists to fail closed against: a line whose `extra`
    // carries a body-bearing field (here, a denylisted "title" holding actual PR-description
    // prose) under a name this reconstruction never asked for. `redactLogFields` — the SAME choke
    // point the activity-log sink itself writes through — catches it exactly as it would at write
    // time: the raw value differs from its re-verified value, so it is reported as a violation
    // and withheld, never rendered, in either the machine seed or the human text.
    it("reports a body-bearing extra field as a redaction violation instead of rendering it", () => {
      const correlationId = "journey-violation-0004";
      const leakedTitle = "Fix the login crash that happens after retrying twice";
      const text = `${journeyLine(1, correlationId, {
        category: "process",
        op: "git.pr-description",
        phase: "apply",
        reason: "applied",
        state: "current",
        effect: "confirmed",
        snapshotDigest: "sha256:snap1",
        title: leakedTitle,
      })}\n`;

      const seed = buildReproductionSeed(text, correlationId, GENERATED, {
        toolDiagnosticRedactor: redactLogFields,
      });
      const step = seed?.issueToPrJourney?.steps[0];

      expect(step?.redactionViolations).toEqual(["title"]);
      expect(seed?.issueToPrJourney?.redactionViolationCount).toBe(1);
      // The rest of the line's legitimate fields still reconstruct normally — one violating field
      // never blocks the rest of the evidence.
      expect(step).toMatchObject({ status: "current", reason: "applied" });
      expect(seed?.warnings.some((warning) => warning.includes("1 issueToPrJourney step"))).toBe(
        true,
      );

      // Scoped to `issueToPrJourney` — this reconstruction's own surface — not the whole seed:
      // `seed.timeline` is a faithful transcript of whatever the log actually said (trusting the
      // activity-log SINK's own redaction at write time, exactly like every other line in this
      // file's timelines), so a line hand-constructed to simulate a hostile/corrupted log still
      // carries the raw field there. `issueToPrJourney` is the one surface this feature adds that
      // re-verifies before rendering, and it is what must never carry the leaked text.
      if (seed === undefined) throw new Error("expected a seed for a known correlationId");
      const rendered = renderHumanReproductionSeed(seed);
      expect(JSON.stringify(seed.issueToPrJourney)).not.toContain(leakedTitle);
      expect(rendered).not.toContain(leakedTitle);
    });
  });

  it("names the standing gap when a timeline carries none of these ops at all", () => {
    const correlationId = "no-journey-ops-0005";
    const text = `${journeyLine(1, correlationId, { category: "http", op: "a" })}\n`;

    const seed = buildReproductionSeed(text, correlationId, GENERATED, OPTIONS);

    expect(seed?.issueToPrJourney).toBeUndefined();
    expect(seed?.warnings.some((warning) => warning.includes("issue-to-PR journey evidence"))).toBe(
      true,
    );
  });
});
