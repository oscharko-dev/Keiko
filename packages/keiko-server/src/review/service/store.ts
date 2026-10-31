// The Keiko for Quality review run records (ADR-0182 D6, Issue #4136), over the server's SQLite
// store (schema migration 55): one row per run, its coverage entries and its candidate findings.
// All SQL is module-scope constants with bound parameters. Paths and finding text are local
// product data for the UI; this module never logs. One unsettled run per repository is enforced by
// the `review_runs_active` unique index, so two concurrent starts can never both succeed.

import type { DatabaseSync } from "node:sqlite";

import type {
  CounterCheckVerdict,
  ReviewCoverageEntry,
  ReviewDiffCoverageList,
  ReviewDiffCoverageSummary,
  ReviewFindingReport,
  ReviewRoleTotals,
  ReviewRunPhase,
  ReviewRunSettlement,
  ReviewTargetRequest,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

export interface ReviewRunRow {
  readonly runId: string;
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly clientRequestId: string;
  readonly correlationId: string;
  readonly targetKind: ReviewTargetRequest["kind"];
  readonly pullRequestNumber: number | null;
  readonly baseSha: string | null;
  readonly headSha: string | null;
  readonly privateRefs: readonly string[];
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
  readonly gatewayGeneration: number | null;
  readonly rulesDigest: string | null;
  readonly phase: ReviewRunPhase;
  readonly createdAt: number;
  readonly settledAt: number | null;
  readonly coverage: ReviewDiffCoverageSummary | null;
  readonly settlement: ReviewRunSettlement | null;
  readonly candidateCount: number;
  readonly reviewer: ReviewRoleTotals;
  readonly counterChecker: ReviewRoleTotals;
}

export interface ReviewFindingRow {
  readonly fingerprint: string;
  readonly reviewerRank: number;
  readonly report: ReviewFindingReport;
  readonly verdict: CounterCheckVerdict | null;
  readonly evidenceInHead: boolean;
  readonly presented: boolean;
  readonly presentationRank: number | null;
}

export interface ReviewRunInsert {
  readonly runId: string;
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly clientRequestId: string;
  readonly correlationId: string;
  readonly target: ReviewTargetRequest;
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
  readonly gatewayGeneration: number | null;
  readonly createdAt: number;
}

export type ReviewRunInsertResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "active-exists"; readonly activeRunId: string }
  | { readonly ok: false; readonly reason: "duplicate-request"; readonly runId: string };

export interface ReviewRunSettle {
  readonly settlement: ReviewRunSettlement;
  readonly settledAt: number;
  readonly candidateCount: number;
  readonly reviewer: ReviewRoleTotals;
  readonly counterChecker: ReviewRoleTotals;
}

const PHASE_COLUMNS: Readonly<Partial<Record<ReviewRunPhase, string>>> = {
  reviewing:
    "UPDATE review_runs SET phase = ?, reviewing_at = ? WHERE run_id = ? AND phase != 'settled'",
  "counter-checking":
    "UPDATE review_runs SET phase = ?, counter_checking_at = ? WHERE run_id = ? AND phase != 'settled'",
  settling:
    "UPDATE review_runs SET phase = ?, settling_at = ? WHERE run_id = ? AND phase != 'settled'",
};

const SQL_INSERT = `INSERT INTO review_runs (run_id, repository_id, repository_root, client_request_id,
  correlation_id, target_kind, pull_request_number, reviewer_model_id, counter_checker_model_id,
  gateway_generation, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?)`;
const SQL_BY_REQUEST =
  "SELECT run_id FROM review_runs WHERE repository_id = ? AND client_request_id = ?";
const SQL_ACTIVE = "SELECT run_id FROM review_runs WHERE repository_id = ? AND phase != 'settled'";
const SQL_TARGET =
  "UPDATE review_runs SET base_sha = ?, head_sha = ?, private_refs_json = ? WHERE run_id = ?";
const SQL_RULES = "UPDATE review_runs SET rules_digest = ? WHERE run_id = ?";
const SQL_COVERAGE = "UPDATE review_runs SET coverage_json = ? WHERE run_id = ?";
const SQL_COVERAGE_ENTRY =
  "INSERT INTO review_coverage (run_id, ordinal, path, list, reason) VALUES (?, ?, ?, ?, ?)";
const SQL_FINDING = `INSERT INTO review_findings (run_id, fingerprint, reviewer_rank, report_json,
  verdict, verdict_reason, verdict_evidence_json, evidence_in_head, presented, presentation_rank)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SQL_SETTLE = `UPDATE review_runs SET phase = 'settled', settlement_kind = ?, settlement_reason = ?,
  settled_at = ?, candidate_count = ?, reviewer_prompt_count = ?, reviewer_completion_count = ?,
  reviewer_duration_ms = ?, counter_prompt_count = ?, counter_completion_count = ?,
  counter_duration_ms = ? WHERE run_id = ? AND phase != 'settled'`;
const SELECT_RUN = "SELECT * FROM review_runs";
const SQL_GET = `${SELECT_RUN} WHERE run_id = ?`;
const SQL_HISTORY = `${SELECT_RUN} WHERE repository_id = ? ORDER BY created_at DESC, run_id DESC LIMIT ?`;
const SQL_HISTORY_PR = `${SELECT_RUN} WHERE repository_id = ? AND pull_request_number = ?
  ORDER BY created_at DESC, run_id DESC LIMIT ?`;
const SQL_LATEST_PER_PR = `${SELECT_RUN} AS outer_run WHERE repository_id = ? AND target_kind = 'pull-request'
  AND run_id = (SELECT inner_run.run_id FROM review_runs AS inner_run
    WHERE inner_run.repository_id = outer_run.repository_id
      AND inner_run.pull_request_number = outer_run.pull_request_number
    ORDER BY inner_run.created_at DESC, inner_run.run_id DESC LIMIT 1)
  ORDER BY pull_request_number`;
const SQL_UNSETTLED = `${SELECT_RUN} WHERE phase != 'settled'`;
const SQL_DURATIONS = `SELECT settled_at - created_at AS duration FROM review_runs
  WHERE settlement_kind IN ('complete', 'incomplete') ORDER BY settled_at DESC LIMIT 50`;
const SQL_REFS = "SELECT private_refs_json FROM review_runs WHERE repository_root = ?";
const SQL_FINDINGS =
  "SELECT * FROM review_findings WHERE run_id = ? ORDER BY presented DESC, presentation_rank, reviewer_rank";
const SQL_COVERAGE_ENTRIES =
  "SELECT path, list, reason FROM review_coverage WHERE run_id = ? ORDER BY ordinal";

type Row = Readonly<Record<string, unknown>>;

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function int(row: Row, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : 0;
}

function nullableInt(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}

function parsed(value: string | null): unknown {
  return value === null ? null : (JSON.parse(value) as unknown);
}

function stringList(value: string | null): string[] {
  const list = parsed(value);
  return Array.isArray(list)
    ? list.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function settlementOf(row: Row): ReviewRunSettlement | null {
  const kind = nullableText(row, "settlement_kind");
  if (kind === null) return null;
  const reason = nullableText(row, "settlement_reason");
  return (reason === null ? { kind } : { kind, reason }) as ReviewRunSettlement;
}

function totals(row: Row, prefix: "reviewer" | "counter"): ReviewRoleTotals {
  return {
    promptTokens: int(row, `${prefix}_prompt_count`),
    completionTokens: int(row, `${prefix}_completion_count`),
    durationMs: int(row, `${prefix}_duration_ms`),
  };
}

function runFromRow(row: Row): ReviewRunRow {
  return {
    runId: text(row, "run_id"),
    repositoryId: text(row, "repository_id"),
    repositoryRoot: text(row, "repository_root"),
    clientRequestId: text(row, "client_request_id"),
    correlationId: text(row, "correlation_id"),
    targetKind: text(row, "target_kind") as ReviewTargetRequest["kind"],
    pullRequestNumber: nullableInt(row, "pull_request_number"),
    baseSha: nullableText(row, "base_sha"),
    headSha: nullableText(row, "head_sha"),
    privateRefs: stringList(nullableText(row, "private_refs_json")),
    reviewerModelId: text(row, "reviewer_model_id"),
    counterCheckerModelId: text(row, "counter_checker_model_id"),
    gatewayGeneration: nullableInt(row, "gateway_generation"),
    rulesDigest: nullableText(row, "rules_digest"),
    phase: text(row, "phase") as ReviewRunPhase,
    createdAt: int(row, "created_at"),
    settledAt: nullableInt(row, "settled_at"),
    coverage: parsed(nullableText(row, "coverage_json")) as ReviewDiffCoverageSummary | null,
    settlement: settlementOf(row),
    candidateCount: int(row, "candidate_count"),
    reviewer: totals(row, "reviewer"),
    counterChecker: totals(row, "counter"),
  };
}

function findingFromRow(row: Row): ReviewFindingRow {
  const verdictValue = nullableText(row, "verdict");
  const verdict =
    verdictValue === null
      ? null
      : ({
          findingFingerprint: text(row, "fingerprint"),
          verdict: verdictValue,
          reasonCode: text(row, "verdict_reason"),
          evidence: (parsed(nullableText(row, "verdict_evidence_json")) as unknown[] | null) ?? [],
        } as CounterCheckVerdict);
  return {
    fingerprint: text(row, "fingerprint"),
    reviewerRank: int(row, "reviewer_rank"),
    report: JSON.parse(text(row, "report_json")) as ReviewFindingReport,
    verdict,
    evidenceInHead: int(row, "evidence_in_head") === 1,
    presented: int(row, "presented") === 1,
    presentationRank: nullableInt(row, "presentation_rank"),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/** The review run store; every method is synchronous over the shared SQLite handle. */
export class ReviewRunStore {
  public constructor(private readonly db: DatabaseSync) {}

  private runIdWhere(sql: string, ...params: (string | number)[]): string | undefined {
    const row = this.db.prepare(sql).get(...params) as Row | undefined;
    return row === undefined ? undefined : text(row, "run_id");
  }

  public findByClientRequest(repositoryId: string, clientRequestId: string): string | undefined {
    return this.runIdWhere(SQL_BY_REQUEST, repositoryId, clientRequestId);
  }

  public activeRunId(repositoryId: string): string | undefined {
    return this.runIdWhere(SQL_ACTIVE, repositoryId);
  }

  /** Inserts a `preparing` run; refuses a second active run or a replayed request id. */
  public insert(run: ReviewRunInsert): ReviewRunInsertResult {
    const replayed = this.findByClientRequest(run.repositoryId, run.clientRequestId);
    if (replayed !== undefined) return { ok: false, reason: "duplicate-request", runId: replayed };
    try {
      this.db
        .prepare(SQL_INSERT)
        .run(
          run.runId,
          run.repositoryId,
          run.repositoryRoot,
          run.clientRequestId,
          run.correlationId,
          run.target.kind,
          run.target.kind === "pull-request" ? run.target.number : null,
          run.reviewerModelId,
          run.counterCheckerModelId,
          run.gatewayGeneration,
          run.createdAt,
        );
      return { ok: true };
    } catch (error) {
      const active = isUniqueViolation(error) ? this.activeRunId(run.repositoryId) : undefined;
      if (active === undefined) throw error;
      return { ok: false, reason: "active-exists", activeRunId: active };
    }
  }

  public setPhase(runId: string, phase: ReviewRunPhase, at: number): void {
    const sql = PHASE_COLUMNS[phase];
    if (sql !== undefined) this.db.prepare(sql).run(phase, at, runId);
  }

  public setTarget(
    runId: string,
    target: { readonly baseSha: string; readonly headSha: string },
    refs: readonly string[],
  ): void {
    this.db.prepare(SQL_TARGET).run(target.baseSha, target.headSha, JSON.stringify(refs), runId);
  }

  public setRulesDigest(runId: string, digest: string): void {
    this.db.prepare(SQL_RULES).run(digest, runId);
  }

  /** Records the coverage summary and every coverage entry of the diff package, in one transaction. */
  public setCoverage(
    runId: string,
    summary: ReviewDiffCoverageSummary,
    entries: readonly ReviewCoverageEntry[],
  ): void {
    this.transaction(() => {
      this.db.prepare(SQL_COVERAGE).run(JSON.stringify(summary), runId);
      const insert = this.db.prepare(SQL_COVERAGE_ENTRY);
      entries.forEach((entry, ordinal) => {
        insert.run(runId, ordinal, entry.path, entry.list, entry.reason ?? null);
      });
    });
  }

  /** Records every candidate finding and settles the run, in one transaction. */
  public settle(
    runId: string,
    findings: readonly ReviewFindingRow[],
    settle: ReviewRunSettle,
  ): void {
    this.transaction(() => {
      const insert = this.db.prepare(SQL_FINDING);
      for (const finding of findings) insertFinding(insert, runId, finding);
      const reason = settle.settlement.kind === "complete" ? null : settle.settlement.reason;
      this.db
        .prepare(SQL_SETTLE)
        .run(
          settle.settlement.kind,
          reason,
          settle.settledAt,
          settle.candidateCount,
          settle.reviewer.promptTokens,
          settle.reviewer.completionTokens,
          settle.reviewer.durationMs,
          settle.counterChecker.promptTokens,
          settle.counterChecker.completionTokens,
          settle.counterChecker.durationMs,
          runId,
        );
    });
  }

  public get(runId: string): ReviewRunRow | undefined {
    const row = this.db.prepare(SQL_GET).get(runId) as Row | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  public history(
    repositoryId: string,
    pullRequestNumber: number | undefined,
    limit: number,
  ): ReviewRunRow[] {
    const rows =
      pullRequestNumber === undefined
        ? this.db.prepare(SQL_HISTORY).all(repositoryId, limit)
        : this.db.prepare(SQL_HISTORY_PR).all(repositoryId, pullRequestNumber, limit);
    return (rows as Row[]).map(runFromRow);
  }

  public latestPerPullRequest(repositoryId: string): ReviewRunRow[] {
    return (this.db.prepare(SQL_LATEST_PER_PR).all(repositoryId) as Row[]).map(runFromRow);
  }

  public unsettled(): ReviewRunRow[] {
    return (this.db.prepare(SQL_UNSETTLED).all() as Row[]).map(runFromRow);
  }

  public findings(runId: string): ReviewFindingRow[] {
    return (this.db.prepare(SQL_FINDINGS).all(runId) as Row[]).map(findingFromRow);
  }

  public coverageEntries(runId: string): ReviewCoverageEntry[] {
    return (this.db.prepare(SQL_COVERAGE_ENTRIES).all(runId) as Row[]).map((row) => {
      const reason = nullableText(row, "reason");
      return {
        path: text(row, "path"),
        list: text(row, "list") as ReviewDiffCoverageList,
        ...(reason === null ? {} : { reason }),
      };
    });
  }

  /** The median duration of recently settled reviewed runs on this deployment, if any. */
  public medianDurationMs(): number | null {
    const rows = this.db.prepare(SQL_DURATIONS).all() as Row[];
    return median(rows.map((row) => int(row, "duration")));
  }

  /** Private refs any recorded run of this repository still references (the sweep keeps them). */
  public retainedRefs(repositoryRoot: string): ReadonlySet<string> {
    const refs = new Set<string>();
    for (const row of this.db.prepare(SQL_REFS).all(repositoryRoot) as Row[]) {
      for (const ref of stringList(nullableText(row, "private_refs_json"))) refs.add(ref);
    }
    return refs;
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function insertFinding(
  insert: ReturnType<DatabaseSync["prepare"]>,
  runId: string,
  finding: ReviewFindingRow,
): void {
  insert.run(
    runId,
    finding.fingerprint,
    finding.reviewerRank,
    JSON.stringify(finding.report),
    finding.verdict?.verdict ?? null,
    finding.verdict?.reasonCode ?? null,
    finding.verdict === null ? null : JSON.stringify(finding.verdict.evidence),
    finding.evidenceInHead ? 1 : 0,
    finding.presented ? 1 : 0,
    finding.presentationRank,
  );
}
