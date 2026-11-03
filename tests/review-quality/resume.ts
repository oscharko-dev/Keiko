// Resuming an interrupted offline gate run (Issue #4138). The review service stores every review
// it settles, so a run stopped between reviews loses nothing it measured: a resumed run with the
// same set, variant and models reuses each stored review of the original run and reviews the rest.
// Two settlements carry no measurement and are reviewed again: `abandoned/interrupted`, which the
// stop itself causes, and `skipped/model-unavailable`, which a model the review never reached
// causes. A stored review is reused only when its pair and its exact base and head commits match.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GateModels } from "./ports.js";

export interface ReviewCommits {
  readonly baseSha: string;
  readonly headSha: string;
}

/** Finds the stored review a resumed run reuses for one case; `undefined` reviews it again. */
export interface GateResume {
  readonly sinceMs: number;
  readonly reusableRun: (caseKey: string, commits: ReviewCommits) => string | undefined;
  readonly close: () => void;
}

const SQL_LATEST = `SELECT run_id, settlement_kind, settlement_reason, base_sha, head_sha,
  reviewer_model_id, counter_checker_model_id FROM review_runs
  WHERE client_request_id LIKE ? ESCAPE '\\' AND created_at >= ? AND phase = 'settled'
  ORDER BY created_at DESC, run_id DESC LIMIT 1`;

const NOT_MEASURED: ReadonlySet<string> = new Set([
  "abandoned/interrupted",
  "skipped/model-unavailable",
]);

/** The gate's client request ids are `review-gate-<caseKey>-<startedAt>`. */
export function clientRequestPattern(caseKey: string): string {
  return `review-gate-${caseKey.replace(/[\\%_]/g, (char) => `\\${char}`)}-%`;
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
export function openGateResume(stateDir: string, sinceMs: number, models: GateModels): GateResume {
  const db = new DatabaseSync(join(stateDir, "ui", "keiko-ui.db"), { readOnly: true });
  const latest = db.prepare(SQL_LATEST);
  return {
    sinceMs,
    reusableRun: (caseKey, commits): string | undefined => {
      const row = latest.get(clientRequestPattern(caseKey), sinceMs) as
        Record<string, unknown> | undefined;
      if (row === undefined || !reusable(row, models, commits)) return undefined;
      return column(row, "run_id") ?? undefined;
    },
    close: (): void => {
      db.close();
    },
  };
}
