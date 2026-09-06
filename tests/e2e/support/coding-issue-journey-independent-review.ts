// Qualification checkpoint only: the independent reviewer checks the actual final diff and
// required CI against the frozen issue rubric before the harness opens the existing governed
// merge confirmation. Model-authored test counts cannot substitute for that review. Requests and
// approvals remain outside both the controlled repository and this source checkout.

import type {
  CodeTaskQualificationRubricReview,
  CodeTaskSha256Digest,
} from "@oscharko-dev/keiko-contracts";
import { isCodeTaskSha256Digest } from "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";
import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requiredIndependentReviewCriteria } from "./coding-issue-journey-rubric.js";

const RUBRIC_PATH = "docs/qa/evidence/coding-issue-journey/3390/rubric.md";
const MAX_REVIEW_BYTES = 32_768;
const SHA = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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
    `${JSON.stringify({ schemaVersion: 1, binding, criterionIds }, null, 2)}\n`,
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

function approvedCriterionId(criterion: unknown): string {
  const item = record(criterion);
  if (
    !exactKeys(item, ["id", "outcome"]) ||
    typeof item?.id !== "string" ||
    !/^[a-z][a-z0-9-]{1,79}$/u.test(item.id) ||
    item.outcome !== "passed"
  ) {
    throw new TypeError("independent rubric review contains an unapproved criterion");
  }
  return item.id;
}

function passingCriteria(value: unknown, required: readonly string[]): number {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError("independent rubric review requires explicit criterion results");
  }
  const ids = new Set<string>();
  for (const criterion of value as readonly unknown[]) {
    const id = approvedCriterionId(criterion);
    if (ids.has(id)) {
      throw new TypeError("independent rubric review contains an unapproved criterion");
    }
    ids.add(id);
  }
  if (ids.size !== required.length || required.some((id) => !ids.has(id))) {
    throw new TypeError("independent review must cover the complete frozen rubric");
  }
  return ids.size;
}

/** Consumes the exact approved bytes, deriving counts rather than trusting supplied totals. */
export function validateIndependentQualificationReview(
  bytes: Buffer,
  binding: IndependentReviewRequest["binding"],
  rubric: Uint8Array = readFileSync(resolve(RUBRIC_PATH)),
): CodeTaskQualificationRubricReview {
  if (bytes.length === 0 || bytes.length > MAX_REVIEW_BYTES) {
    throw new TypeError("independent rubric review size is invalid");
  }
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  const value = record(parsed);
  if (
    !exactKeys(value, ["schemaVersion", "reviewId", "binding", "criteria"]) ||
    value?.schemaVersion !== 1 ||
    typeof value.reviewId !== "string" ||
    !SAFE_ID.test(value.reviewId) ||
    !isDeepStrictEqual(value.binding, binding)
  ) {
    throw new TypeError("independent rubric review does not match the exact requested flow");
  }
  const required = requiredIndependentReviewCriteria(
    rubric,
    binding.issueNumber,
    binding.rubricDigest,
  );
  const count = passingCriteria(value.criteria, required);
  return {
    ...binding,
    reviewId: value.reviewId,
    reviewDigest: digest(bytes),
    verdict: "approved",
    criteriaTotal: count,
    criteriaPassed: count,
  };
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

export async function awaitIndependentQualificationReview(
  identity: IndependentQualificationReviewIdentity,
): Promise<CodeTaskQualificationRubricReview> {
  const request = requestIndependentQualificationReview(identity);
  let approved: CodeTaskQualificationRubricReview | undefined;
  await expect
    .poll(
      () => {
        const bytes = readReview(request.responsePath);
        if (bytes === undefined) return false;
        approved = validateIndependentQualificationReview(bytes, request.binding);
        return true;
      },
      {
        timeout: 300_000,
        intervals: [250, 500, 1_000],
        message: "waiting for independent review of the actual final diff and required CI",
      },
    )
    .toBe(true);
  if (approved === undefined) throw new Error("independent qualification review was unavailable");
  return approved;
}
