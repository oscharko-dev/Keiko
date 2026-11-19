// The run-bound Keiko for Quality finding intake (ADR-0184 D4, Issue #4135).
//
// `keiko_review_report` is the only way a finding leaves the Reviewer. Each call's report is
// validated by the contract (`validateReviewFindingReport`), then against the reviewed head commit:
// every cited path must name a readable regular file of the head tree outside the sensitive-path
// deny list, every line range must lie inside that file, and the report's own location must be
// backed by `defect` evidence in the same file. The defect excerpt is read from the head blob and
// the content-derived fingerprint computed from it. Accepted reports are kept here, run-bound and
// in memory, for the counter-check and settlement of Issue #4136; nothing is parsed from free text.
// At most `REVIEW_RUN_MAX_CANDIDATE_REPORTS` reports are accepted per run.

import {
  REVIEW_REPORT_GUIDANCE,
  REVIEW_REPORT_MAX_ISSUE_PATH_LENGTH,
  REVIEW_REPORT_MAX_ISSUES,
  REVIEW_REPORT_REPEAT_LIMIT,
  REVIEW_RUN_MAX_CANDIDATE_REPORTS,
  REVIEW_WORKTREE_DEFAULT_BLOB_LIMIT_BYTES,
  type ReviewCodeLocation,
  type ReviewFindingReport,
  type ReviewReportAcknowledgement,
  type ReviewReportGuidance,
  type ReviewReportRejectionReason,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { reviewDefectExcerptOccurrence } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";
import {
  validateReviewFindingReport,
  type ReviewContractIssue,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import { computeReviewFindingFingerprint } from "@oscharko-dev/keiko-security/review-finding-fingerprint";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import {
  readGitReviewBlob,
  readGitReviewPathObject,
  type GitProcessRunner,
} from "@oscharko-dev/keiko-git";

import type { ServerLogSink } from "../../observability/index.js";
import { logReviewFindingReported } from "./activity-log.js";

const HEAD_READ_TIMEOUT_MS = 10_000;
/** Distinct head files one run may cite; more is a malformed run, not a review. */
const MAX_CACHED_FILES = 64;

/** One accepted candidate finding, handed to the counter-check (Issue #4136). */
export interface ReviewCandidateFinding {
  readonly fingerprint: string;
  readonly report: ReviewFindingReport;
  /** The head commit's lines of the first `defect` evidence, as the fingerprint read them. */
  readonly defectExcerpt: string;
}

export interface ReviewFindingIntakeInput {
  readonly runId: string;
  /** The review worktree: its object store holds the head commit. */
  readonly worktreeRoot: string;
  readonly headSha: string;
  /** A hardened review runner (`createGitReviewProcessRunner`). */
  readonly runner: GitProcessRunner;
  readonly activityLog: ServerLogSink;
  readonly maxCandidates?: number | undefined;
  /**
   * Called once, when the session sent the same report that added nothing
   * `REVIEW_REPORT_REPEAT_LIMIT` times in a row (#4130). The caller ends the session.
   */
  readonly onRepeatLimit?: (() => void) | undefined;
}

export interface ReviewFindingIntake {
  readonly runId: string;
  /** Validates one `keiko_review_report` argument and answers the model-facing acknowledgement. */
  submit(report: unknown, signal?: AbortSignal): Promise<ReviewReportAcknowledgement>;
  /** The accepted candidates, in acceptance order. */
  candidates(): readonly ReviewCandidateFinding[];
  /** Body-free counts of the refused reports by closed reason. */
  rejections(): Readonly<Record<ReviewReportRejectionReason, number>>;
  /** Whether the session reached the repeat limit, so the intake asked for its end (#4130). */
  repeatLimitReached(): boolean;
}

type HeadFile =
  | { readonly kind: "lines"; readonly lines: readonly string[] }
  | {
      readonly kind: "refused";
      readonly reason: "path-outside-worktree" | "range-invalid";
      /**
       * A Git read that did not answer (an abort, a timeout or a process failure), not a fact about
       * the head commit. It is never cached: the next read of the path tries Git again (R4130-013).
       */
      readonly transient?: true;
    };

const TRANSIENT_OUTSIDE: HeadFile = {
  kind: "refused",
  reason: "path-outside-worktree",
  transient: true,
};
const TRANSIENT_RANGE: HeadFile = { kind: "refused", reason: "range-invalid", transient: true };

type Verdict =
  | { readonly ok: true; readonly candidate: ReviewCandidateFinding }
  | {
      readonly ok: false;
      readonly reason: Exclude<ReviewReportRejectionReason, "limit-reached">;
      readonly issues?: readonly ReviewContractIssue[];
      /** A Git read that did not answer (R4130-013), not a fact about the report (R4130-080). */
      readonly transient?: true;
    };

function emptyRejections(): Record<ReviewReportRejectionReason, number> {
  return {
    "schema-invalid": 0,
    "path-outside-worktree": 0,
    "range-invalid": 0,
    "evidence-mismatch": 0,
    "limit-reached": 0,
  };
}

function splitLines(text: string): readonly string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Whether a cited path may be read at all: not a sensitive path the read tools would refuse. */
function admissiblePath(path: string): boolean {
  return !isDenied(path);
}

class HeadFileReader {
  private readonly files = new Map<string, Promise<HeadFile>>();

  public constructor(private readonly input: ReviewHeadReadInput) {}

  public read(path: string, signal: AbortSignal | undefined): Promise<HeadFile> {
    const cached = this.files.get(path);
    if (cached !== undefined) return cached;
    if (this.files.size >= MAX_CACHED_FILES) {
      return Promise.resolve({ kind: "refused", reason: "range-invalid" });
    }
    const pending: Promise<HeadFile> = this.load(path, signal).then((file) => {
      // Only successful loads and deterministic refusals stay cached for the run.
      if (file.kind === "refused" && file.transient === true && this.files.get(path) === pending) {
        this.files.delete(path);
      }
      return file;
    });
    this.files.set(path, pending);
    return pending;
  }

  private async load(path: string, signal: AbortSignal | undefined): Promise<HeadFile> {
    if (!admissiblePath(path)) return { kind: "refused", reason: "path-outside-worktree" };
    const ctx = { runner: this.input.runner, timeoutMs: HEAD_READ_TIMEOUT_MS, abortSignal: signal };
    const cwd = this.input.worktreeRoot;
    const object = await readGitReviewPathObject(ctx, { cwd, sha: this.input.headSha, path });
    // The head commit is held by the worktree's object store, so a failed lookup did not answer.
    if (!object.ok) return TRANSIENT_OUTSIDE;
    if (object.value?.type !== "blob") return { kind: "refused", reason: "path-outside-worktree" };
    // A file too large to verify cannot back a finding: its ranges are unverifiable.
    if (object.value.size > REVIEW_WORKTREE_DEFAULT_BLOB_LIMIT_BYTES) {
      return { kind: "refused", reason: "range-invalid" };
    }
    const maxBytes = Math.max(1, object.value.size);
    const blob = await readGitReviewBlob({ ...ctx, maxBytes }, { cwd, oid: object.value.oid });
    if (!blob.ok) return TRANSIENT_RANGE;
    return { kind: "lines", lines: splitLines(blob.value) };
  }
}

function locations(report: ReviewFindingReport): readonly ReviewCodeLocation[] {
  return [report, ...report.evidence];
}

async function checkLocations(
  reader: HeadFileReader,
  report: ReviewFindingReport,
  signal: AbortSignal | undefined,
): Promise<Extract<Verdict, { readonly ok: false }> | undefined> {
  for (const location of locations(report)) {
    const file = await reader.read(location.file, signal);
    if (file.kind === "refused") return refusedVerdict(file);
    if (location.endLine > file.lines.length) return { ok: false, reason: "range-invalid" };
  }
  return undefined;
}

/** A head file's refusal as a verdict; a transient one keeps its flag (R4130-080). */
function refusedVerdict(
  file: Extract<HeadFile, { readonly kind: "refused" }>,
): Extract<Verdict, { readonly ok: false }> {
  return file.transient === true
    ? { ok: false, reason: file.reason, transient: true }
    : { ok: false, reason: file.reason };
}

/**
 * The contract issues a `schema-invalid` acknowledgement names (#4130): the first few, each with its
 * closed code and its field path cut to a bound. A path names the model's own field, so it goes back
 * to the model only; the Activity Log records the codes.
 */
function modelFacingIssues(issues: readonly ReviewContractIssue[]): readonly ReviewContractIssue[] {
  return issues.slice(0, REVIEW_REPORT_MAX_ISSUES).map((issue) => ({
    code: issue.code,
    path: issue.path.slice(0, REVIEW_REPORT_MAX_ISSUE_PATH_LENGTH),
  }));
}

/** The `defect` evidence that backs the report's own location: same file, overlapping lines. */
function backingDefect(report: ReviewFindingReport): ReviewCodeLocation | undefined {
  return report.evidence.find(
    (entry) =>
      entry.role === "defect" &&
      entry.file === report.file &&
      entry.startLine <= report.endLine &&
      entry.endLine >= report.startLine,
  );
}

async function judge(
  reader: HeadFileReader,
  value: unknown,
  signal: AbortSignal | undefined,
): Promise<Verdict> {
  const validated = validateReviewFindingReport(value);
  if (!validated.ok) {
    return { ok: false, reason: "schema-invalid", issues: modelFacingIssues(validated.issues) };
  }
  const report = validated.value;
  const refused = await checkLocations(reader, report, signal);
  if (refused !== undefined) return refused;
  const defect = backingDefect(report);
  if (defect === undefined) return { ok: false, reason: "evidence-mismatch" };
  const file = await reader.read(defect.file, signal);
  if (file.kind === "refused") return refusedVerdict(file);
  const defectExcerpt = file.lines.slice(defect.startLine - 1, defect.endLine).join("\n");
  if (defectExcerpt.trim().length === 0) return { ok: false, reason: "evidence-mismatch" };
  const occurrence = reviewDefectExcerptOccurrence(file.lines, defect.startLine, defect.endLine);
  const fingerprint = computeReviewFindingFingerprint(report, defectExcerpt, occurrence);
  return { ok: true, candidate: { fingerprint, report, defectExcerpt } };
}

/** The run-bound state the intake keeps between reports. */
interface IntakeState {
  readonly input: ReviewFindingIntakeInput;
  readonly accepted: ReviewCandidateFinding[];
  readonly rejected: Record<ReviewReportRejectionReason, number>;
  readonly max: number;
  reserved: number;
  duplicates: number;
  /** The identity of the last report that added nothing, and how often it came in a row. */
  repeat: { key: string; count: number } | undefined;
  repeatLimitReached: boolean;
}

function record(
  state: IntakeState,
  acknowledgement: ReviewReportAcknowledgement,
  candidate?: ReviewCandidateFinding,
): ReviewReportAcknowledgement {
  logReviewFindingReported(state.input.activityLog, state.input.runId, acknowledgement, {
    ...(candidate === undefined ? {} : { accepted: candidate }),
    duplicateCount: state.duplicates,
    ...(state.repeat === undefined ? {} : { repeatCount: state.repeat.count }),
    ...(state.repeatLimitReached ? { sessionEnded: true } : {}),
  });
  return acknowledgement;
}

/**
 * Counts a report that added nothing (#4130). The same report again is a repeat; the
 * `REVIEW_REPORT_REPEAT_LIMIT`-th one in a row ends the session once. An accepted report, or a
 * different report, starts the count again. Answers the guidance for the count reached.
 */
function countRepeat(
  state: IntakeState,
  key: string,
  first: ReviewReportGuidance,
): ReviewReportGuidance {
  const count = state.repeat?.key === key ? state.repeat.count + 1 : 1;
  state.repeat = { key, count };
  if (count < 2) return first;
  if (count < REVIEW_REPORT_REPEAT_LIMIT) return REVIEW_REPORT_GUIDANCE.repeated;
  if (!state.repeatLimitReached) {
    state.repeatLimitReached = true;
    state.input.onRepeatLimit?.();
  }
  return REVIEW_REPORT_GUIDANCE.stopped;
}

/**
 * The identity of a refused report: its reason and a digest of the arguments as sent. The arguments
 * arrive as parsed JSON, so they always encode; wrapped, an absent value does too.
 */
function rejectedReportKey(reason: ReviewReportRejectionReason, value: unknown): string {
  return `rejected:${reason}:${sha256Hex(JSON.stringify({ value }))}`;
}

/**
 * The acknowledgement of a report that passed the head-commit judgement. A report whose fingerprint
 * an accepted candidate already holds adds nothing: it is answered `duplicate`, so the model knows
 * it was not added, and counted (R4130-025).
 */
function acknowledgeCandidate(
  state: IntakeState,
  candidate: ReviewCandidateFinding,
): ReviewReportAcknowledgement {
  const known = state.accepted.find((entry) => entry.fingerprint === candidate.fingerprint);
  if (known === undefined) {
    state.accepted.push(candidate);
    state.repeat = undefined;
  } else state.duplicates += 1;
  const counts = {
    accepted: state.accepted.length,
    remaining: Math.max(0, state.max - state.accepted.length),
  };
  if (known === undefined) return record(state, { status: "accepted", ...counts }, candidate);
  const guidance = countRepeat(
    state,
    `duplicate:${known.fingerprint}`,
    REVIEW_REPORT_GUIDANCE.duplicate,
  );
  return record(state, { status: "duplicate", ...counts, guidance }, known);
}

function acknowledgeRejection(
  state: IntakeState,
  value: unknown,
  verdict: Extract<Verdict, { readonly ok: false }>,
): ReviewReportAcknowledgement {
  state.rejected[verdict.reason] += 1;
  // A Git read that did not answer may be retried with the same report (R4130-013), so it is
  // never a repeat and never ends the session (R4130-080).
  const guidance =
    verdict.transient === true
      ? REVIEW_REPORT_GUIDANCE.rejected
      : countRepeat(
          state,
          rejectedReportKey(verdict.reason, value),
          REVIEW_REPORT_GUIDANCE.rejected,
        );
  const issues = verdict.issues === undefined ? {} : { issues: verdict.issues };
  return record(state, { status: "rejected", reason: verdict.reason, ...issues, guidance });
}

async function submitReport(
  state: IntakeState,
  reader: HeadFileReader,
  value: unknown,
  signal: AbortSignal | undefined,
): Promise<ReviewReportAcknowledgement> {
  // Up to eight reports may be judged at once: each reserves its slot synchronously before the
  // head-commit judgement is awaited, so concurrent reports can never exceed the cap. The slot is
  // released once the judgement settles; an accepted candidate then occupies it.
  if (state.accepted.length + state.reserved >= state.max) {
    state.rejected["limit-reached"] += 1;
    // Every report past the cap is the same answer, so further reports repeat it.
    countRepeat(state, "limit-reached", REVIEW_REPORT_GUIDANCE.rejected);
    return record(state, { status: "limit-reached" });
  }
  state.reserved += 1;
  let verdict: Verdict;
  try {
    verdict = await judge(reader, value, signal);
  } finally {
    state.reserved -= 1;
  }
  return verdict.ok
    ? acknowledgeCandidate(state, verdict.candidate)
    : acknowledgeRejection(state, value, verdict);
}

/** Creates the intake of one review run. */
export function createReviewFindingIntake(input: ReviewFindingIntakeInput): ReviewFindingIntake {
  const reader = new HeadFileReader(input);
  const state: IntakeState = {
    input,
    accepted: [],
    rejected: emptyRejections(),
    max: input.maxCandidates ?? REVIEW_RUN_MAX_CANDIDATE_REPORTS,
    reserved: 0,
    duplicates: 0,
    repeat: undefined,
    repeatLimitReached: false,
  };
  return {
    runId: input.runId,
    submit: (value, signal) => submitReport(state, reader, value, signal),
    candidates: () => [...state.accepted],
    rejections: () => ({ ...state.rejected }),
    repeatLimitReached: () => state.repeatLimitReached,
  };
}

// ─── Shared with the counter-check (Issue #4136) ─────────────────────────────

/** What reading head-commit files needs: the worktree's object store, the head and the runner. */
type ReviewHeadReadInput = Pick<ReviewFindingIntakeInput, "worktreeRoot" | "headSha" | "runner">;

/**
 * The head-commit file reader of the intake, shared with the counter-check, which verifies its
 * verdict evidence against the same objects (cached per path, bounded per run).
 */
export { HeadFileReader as ReviewHeadFileReader };
