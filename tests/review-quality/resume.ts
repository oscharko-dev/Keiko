// Resuming an interrupted offline gate run (Issue #4138). The review service stores every review
// it settles, so a run stopped between reviews loses nothing it measured. A resumed run reuses a
// stored review only when the review's client request id carries the run's reuse key, which joins
// the configuration digest (set, variant, models, budgets and review code) and the composition
// digest (every other package the pipeline runs). A change to any of those therefore reviews every
// case again. Two settlements carry no measurement and are reviewed again: `abandoned/interrupted`,
// which the stop itself causes, and `skipped/model-unavailable`, which a model the review never
// reached causes. A stored review is reused only when its pair and its exact base and head commits
// match.
//
// Reviews stored before the reuse key existed have ids without it (`review-gate-<caseKey>-...`).
// They are reused only when the operator passes their configuration digest explicitly and it
// equals the current one; the composition of those reviews is then the operator's checked claim.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GateModels } from "./ports.js";

interface ReviewCommits {
  readonly baseSha: string;
  readonly headSha: string;
}

/** Finds the stored review a resumed run reuses for one case; `undefined` reviews it again. */
export interface GateResume {
  readonly sinceMs: number;
  readonly reusableRun: (caseKey: string, commits: ReviewCommits) => string | undefined;
  readonly close: () => void;
}

export interface GateResumeOptions {
  readonly sinceMs: number;
  readonly models: GateModels;
  readonly reuseKey: string;
  /** Whether reviews stored without a reuse key may be reused (see the header). */
  readonly acceptLegacy: boolean;
}

const SQL_LATEST = `SELECT run_id, settlement_kind, settlement_reason, base_sha, head_sha,
  reviewer_model_id, counter_checker_model_id FROM review_runs
  WHERE client_request_id LIKE ? ESCAPE '\\' AND created_at >= ? AND phase = 'settled'
  ORDER BY created_at DESC, run_id DESC LIMIT 1`;

const NOT_MEASURED: ReadonlySet<string> = new Set([
  "abandoned/interrupted",
  "skipped/model-unavailable",
]);

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The gate's client request id for one review: `review-gate-<reuseKey>-<caseKey>-<startedAt>`. */
export function gateClientRequestId(reuseKey: string, caseKey: string, startedAt: number): string {
  return `review-gate-${reuseKey}-${caseKey}-${String(startedAt)}`;
}

/** Matches the client request ids of one case under one reuse key. */
export function clientRequestPattern(reuseKey: string, caseKey: string): string {
  return `review-gate-${escapeLike(reuseKey)}-${escapeLike(caseKey)}-%`;
}

/** Matches the ids stored before the reuse key existed: `review-gate-<caseKey>-<startedAt>`. */
export function legacyClientRequestPattern(caseKey: string): string {
  return `review-gate-${escapeLike(caseKey)}-%`;
}

function column(row: Record<string, unknown>, name: string): string | null {
  const value = row[name];
  return typeof value === "string" ? value : null;
}

function reusable(
  row: Record<string, unknown>,
  models: GateModels,
  commits: ReviewCommits,
): boolean {
  const settlement = `${column(row, "settlement_kind") ?? ""}/${column(row, "settlement_reason") ?? ""}`;
  return (
    !NOT_MEASURED.has(settlement) &&
    column(row, "reviewer_model_id") === models.reviewerModelId &&
    column(row, "counter_checker_model_id") === models.counterCheckerModelId &&
    column(row, "base_sha") === commits.baseSha &&
    column(row, "head_sha") === commits.headSha
  );
}

/** Opens the review store of the gate's state directory read-only. */
export function openGateResume(stateDir: string, options: GateResumeOptions): GateResume {
  const db = new DatabaseSync(join(stateDir, "ui", "keiko-ui.db"), { readOnly: true });
  const latest = db.prepare(SQL_LATEST);
  const latestRow = (pattern: string): Record<string, unknown> | undefined =>
    latest.get(pattern, options.sinceMs);
  return {
    sinceMs: options.sinceMs,
    reusableRun: (caseKey, commits): string | undefined => {
      // A keyed review is newer than any legacy one, so it decides alone when it exists.
      const row =
        latestRow(clientRequestPattern(options.reuseKey, caseKey)) ??
        (options.acceptLegacy ? latestRow(legacyClientRequestPattern(caseKey)) : undefined);
      if (row === undefined || !reusable(row, options.models, commits)) return undefined;
      return column(row, "run_id") ?? undefined;
    },
    close: (): void => {
      db.close();
    },
  };
}
