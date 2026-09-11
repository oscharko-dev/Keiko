// A designed evidence-retention sweep is activity, not a failure (F82, Coding Workbench run 28).
// When a store holds more manifests than its retention policy keeps (ADR-0010 D6), the newest-first
// sweep deletes the oldest ones and reports how many. That report used to travel the server
// diagnostic channel, which writes every record at error level with an error class, so an operator
// read a routine deletion as a fault. It is now one activity line per report, counts only, and every
// report from one observer registration (one retention pass) shares one correlation id (ADR-0173 D5).

import { randomUUID } from "node:crypto";
import type { ServerLogSink } from "./observability/server-log.js";
import { processServerLogSink } from "./process-log-sink.js";

/** The stores whose retention sweeps report deletions: code-owned labels, never caller text. */
export type EvidenceRetentionSource =
  | "browser-capture"
  | "chat-compaction-evidence"
  | "command-runner"
  | "container-runner"
  | "editor-verification-run"
  | "grounded-qa"
  | "grounded-qa-hybrid"
  | "grounded-qa-multi-source"
  | "run-engine"
  | "terminal-execution";

/**
 * The `onRetentionDeleted` callback for one store registration. Every deletion it reports lands as
 * a `process` line with its source and count, joinable under the observer's own correlation id.
 */
export function evidenceRetentionObserver(
  source: EvidenceRetentionSource,
  activityLog: ServerLogSink = processServerLogSink(),
): (deletedCount: number) => void {
  const correlationId = randomUUID();
  return (deletedCount: number): void => {
    activityLog.write({
      category: "process",
      op: "evidence.retention",
      correlationId,
      extra: { source, deletedCount },
    });
  };
}
