// The reviewed diff of one file (Issue #4136): base-to-head, read from the Git objects the run's
// private refs retain (child 3), never from a working tree, so it is available after the review
// worktree is gone. Once the retention sweep removed the refs, it is refused `objects-unavailable`.
// Only a path the run's coverage lists can be read; the context is bounded.

import {
  REVIEW_CONTRACT_VERSION,
  REVIEW_RUN_DIFF_CONTEXT_MAX,
  type ReviewRunDiffResponse,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import {
  diffGitReviewBlobs,
  readGitReviewBlob,
  readGitReviewPathObject,
  resolveGitReviewCommit,
  type GitReviewOperationContext,
} from "@oscharko-dev/keiko-git";

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

/** The reviewed diff of `path` in run `runId`, with `contextLines` of context (clamped). */
export async function reviewRunDiff(
  store: ReviewRunStore,
  services: ReviewServices,
  request: { readonly runId: string; readonly path: string; readonly contextLines: number },
): Promise<ReviewRunDiffResult> {
  const row = store.get(request.runId);
  if (row === undefined) return { kind: "not-found" };
  if (row.phase !== "settled") return status("not-settled");
  if (!store.coverageEntries(row.runId).some((entry) => entry.path === request.path)) {
    return status("not-in-review");
  }
  const { baseSha, headSha } = row;
  if (baseSha === null || headSha === null) return status("objects-unavailable");
  const ctx = { runner: services.reviewRunner(), timeoutMs: 30_000, maxBytes: DIFF_MAX_BYTES };
  if (!(await refsRetained(ctx, row))) return status("objects-unavailable");
  const base = await blobAt(ctx, row, baseSha, request.path);
  const head = await blobAt(ctx, row, headSha, request.path);
  if (base === false || head === false) return status("objects-unavailable");
  const contextLines = Math.min(
    Math.max(0, Math.trunc(request.contextLines)),
    REVIEW_RUN_DIFF_CONTEXT_MAX,
  );
  const diff = await unifiedDiff(ctx, row, { base, head }, contextLines);
  if (diff === undefined) return status("objects-unavailable");
  return {
    kind: "response",
    body: {
      schemaVersion: REVIEW_CONTRACT_VERSION,
      status: "available",
      path: request.path,
      baseSha,
      headSha,
      contextLines,
      diff,
    },
  };
}
