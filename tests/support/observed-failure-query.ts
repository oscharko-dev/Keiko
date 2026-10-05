import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileServerLogSink, type ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  runSupportQuery,
  type SupportQueryResult,
} from "../../packages/keiko-activity-log/src/reader/support-query.js";
import {
  ActivityLogScanner,
  ensureSegmentManifests,
  listActivityLogStoreFiles,
} from "../../packages/keiko-activity-log/src/reader/support-segment-scan.js";
import { emitEmbeddingActivity } from "../../packages/keiko-local-knowledge/src/indexing/embedding-activity-log.js";

/** Exercise actual producer records through the writer, scanner and context-exhausted query. */
export function observedFailureQuery(events: readonly ServerLogEvent[]): SupportQueryResult {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-observed-failure-query-"));
  const sink = createFileServerLogSink(stateDir, { level: "debug" });
  try {
    // Keep the writer's own initial readiness outside the observed request's correlation.
    emitEmbeddingActivity(sink, undefined, {
      op: "embedding.batch.grouped",
      uniqueChunkCount: 1,
      batchCount: 1,
      concurrency: 1,
    });
    for (const event of events) sink.write(event);
    sink.flush?.();
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
  } finally {
    sink.close?.();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
