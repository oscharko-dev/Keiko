// The reviewed diff of one file (Issue #4136): base-to-head, read from the Git objects the run's
// private refs retain (child 3), never from a working tree, so it is available after the review
// worktree is gone. Once the retention sweep removed the refs, it is refused `objects-unavailable`.
// Only a path the run's coverage lists can be read; the context is bounded. A renamed file reads its
// base side under the path it had there (R4130-015). A path the hardened Git reads refuse as an
// operand (a control character) is refused `objects-unavailable`, with its cause on the diagnostic
// sink under the request's correlation (R4130-024).

import {
  REVIEW_CONTRACT_VERSION,
  REVIEW_RUN_DIFF_CONTEXT_MAX,
  type ReviewRunDiffResponse,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import {
  diffGitReviewBlobs,
  GitReviewOperandError,
  readGitReviewBlob,
  readGitReviewPathObject,
  resolveGitReviewCommit,
  type GitReviewOperationContext,
} from "@oscharko-dev/keiko-git";

import { reportReviewFailure } from "../diagnostics.js";
import type { ReviewServices } from "../services.js";
import type { ReviewRunRow, ReviewRunStore } from "./store.js";

const DIFF_MAX_BYTES = 8 * 1024 * 1024;

export type ReviewRunDiffResult =
  | { readonly kind: "not-found" }
  | { readonly kind: "response"; readonly body: ReviewRunDiffResponse };

function status(value: Exclude<ReviewRunDiffResponse["status"], "available">): ReviewRunDiffResult {
  return { kind: "response", body: { schemaVersion: REVIEW_CONTRACT_VERSION, status: value } };
}

async function refsRetained(ctx: GitReviewOperationContext, row: ReviewRunRow): Promise<boolean> {
  if (row.privateRefs.length === 0) return false;
  for (const ref of row.privateRefs) {
    const resolved = await resolveGitReviewCommit(ctx, { cwd: row.repositoryRoot, ref });
    if (!resolved.ok || resolved.value === undefined) return false;
  }
  return true;
}

async function blobAt(
  ctx: GitReviewOperationContext,
  row: ReviewRunRow,
  sha: string,
  path: string,
): Promise<string | undefined | false> {
  const object = await readGitReviewPathObject(ctx, { cwd: row.repositoryRoot, sha, path });
  if (!object.ok) return false;
  return object.value?.type === "blob" ? object.value.oid : undefined;
}

function blobLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The whole-file diff of a path that exists on one side only (added or deleted). Git cannot diff
 * against an object the repository does not hold, and the review never writes one.
 */
async function oneSidedDiff(
  ctx: GitReviewOperationContext,
  row: ReviewRunRow,
  oid: string,
  side: "added" | "deleted",
): Promise<string | undefined> {
  const blob = await readGitReviewBlob(ctx, { cwd: row.repositoryRoot, oid });
  if (!blob.ok) return undefined;
  const lines = blobLines(blob.value);
  const count = String(lines.length);
  const header = side === "added" ? `@@ -0,0 +1,${count} @@` : `@@ -1,${count} +0,0 @@`;
  const marker = side === "added" ? "+" : "-";
  return [header, ...lines.map((line) => `${marker}${line}`), ""].join("\n");
}

async function unifiedDiff(
  ctx: GitReviewOperationContext,
  row: ReviewRunRow,
  sides: { readonly base: string | undefined; readonly head: string | undefined },
  contextLines: number,
): Promise<string | undefined> {
  if (sides.base === undefined) {
    return sides.head === undefined ? undefined : oneSidedDiff(ctx, row, sides.head, "added");
  }
  if (sides.head === undefined) return oneSidedDiff(ctx, row, sides.base, "deleted");
  const diff = await diffGitReviewBlobs(ctx, {
    cwd: row.repositoryRoot,
    oldOid: sides.base,
    newOid: sides.head,
    contextLines,
  });
  return diff.ok ? diff.value : undefined;
}

export interface ReviewRunDiffRequest {
  readonly runId: string;
  readonly path: string;
  readonly contextLines: number;
  readonly correlationId?: string | undefined;
}

interface ReviewedSides {
  readonly row: ReviewRunRow;
  readonly baseSha: string;
  readonly headSha: string;
  /** The path on the base side: the previous path of a rename, else the requested path. */
  readonly basePath: string;
}

/** The settled run, its reviewed commits and the base path of `path`, or the closed refusal. */
function reviewedSides(
  store: ReviewRunStore,
  request: ReviewRunDiffRequest,
): ReviewedSides | ReviewRunDiffResult {
  const row = store.get(request.runId);
  if (row === undefined) return { kind: "not-found" };
  if (row.phase !== "settled") return status("not-settled");
  const entry = store.coverageEntries(row.runId).find((item) => item.path === request.path);
  if (entry === undefined) return status("not-in-review");
  const { baseSha, headSha } = row;
  if (baseSha === null || headSha === null) return status("objects-unavailable");
  return { row, baseSha, headSha, basePath: entry.previousPath ?? request.path };
}

function clampedContextLines(requested: number): number {
  return Math.min(Math.max(0, Math.trunc(requested)), REVIEW_RUN_DIFF_CONTEXT_MAX);
}

async function readDiff(
  ctx: GitReviewOperationContext,
  sides: ReviewedSides,
  request: ReviewRunDiffRequest,
  contextLines: number,
): Promise<string | undefined> {
  const { row } = sides;
  if (!(await refsRetained(ctx, row))) return undefined;
  const base = await blobAt(ctx, row, sides.baseSha, sides.basePath);
  const head = await blobAt(ctx, row, sides.headSha, request.path);
  if (base === false || head === false) return undefined;
  return unifiedDiff(ctx, row, { base, head }, contextLines);
}

/** The reviewed diff of `path` in run `runId`, with `contextLines` of context (clamped). */
export async function reviewRunDiff(
  store: ReviewRunStore,
  services: ReviewServices,
  request: ReviewRunDiffRequest,
): Promise<ReviewRunDiffResult> {
  const sides = reviewedSides(store, request);
  if ("kind" in sides) return sides;
  const ctx = { runner: services.reviewRunner(), timeoutMs: 30_000, maxBytes: DIFF_MAX_BYTES };
  const contextLines = clampedContextLines(request.contextLines);
  let diff: string | undefined;
  try {
    diff = await readDiff(ctx, sides, request, contextLines);
  } catch (error) {
    if (!(error instanceof GitReviewOperandError)) throw error;
    reportReviewFailure("review.run.diff", request.correlationId, error);
    return status("objects-unavailable");
  }
  if (diff === undefined) return status("objects-unavailable");
  return {
    kind: "response",
    body: {
      schemaVersion: REVIEW_CONTRACT_VERSION,
      status: "available",
      path: request.path,
      baseSha: sides.baseSha,
      headSha: sides.headSha,
      contextLines,
      diff,
    },
  };
}
