// The run-bound Keiko for Quality finding intake (ADR-0182 D4, Issue #4135).
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
  REVIEW_RUN_MAX_CANDIDATE_REPORTS,
  REVIEW_WORKTREE_DEFAULT_BLOB_LIMIT_BYTES,
  type ReviewCodeLocation,
  type ReviewFindingReport,
  type ReviewReportAcknowledgement,
  type ReviewReportRejectionReason,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { validateReviewFindingReport } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";
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
}

export interface ReviewFindingIntake {
  readonly runId: string;
  /** Validates one `keiko_review_report` argument and answers the model-facing acknowledgement. */
  submit(report: unknown, signal?: AbortSignal): Promise<ReviewReportAcknowledgement>;
  /** The accepted candidates, in acceptance order. */
  candidates(): readonly ReviewCandidateFinding[];
  /** Body-free counts of the refused reports by closed reason. */
  rejections(): Readonly<Record<ReviewReportRejectionReason, number>>;
}

/** One head-commit file as the intake and the counter-check verify locations against it. */
export type ReviewHeadFile =
  | { readonly kind: "lines"; readonly lines: readonly string[] }
  | { readonly kind: "refused"; readonly reason: "path-outside-worktree" | "range-invalid" };

type Verdict =
  | { readonly ok: true; readonly candidate: ReviewCandidateFinding }
  | { readonly ok: false; readonly reason: Exclude<ReviewReportRejectionReason, "limit-reached"> };

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

/**
 * Reads cited files of the reviewed head commit from its objects (never the worktree), cached per
 * path and bounded per run. Shared by the finding intake and the counter-check (#4136).
 */
export class ReviewHeadFileReader {
  private readonly files = new Map<string, Promise<ReviewHeadFile>>();

  public constructor(
    private readonly input: Pick<ReviewFindingIntakeInput, "worktreeRoot" | "headSha" | "runner">,
  ) {}

  public read(path: string, signal: AbortSignal | undefined): Promise<ReviewHeadFile> {
    const cached = this.files.get(path);
    if (cached !== undefined) return cached;
    if (this.files.size >= MAX_CACHED_FILES) {
      return Promise.resolve({ kind: "refused", reason: "range-invalid" });
    }
    const pending = this.load(path, signal);
    this.files.set(path, pending);
    return pending;
  }

  private async load(path: string, signal: AbortSignal | undefined): Promise<ReviewHeadFile> {
    if (!admissiblePath(path)) return { kind: "refused", reason: "path-outside-worktree" };
    const ctx = { runner: this.input.runner, timeoutMs: HEAD_READ_TIMEOUT_MS, abortSignal: signal };
    const cwd = this.input.worktreeRoot;
    const object = await readGitReviewPathObject(ctx, { cwd, sha: this.input.headSha, path });
    if (!object.ok || object.value?.type !== "blob") {
      return { kind: "refused", reason: "path-outside-worktree" };
    }
    // A file too large to verify cannot back a finding: its ranges are unverifiable.
    if (object.value.size > REVIEW_WORKTREE_DEFAULT_BLOB_LIMIT_BYTES) {
      return { kind: "refused", reason: "range-invalid" };
    }
    const maxBytes = Math.max(1, object.value.size);
    const blob = await readGitReviewBlob({ ...ctx, maxBytes }, { cwd, oid: object.value.oid });
    if (!blob.ok) return { kind: "refused", reason: "range-invalid" };
    return { kind: "lines", lines: splitLines(blob.value) };
  }
}

function locations(report: ReviewFindingReport): readonly ReviewCodeLocation[] {
  return [report, ...report.evidence];
}

async function checkLocations(
  reader: ReviewHeadFileReader,
  report: ReviewFindingReport,
  signal: AbortSignal | undefined,
): Promise<Exclude<ReviewReportRejectionReason, "limit-reached"> | undefined> {
  for (const location of locations(report)) {
    const file = await reader.read(location.file, signal);
    if (file.kind === "refused") return file.reason;
    if (location.endLine > file.lines.length) return "range-invalid";
  }
  return undefined;
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
  reader: ReviewHeadFileReader,
  value: unknown,
  signal: AbortSignal | undefined,
): Promise<Verdict> {
  const validated = validateReviewFindingReport(value);
  if (!validated.ok) return { ok: false, reason: "schema-invalid" };
  const report = validated.value;
  const refused = await checkLocations(reader, report, signal);
  if (refused !== undefined) return { ok: false, reason: refused };
  const defect = backingDefect(report);
  if (defect === undefined) return { ok: false, reason: "evidence-mismatch" };
  const file = await reader.read(defect.file, signal);
  if (file.kind === "refused") return { ok: false, reason: file.reason };
  const defectExcerpt = file.lines.slice(defect.startLine - 1, defect.endLine).join("\n");
  if (defectExcerpt.trim().length === 0) return { ok: false, reason: "evidence-mismatch" };
  const fingerprint = computeReviewFindingFingerprint(report, defectExcerpt);
  return { ok: true, candidate: { fingerprint, report, defectExcerpt } };
}

/** Creates the intake of one review run. */
export function createReviewFindingIntake(input: ReviewFindingIntakeInput): ReviewFindingIntake {
  const reader = new ReviewHeadFileReader(input);
  const accepted: ReviewCandidateFinding[] = [];
  const rejected = emptyRejections();
  const max = input.maxCandidates ?? REVIEW_RUN_MAX_CANDIDATE_REPORTS;
  let reserved = 0;
  const record = (
    acknowledgement: ReviewReportAcknowledgement,
    candidate?: ReviewCandidateFinding,
  ): void => {
    logReviewFindingReported(input.activityLog, input.runId, acknowledgement, candidate);
  };
  return {
    runId: input.runId,
    async submit(value, signal): Promise<ReviewReportAcknowledgement> {
      // Up to eight reports may be judged at once: each reserves its slot synchronously before the
      // head-commit judgement is awaited, so concurrent reports can never exceed the cap. The slot
      // is released once the judgement settles; an accepted candidate then occupies it.
      if (accepted.length + reserved >= max) {
        rejected["limit-reached"] += 1;
        const limit: ReviewReportAcknowledgement = { status: "limit-reached" };
        record(limit);
        return limit;
      }
      reserved += 1;
      let verdict: Awaited<ReturnType<typeof judge>>;
      try {
        verdict = await judge(reader, value, signal);
      } finally {
        reserved -= 1;
      }
      if (!verdict.ok) {
        rejected[verdict.reason] += 1;
        const refusal: ReviewReportAcknowledgement = { status: "rejected", reason: verdict.reason };
        record(refusal);
        return refusal;
      }
      const known = accepted.some((entry) => entry.fingerprint === verdict.candidate.fingerprint);
      if (!known) accepted.push(verdict.candidate);
      const acknowledgement: ReviewReportAcknowledgement = {
        status: "accepted",
        accepted: accepted.length,
        remaining: Math.max(0, max - accepted.length),
      };
      record(acknowledgement, verdict.candidate);
      return acknowledgement;
    },
    candidates: () => [...accepted],
    rejections: () => ({ ...rejected }),
  };
}
