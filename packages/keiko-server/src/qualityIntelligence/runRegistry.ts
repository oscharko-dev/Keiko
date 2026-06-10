// Quality Intelligence in-memory active-run registry (Epic #270, Issue #273/#280).
//
// Tracks runs that are CURRENTLY executing so the UI can (a) see a run as "running" in the run list
// before it lands in evidence and (b) cancel it. Completed runs live in evidence (restart-safe);
// the registry only holds in-flight runs and is intentionally process-local — on restart, in-flight
// runs are gone (they were never persisted) while completed runs survive. This is the QI counterpart
// of the harness RunRegistry, kept separate because QI runs carry the QI run-event envelope.

import type { QualityIntelligenceUiRunSummary } from "@oscharko-dev/keiko-contracts";

export type QiActiveRunStatus = "running" | "succeeded" | "failed" | "cancelled";

interface QiActiveRun {
  readonly runId: string;
  status: QiActiveRunStatus;
  readonly requestedAt: string;
  readonly controller: AbortController;
  totals: { candidates: number; findings: number; exports: number };
}

export class QiRunRegistry {
  private readonly runs = new Map<string, QiActiveRun>();

  /** Register a starting run and return its AbortController so the executor can wire cancellation. */
  register(runId: string, requestedAt: string): AbortController {
    const controller = new AbortController();
    this.runs.set(runId, {
      runId,
      status: "running",
      requestedAt,
      controller,
      totals: { candidates: 0, findings: 0, exports: 0 },
    });
    return controller;
  }

  updateTotals(runId: string, totals: Partial<QiActiveRun["totals"]>): void {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    run.totals = { ...run.totals, ...totals };
  }

  /** Mark terminal and drop the run from the active set (it is now durable in evidence). */
  complete(runId: string, status: Exclude<QiActiveRunStatus, "running">): void {
    const run = this.runs.get(runId);
    if (run !== undefined) run.status = status;
    this.runs.delete(runId);
  }

  /** Request cancellation. Returns false when the run is unknown/already finished. */
  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (run === undefined) return false;
    run.controller.abort();
    return true;
  }

  isActive(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Active-run summaries for merging into the run list (status always "running"). */
  listActiveSummaries(): readonly QualityIntelligenceUiRunSummary[] {
    return [...this.runs.values()].map((run) => ({
      id: run.runId,
      status: "running" as const,
      requestedAt: run.requestedAt,
      completedAt: null,
      totals: { ...run.totals },
    }));
  }

  /** Test seam: clear all active runs. */
  reset(): void {
    for (const run of this.runs.values()) run.controller.abort();
    this.runs.clear();
  }
}

// Process-local singleton shared by the start, cancel, and list routes.
export const qiRunRegistry = new QiRunRegistry();
