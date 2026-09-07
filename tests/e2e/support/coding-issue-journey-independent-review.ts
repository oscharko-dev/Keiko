// Qualification checkpoint only: the independent reviewer checks the actual final diff and
// required CI against the frozen issue rubric before the harness opens the existing governed
// merge confirmation. Model-authored test counts cannot substitute for that review. Requests and
// approvals remain outside both the controlled repository and this source checkout.
//
// Three properties this checkpoint must have, and how they are met here:
//   * The flow PARKS until the answer arrives. Reviewing a real diff is human-paced work, so the
//     wait is event-driven (`watch` on the review directory, with a slow re-read for platforms
//     whose events are unreliable) and carries no deadline of its own. An operator may still bound
//     an unattended lane with `KEIKO_QUALIFICATION_REVIEW_TIMEOUT_MS`.
//   * A review has a THREE-VALUE outcome per criterion — `passed`, `rejected`, `needs-changes` —
//     and every one of them carries a reason. Only an all-passed review yields the contract's
//     approved `CodeTaskQualificationRubricReview`; anything else fails the flow with the unmet
//     criterion ids named, so "the reviewer found a defect" can never again be indistinguishable
//     from "no reviewer answered" (both used to be the same silent timeout).
//   * The answer is SIGNED. The reviewer writes the review bytes and then a detached SSH signature
//     over exactly those bytes; the harness verifies it against an operator-provided allowed-signers
//     file under this lane's own namespace before the review counts. A dropped file alone is not an
//     approval, and an edited review invalidates its signature.
// The digest binding is unchanged: every response is still bound to one exact flow, run, pull
// request, head, source commit and frozen-rubric digest.

import type {
  CodeTaskQualificationRubricReview,
  CodeTaskSha256Digest,
} from "@oscharko-dev/keiko-contracts";
import { isCodeTaskSha256Digest } from "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requiredIndependentReviewCriteria } from "./coding-issue-journey-rubric.js";

const RUBRIC_PATH = "docs/qa/evidence/coding-issue-journey/3390/rubric.md";
const MAX_REVIEW_BYTES = 32_768;
const SHA = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REVIEW_SCHEMA_VERSION = 2;
/** Detached-signature namespace for this lane; never the `git` namespace an operator signs commits with. */
const REVIEW_SIGNATURE_NAMESPACE = "keiko-qualification-review";
const SIGNATURE_VERIFIER = "/usr/bin/ssh-keygen";
const MAX_REASON_LENGTH = 500;
/** Slow re-read: `watch` misses events on some filesystems, so the park never depends on it alone. */
const REVIEW_RECHECK_MS = 2_000;
export const INDEPENDENT_REVIEW_OUTCOMES = ["passed", "rejected", "needs-changes"] as const;
export type IndependentReviewOutcome = (typeof INDEPENDENT_REVIEW_OUTCOMES)[number];
export type IndependentReviewVerdict = "approved" | "rejected" | "changes-requested";

/** One criterion the reviewer did not pass, with the reason they recorded for it. */
export interface UnmetIndependentReviewCriterion {
  readonly id: string;
  readonly outcome: Exclude<IndependentReviewOutcome, "passed">;
  readonly reason: string;
}

/** An answered review. Only `approved` carries the contract row a completed flow may retain. */
export type IndependentQualificationReviewResult =
  | { readonly verdict: "approved"; readonly review: CodeTaskQualificationRubricReview }
  | {
      readonly verdict: Exclude<IndependentReviewVerdict, "approved">;
      readonly reviewId: string;
      readonly reviewDigest: CodeTaskSha256Digest;
      readonly unmet: readonly UnmetIndependentReviewCriterion[];
    };

/** A real reviewer answer that withholds approval — never the absence of an answer. */
export class IndependentQualificationReviewRejected extends Error {
  public readonly verdict: Exclude<IndependentReviewVerdict, "approved">;
  public readonly unmet: readonly UnmetIndependentReviewCriterion[];
  public constructor(
    result: Extract<
      IndependentQualificationReviewResult,
      { verdict: "rejected" | "changes-requested" }
    >,
  ) {
    super(
      `independent qualification review returned ${result.verdict}: ` +
        result.unmet.map((criterion) => `${criterion.id}=${criterion.outcome}`).join(", "),
    );
    this.name = "IndependentQualificationReviewRejected";
    this.verdict = result.verdict;
    this.unmet = result.unmet;
  }
}

export type IndependentQualificationReviewIdentity = Pick<
  CodeTaskQualificationRubricReview,
  | "flowId"
  | "taskRunId"
  | "repository"
  | "issueNumber"
  | "pullRequestNumber"
  | "pullRequestHeadSha"
  | "sourceCommitSha"
>;

export interface IndependentReviewRequest {
  readonly binding: IndependentQualificationReviewIdentity & {
    readonly rubricDigest: CodeTaskSha256Digest;
  };
  readonly criterionIds: readonly string[];
  readonly requestPath: string;
  readonly responsePath: string;
}

function digest(bytes: Uint8Array): CodeTaskSha256Digest {
  const value = createHash("sha256").update(bytes).digest("hex");
  if (!isCodeTaskSha256Digest(value)) throw new TypeError("independent review digest is invalid");
  return value;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  const object = record(value);
  return (
    object !== undefined &&
    Object.keys(object).length === keys.length &&
    keys.every((key) => Object.hasOwn(object, key))
  );
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function reviewDirectory(): string {
  const configured = process.env.KEIKO_QUALIFICATION_REVIEW_DIR;
  const controlledRoot = process.env.KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT;
  if (configured === undefined || !isAbsolute(configured) || controlledRoot === undefined) {
    throw new Error("independent qualification review directory must be explicitly configured");
  }
  const directory = realpathSync(configured);
  if (
    within(realpathSync(process.cwd()), directory) ||
    within(realpathSync(controlledRoot), directory)
  ) {
    throw new Error("independent review directory must be outside both repository workspaces");
  }
  return directory;
}

function assertIdentity(identity: IndependentQualificationReviewIdentity): void {
  if (
    !/^issue-to-pr-flow-0[1-5]$/u.test(identity.flowId) ||
    !SAFE_ID.test(identity.taskRunId) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity.repository) ||
    !positiveId(identity.issueNumber) ||
    !positiveId(identity.pullRequestNumber) ||
    !SHA.test(identity.pullRequestHeadSha) ||
    !SHA.test(identity.sourceCommitSha)
  ) {
    throw new TypeError("independent qualification review identity is invalid");
  }
}

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Publishes a deterministic, body-free request that an independent reviewer can inspect. */
export function requestIndependentQualificationReview(
  identity: IndependentQualificationReviewIdentity,
): IndependentReviewRequest {
  assertIdentity(identity);
  const directory = reviewDirectory();
  const rubric = readFileSync(resolve(RUBRIC_PATH));
  const binding = { ...identity, rubricDigest: digest(rubric) };
  const criterionIds = requiredIndependentReviewCriteria(
    rubric,
    identity.issueNumber,
    binding.rubricDigest,
  );
  const name = `${identity.flowId}.${identity.taskRunId}.${identity.pullRequestHeadSha}`;
  const requestPath = join(directory, `${name}.request.json`);
  const responsePath = join(directory, `${name}.review.json`);
  const bytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: REVIEW_SCHEMA_VERSION,
        binding,
        criterionIds,
        outcomes: INDEPENDENT_REVIEW_OUTCOMES,
      },
      null,
      2,
    )}\n`,
  );
  try {
    writeFileSync(requestPath, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (record(error)?.code !== "EEXIST" || readReview(requestPath)?.equals(bytes) !== true) {
      throw new Error("independent review request could not be retained", { cause: error });
    }
  }
  return { binding, criterionIds, requestPath, responsePath };
}

function isReviewOutcome(value: unknown): value is IndependentReviewOutcome {
  return INDEPENDENT_REVIEW_OUTCOMES.some((outcome) => outcome === value);
}

/** Every outcome carries a reason: a passed criterion states what was checked, an unmet one what
 * is wrong. A bounded single-line string, so a review stays reviewable and body-free. */
function isReviewReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_REASON_LENGTH &&
    // eslint-disable-next-line no-control-regex -- rejects control characters in a recorded reason
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

interface CriterionResult {
  readonly id: string;
  readonly outcome: IndependentReviewOutcome;
  readonly reason: string;
}

function criterionResult(criterion: unknown): CriterionResult {
  const item = record(criterion);
  if (
    !exactKeys(item, ["id", "outcome", "reason"]) ||
    typeof item?.id !== "string" ||
    !/^[a-z][a-z0-9-]{1,79}$/u.test(item.id) ||
    !isReviewOutcome(item.outcome) ||
    !isReviewReason(item.reason)
  ) {
    throw new TypeError("independent rubric review contains an unapproved criterion");
  }
  return { id: item.id, outcome: item.outcome, reason: item.reason };
}

/** The frozen rubric owns the inventory; the reviewer supplies one reasoned outcome per entry. */
function criterionResults(value: unknown, required: readonly string[]): readonly CriterionResult[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError("independent rubric review requires explicit criterion results");
  }
  const results: CriterionResult[] = [];
  const ids = new Set<string>();
  for (const criterion of value as readonly unknown[]) {
    const result = criterionResult(criterion);
    if (ids.has(result.id)) {
      throw new TypeError("independent rubric review contains an unapproved criterion");
    }
    ids.add(result.id);
    results.push(result);
  }
  if (ids.size !== required.length || required.some((id) => !ids.has(id))) {
    throw new TypeError("independent review must cover the complete frozen rubric");
  }
  return results;
}

function unmetCriteria(
  results: readonly CriterionResult[],
): readonly UnmetIndependentReviewCriterion[] {
  return results.flatMap((result) =>
    result.outcome === "passed"
      ? []
      : [{ id: result.id, outcome: result.outcome, reason: result.reason }],
  );
}

function verdictOf(unmet: readonly UnmetIndependentReviewCriterion[]): IndependentReviewVerdict {
  if (unmet.length === 0) return "approved";
  return unmet.some((criterion) => criterion.outcome === "rejected")
    ? "rejected"
    : "changes-requested";
}

/** The response envelope, bound to exactly one requested flow. Extracted so the validator below
 * stays within the repository complexity bar. */
function isExactFlowEnvelope(
  value: Readonly<Record<string, unknown>>,
  binding: IndependentReviewRequest["binding"],
): boolean {
  return (
    exactKeys(value, ["schemaVersion", "reviewId", "binding", "criteria"]) &&
    value.schemaVersion === REVIEW_SCHEMA_VERSION &&
    typeof value.reviewId === "string" &&
    SAFE_ID.test(value.reviewId) &&
    isDeepStrictEqual(value.binding, binding)
  );
}

/** Consumes the exact answered bytes, deriving the verdict and counts rather than trusting any
 * supplied total. An all-passed review yields the contract row; any unmet criterion yields the
 * reviewer's own recorded outcomes instead, so the negative answer is evidence too. */
export function validateIndependentQualificationReview(
  bytes: Buffer,
  binding: IndependentReviewRequest["binding"],
  rubric: Uint8Array = readFileSync(resolve(RUBRIC_PATH)),
): IndependentQualificationReviewResult {
  if (bytes.length === 0 || bytes.length > MAX_REVIEW_BYTES) {
    throw new TypeError("independent rubric review size is invalid");
  }
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const value = record(parsed);
  if (value === undefined || !isExactFlowEnvelope(value, binding)) {
    throw new TypeError("independent rubric review does not match the exact requested flow");
  }
  const required = requiredIndependentReviewCriteria(
    rubric,
    binding.issueNumber,
    binding.rubricDigest,
  );
  const results = criterionResults(value.criteria, required);
  const unmet = unmetCriteria(results);
  const verdict = verdictOf(unmet);
  const reviewDigest = digest(bytes);
  if (verdict !== "approved") {
    return { verdict, reviewId: String(value.reviewId), reviewDigest, unmet };
  }
  return {
    verdict,
    review: {
      ...binding,
      reviewId: String(value.reviewId),
      reviewDigest,
      verdict: "approved",
      criteriaTotal: results.length,
      criteriaPassed: results.length,
    },
  };
}

function requiredSignerEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`independent review signature verification requires ${name}`);
  }
  return value;
}

/** Fail-closed detached-signature check over the exact review bytes. A dropped file is not an
 * answer until the configured signer has signed it under this lane's own namespace. */
function assertSignedReview(responsePath: string, bytes: Buffer): void {
  const allowedSigners = requiredSignerEnv("KEIKO_QUALIFICATION_REVIEW_ALLOWED_SIGNERS");
  const signer = requiredSignerEnv("KEIKO_QUALIFICATION_REVIEW_SIGNER");
  if (!isAbsolute(allowedSigners) || !existsSync(allowedSigners)) {
    throw new Error("independent review allowed-signers file is unavailable");
  }
  try {
    execFileSync(
      SIGNATURE_VERIFIER,
      [
        "-Y",
        "verify",
        "-f",
        allowedSigners,
        "-I",
        signer,
        "-n",
        REVIEW_SIGNATURE_NAMESPACE,
        "-s",
        signaturePathFor(responsePath),
      ],
      { input: bytes, stdio: ["pipe", "ignore", "pipe"], timeout: 30_000 },
    );
  } catch (error) {
    throw new Error("independent rubric review signature is missing or invalid", { cause: error });
  }
}

export function signaturePathFor(responsePath: string): string {
  return `${responsePath}.sig`;
}

function readReview(path: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (record(error)?.code === "ENOENT") return undefined;
    throw new Error("independent rubric review could not be opened", { cause: error });
  }
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_REVIEW_BYTES) {
      throw new TypeError("independent rubric review must be a bounded regular file");
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== metadata.size) throw new TypeError("independent rubric review changed");
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

/** Resolves once BOTH the review and its detached signature exist. The signature is written last,
 * so keying the wait on it also removes the partial-read race a plain review-file watch would have. */
function answeredReview(responsePath: string): Buffer | undefined {
  if (!existsSync(signaturePathFor(responsePath))) return undefined;
  return readReview(responsePath);
}

/** An operator-configured bound for an unattended lane. Unset means the flow parks indefinitely,
 * which is the default: a review is human-paced work and must never race a wall clock. */
function configuredReviewDeadlineMs(): number | undefined {
  const raw = process.env.KEIKO_QUALIFICATION_REVIEW_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("KEIKO_QUALIFICATION_REVIEW_TIMEOUT_MS must be a positive whole number of ms");
  }
  return value;
}

/** Owns one parked wait: the directory watch, the slow re-read fallback, an optional operator
 * bound, and exactly-once settlement with cleanup. Split into small members so each stays within
 * the repository function-size bar. */
class ReviewPark {
  private settled = false;
  private readonly cleanups: (() => void)[] = [];

  public constructor(
    private readonly responsePath: string,
    private readonly onAnswer: (bytes: Buffer) => void,
    private readonly onFailure: (error: Error) => void,
  ) {}

  public start(deadlineMs: number | undefined): void {
    const watcher = watch(dirname(this.responsePath), () => {
      this.check();
    });
    this.cleanups.push(() => {
      watcher.close();
    });
    const interval = setInterval(() => {
      this.check();
    }, REVIEW_RECHECK_MS);
    this.cleanups.push(() => {
      clearInterval(interval);
    });
    if (deadlineMs !== undefined) this.arm(deadlineMs);
    this.check();
  }

  private arm(deadlineMs: number): void {
    const timer = setTimeout(() => {
      this.fail(
        new Error("independent qualification review did not answer within the configured bound"),
      );
    }, deadlineMs);
    this.cleanups.push(() => {
      clearTimeout(timer);
    });
  }

  private check(): void {
    let bytes: Buffer | undefined;
    try {
      bytes = answeredReview(this.responsePath);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("independent review is unreadable"));
      return;
    }
    if (bytes !== undefined && this.close()) this.onAnswer(bytes);
  }

  private fail(error: Error): void {
    if (this.close()) this.onFailure(error);
  }

  private close(): boolean {
    if (this.settled) return false;
    this.settled = true;
    for (const cleanup of this.cleanups) cleanup();
    return true;
  }
}

/** Event-driven park: watches the review directory, re-reads slowly as a fallback, and never
 * imposes a deadline of its own. */
async function waitForAnsweredReview(responsePath: string): Promise<Buffer> {
  const immediate = answeredReview(responsePath);
  if (immediate !== undefined) return immediate;
  const deadlineMs = configuredReviewDeadlineMs();
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const park = new ReviewPark(responsePath, resolvePromise, rejectPromise);
    park.start(deadlineMs);
  });
}

/**
 * Publishes the request, then parks until the reviewer answers. An approving, correctly signed
 * review returns the contract row; a signed review that withholds approval throws
 * `IndependentQualificationReviewRejected` naming the unmet criteria, so a real negative result is
 * never reported as an absent reviewer.
 */
export async function awaitIndependentQualificationReview(
  identity: IndependentQualificationReviewIdentity,
): Promise<CodeTaskQualificationRubricReview> {
  const request = requestIndependentQualificationReview(identity);
  const bytes = await waitForAnsweredReview(request.responsePath);
  assertSignedReview(request.responsePath, bytes);
  const result = validateIndependentQualificationReview(bytes, request.binding);
  if (result.verdict !== "approved") throw new IndependentQualificationReviewRejected(result);
  return result.review;
}
