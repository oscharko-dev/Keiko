import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLogEventRegistration } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createFileServerLogSink, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  emitIndexingActivity,
  type IndexingActivity,
} from "../packages/keiko-local-knowledge/src/indexing/orchestrator-activity-log.js";
import {
  emitEmbeddingActivity,
  type EmbeddingActivity,
} from "../packages/keiko-local-knowledge/src/indexing/embedding-activity-log.js";
import {
  emitPreflightActivity,
  type PreflightActivity,
} from "../packages/keiko-local-knowledge/src/indexing/preflight-activity-log.js";
import type {
  KnowledgeLogEvent,
  KnowledgeLogSink,
} from "../packages/keiko-local-knowledge/src/knowledge-log.js";
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

const DIGEST = "0123456789abcdef";
const CONTEXT = {
  jobId: "indexing-query-fixture",
  capsuleIdDigest: DIGEST,
  documentIdDigest: DIGEST,
};
type SourceCompleted = Extract<IndexingActivity, { readonly op: "indexing.source.completed" }>;

function sourceCompleted(overrides: Partial<SourceCompleted> = {}): SourceCompleted {
  return {
    op: "indexing.source.completed",
    context: CONTEXT,
    sourceIdDigest: DIGEST,
    durationMs: 10,
    discoveredCount: 100,
    failedCount: 0,
    walkCompleted: true,
    cancelled: false,
    sawScopeError: false,
    ...overrides,
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

function captured(emit: (sink: KnowledgeLogSink) => void): readonly KnowledgeLogEvent[] {
  const events: KnowledgeLogEvent[] = [];
  emit({
    write: (event): void => {
      events.push(event);
    },
  });
  return events;
}

function indexing(event: IndexingActivity): readonly KnowledgeLogEvent[] {
  return captured((sink) => {
    emitIndexingActivity(sink, event);
  });
}

describe("manual support selection of actual indexing emitters", () => {
  let stateDir: string;
  let sink: ServerLogSink;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-support-indexing-selection-"));
    sink = createFileServerLogSink(stateDir, { level: "debug" });
    // Open the writer before the observed job, so its storage-readiness evidence cannot
    // accidentally retain this job through the first append's correlation.
    emitEmbeddingActivity(sink, undefined, {
      op: "embedding.batch.grouped",
      uniqueChunkCount: 10,
      batchCount: 2,
      concurrency: 1,
    });
  });
  afterEach(() => {
    sink.close?.();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function selected(events: readonly KnowledgeLogEvent[], op: string): boolean {
    for (const event of events) sink.write(event);
    sink.flush?.();
    return query(stateDir).events.some((entry) => entry.parsed.view.op === op);
  }

  it.each([
    { failedCount: 1 },
    { walkCompleted: false },
    { cancelled: true },
    { sawScopeError: true },
  ])("declares the real informational source completion diagnostic: %j", (state) => {
    const events = indexing(sourceCompleted(state));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "info",
      extra: { ...state, completeness: "complete", loss: "none" },
    });
    expect(events[0]?.errorKind).toBeUndefined();
    expect(activityLogEventRegistration(events[0] ?? {})).toMatchObject({
      diagnosticWhen: [
        { field: "failedCount", positive: true },
        { field: "walkCompleted", values: [false] },
        { field: "cancelled", values: [true] },
        { field: "sawScopeError", values: [true] },
      ],
    });
  });

  it.each([
    { failedCount: 1 },
    { walkCompleted: false },
    { cancelled: true },
    { sawScopeError: true },
  ])("retains the real incomplete source completion under zero optional context: %j", (state) => {
    expect(selected(indexing(sourceCompleted(state)), "indexing.source.completed")).toBe(true);
  });

  it("keeps a healthy source completion with positive discovery/duration counts optional", () => {
    expect(selected(indexing(sourceCompleted()), "indexing.source.completed")).toBe(false);
  });

  it.each(["succeeded", "cancelled", "failed"] as const)(
    "classifies actual job completion %s through existing severity",
    (jobStatus) => {
      const events = indexing({
        op: "indexing.job.finished",
        context: CONTEXT,
        jobStatus,
        durationMs: 10,
        totalDocuments: 100,
        processedDocuments: 100,
        failedDocuments: 0,
        skippedDocuments: 0,
        vectorsPersisted: 1000,
      });
      expect(events[0]?.level).toBe(
        jobStatus === "succeeded" ? "info" : jobStatus === "failed" ? "error" : "warn",
      );
      expect(selected(events, "indexing.job.finished")).toBe(jobStatus !== "succeeded");
    },
  );

  it("retains an overall successful job's actual partial failure kind", () => {
    const events = indexing({
      op: "indexing.job.finished",
      context: CONTEXT,
      jobStatus: "succeeded",
      durationMs: 10,
      totalDocuments: 100,
      processedDocuments: 99,
      failedDocuments: 1,
      skippedDocuments: 0,
      vectorsPersisted: 990,
      failureKind: "DISCOVERY_FAILED:READ_FAILED",
    });
    expect(events[0]).toMatchObject({ level: "info", errorKind: "read-failed" });
    expect(selected(events, "indexing.job.finished")).toBe(true);
  });

  it.each(["unchanged", "unsupported", "transient-read-failure"] as const)(
    "distinguishes actual document skip %s from a failed reread",
    (reason) => {
      const events = indexing({
        op: "indexing.document.skipped",
        context: CONTEXT,
        reason,
        skippedDocuments: 100,
        preservedChunkCount: 20,
        ...(reason === "transient-read-failure" ? { failureKind: "READ_FAILED" } : {}),
      });
      expect(selected(events, "indexing.document.skipped")).toBe(
        reason === "transient-read-failure",
      );
    },
  );

  it.each([
    {
      op: "embedding.chunk.retry",
      attempt: 1,
      maxRetries: 3,
      transport: "scalar",
      failureKind: "timeout",
    },
    {
      op: "embedding.batch.retry",
      attempt: 1,
      maxRetries: 3,
      delayMs: 1,
      zeroProgressRetries: 0,
      remainingCount: 10,
      completedCount: 0,
      transport: "array-batch",
      failureKind: "unavailable",
    },
    {
      op: "embedding.batch.partial-progress",
      attempt: 1,
      maxRetries: 3,
      delayMs: 1,
      zeroProgressRetries: 0,
      remainingCount: 9,
      completedCount: 1,
      transport: "array-batch",
      failureKind: "unavailable",
    },
  ] satisfies readonly EmbeddingActivity[])("retains actual embedding retry $op", (event) => {
    const events = captured((log) => {
      emitEmbeddingActivity(log, CONTEXT, event);
    });
    expect(events[0]).toMatchObject({ level: "warn", extra: { failureKind: event.failureKind } });
    expect(selected(events, event.op)).toBe(true);
  });

  it.each([
    {
      op: "embedding.preflight.completed",
      observedDimensions: 1536,
      durationMs: 80,
      providerDigest: DIGEST,
      modelIdDigest: DIGEST,
      expectedDimensions: 1536,
      fingerprinted: true,
    },
    {
      op: "embedding.preflight.cache-hit",
      cached: true,
      providerDigest: DIGEST,
      modelIdDigest: DIGEST,
      fingerprinted: true,
    },
    {
      op: "embedding.preflight.identity-adopted",
      observedDimensions: 1536,
      providerDigest: DIGEST,
    },
    {
      op: "embedding.preflight.identity-refreshed",
      observedDimensions: 768,
      providerDigest: DIGEST,
    },
  ] satisfies readonly PreflightActivity[])(
    "keeps actual successful preflight metadata $op optional",
    (event) => {
      const events = captured((log) => {
        emitPreflightActivity(log, CONTEXT, event);
      });
      expect(selected(events, event.op)).toBe(false);
    },
  );
});
