import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import {
  exactKeys,
  invalid,
  isOneOf,
  isRecord,
  result,
  validateSafeId,
} from "./coding-workbench-runtime-api-validation.js";
import { CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS } from "./coding-workbench-runtime-api.js";
import { isPortableWorkspaceRelativePath } from "./workspace-contract-primitives.js";

/**
 * The governed edit changeset cap (ADR-0125 D3, `EDITOR_AGENT_CHANGESET_MAX_FILES`). The runtime
 * admission projection and this review contract share ONE bound so a reviewable path list can never
 * be wider than the changeset the operator is deciding about.
 */
export const CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS = 50;

/** Upper bound on one reviewable workspace-relative path; matches the runtime admission bound. */
export const CODING_WORKBENCH_APPROVAL_REVIEW_PATH_MAX_CHARS = 512;

/** Upper bound on a reviewable line/file count; matches the runtime admission bound. */
export const CODING_WORKBENCH_APPROVAL_REVIEW_MAX_COUNT = 1_000_000;

/** Session facet of a channel-carried approval review: the status of the presented cookie only. */
export const CODING_WORKBENCH_RUNTIME_APPROVAL_REVIEW_SESSION_STATES = [
  "active",
  "unpaired",
] as const;

export type CodingWorkbenchRuntimeApprovalReviewSession =
  (typeof CODING_WORKBENCH_RUNTIME_APPROVAL_REVIEW_SESSION_STATES)[number];

/**
 * The reviewable facts of the changeset a pending `file-edit` approval would write: which
 * workspace-relative files it touches and how large the change is.
 *
 * A human cannot exercise control over a change they are not shown (ADR-0129 D1). The governed
 * runtime already receives these facts at the admission boundary; this is the contract that carries
 * them to the operator.
 *
 * The paths are MODEL-SELECTED and therefore untrusted: they travel only over the authenticated
 * app-session channel, never through a general runtime snapshot or the SSE projection (#2644), they
 * are rendered as transient text and never as markup, and they are never written to durable
 * evidence. `patch content`, file bodies and model prose are NOT part of this contract and must
 * never be added to it — the reviewable unit is the path and the magnitude, not the bytes.
 */
export interface CodingWorkbenchRuntimePendingApprovalReview {
  /** Binds the review to the exact pending permission the operator is deciding about. */
  readonly requestId: string;
  /** Workspace-relative, deduplicated, in the order the changeset declared them. */
  readonly paths: readonly string[];
  /** True when the changeset declared more files than `paths` carries. */
  readonly pathsTruncated: boolean;
  /** Files the changeset declares — may exceed `paths.length` when truncated. */
  readonly fileCount: number;
  readonly addedLines: number;
  readonly deletedLines: number;
}

/**
 * Pending approval-review state as carried over the authenticated app-session channel
 * (#2478, #2644, ADR-0141).
 *
 * `session` reflects only whether the caller's own presented cookie is a valid app session — never
 * the existence of a run or of a pending approval — so an unpaired browser renders an honest
 * re-pair state instead of a silent "nothing to review", and the payload is not an existence
 * oracle.
 */
export interface CodingWorkbenchRuntimeApprovalReviewChannelPayload {
  readonly session: CodingWorkbenchRuntimeApprovalReviewSession;
  readonly pending?: CodingWorkbenchRuntimePendingApprovalReview | undefined;
}

/**
 * The single source of the constant content-free projection every unauthenticated caller of the
 * approval-review route receives (ADR-0141 D6): independent of run existence, runtime
 * configuration, and pending-approval state.
 */
export function unpairedCodingWorkbenchRuntimeApprovalReviewChannelPayload(): CodingWorkbenchRuntimeApprovalReviewChannelPayload {
  return { session: "unpaired" };
}

/**
 * Validate a channel-carried approval-review payload: exact keys, a valid session facet, bounded
 * workspace-relative paths, bounded counts, and the invariant that an `unpaired` payload carries no
 * review state at all.
 */
export function validateCodingWorkbenchRuntimeApprovalReviewChannelPayload(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeApprovalReviewChannelPayload> {
  if (!isRecord(value)) return invalid("approval review channel payload must be an object");
  const errors = exactKeys(value, ["session", "pending"], "approvalReviewChannelPayload");
  if (!isOneOf(value.session, CODING_WORKBENCH_RUNTIME_APPROVAL_REVIEW_SESSION_STATES)) {
    errors.push("approvalReviewChannelPayload.session is invalid");
  }
  if (value.session === "unpaired" && value.pending !== undefined) {
    errors.push("approvalReviewChannelPayload.pending must be absent when the session is unpaired");
  }
  if (value.pending !== undefined) validatePendingApprovalReview(value.pending, errors);
  return result(value, errors);
}

function validatePendingApprovalReview(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("approvalReviewChannelPayload.pending must be an object");
    return;
  }
  errors.push(
    ...exactKeys(
      value,
      ["requestId", "paths", "pathsTruncated", "fileCount", "addedLines", "deletedLines"],
      "pendingApprovalReview",
    ),
  );
  validateSafeId(
    value.requestId,
    "pendingApprovalReview.requestId",
    errors,
    CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
  );
  validateReviewPaths(value.paths, errors);
  if (typeof value.pathsTruncated !== "boolean") {
    errors.push("pendingApprovalReview.pathsTruncated must be a boolean");
  }
  validateReviewCount(value.fileCount, "fileCount", errors);
  validateReviewCount(value.addedLines, "addedLines", errors);
  validateReviewCount(value.deletedLines, "deletedLines", errors);
  validateReviewFileCountConsistency(value, errors);
}

/**
 * `fileCount` is the changeset's own declared file count. It may exceed the carried path list only
 * when the list is explicitly marked truncated; anything else would let a card understate or
 * overstate the blast radius of the change the operator is approving.
 */
function validateReviewFileCountConsistency(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (!Array.isArray(value.paths) || typeof value.fileCount !== "number") return;
  const carried = value.paths.length;
  if (value.pathsTruncated === true && value.fileCount > carried) return;
  if (value.fileCount !== carried) {
    errors.push("pendingApprovalReview.fileCount must match the carried path list");
  }
}

function validateReviewPaths(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("pendingApprovalReview.paths must be a non-empty array");
    return;
  }
  if (value.length > CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS) {
    errors.push("pendingApprovalReview.paths exceeds the reviewable path cap");
    return;
  }
  if (new Set(value).size !== value.length) {
    errors.push("pendingApprovalReview.paths must be unique");
  }
  value.forEach((path, index) => {
    if (!isReviewablePath(path)) {
      errors.push(`pendingApprovalReview.paths[${String(index)}] is not a contained relative path`);
    }
  });
}

/**
 * Fails closed on every escape shape the admission boundary already rejects: absolute, drive- or
 * home-anchored, backslash-bearing, NUL-bearing, empty/dot/dot-dot segments, and anything past the
 * length bound. A review surface must never be able to render a path the runtime would refuse.
 */
function isReviewablePath(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= CODING_WORKBENCH_APPROVAL_REVIEW_PATH_MAX_CHARS &&
    !value.includes(":") &&
    isPortableWorkspaceRelativePath(value)
  );
}

function validateReviewCount(value: unknown, key: string, errors: string[]): void {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > CODING_WORKBENCH_APPROVAL_REVIEW_MAX_COUNT
  ) {
    errors.push(`pendingApprovalReview.${key} must be a bounded non-negative integer`);
  }
}
