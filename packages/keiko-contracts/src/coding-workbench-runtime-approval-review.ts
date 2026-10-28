import {
  isCodingRuntimeDeliveryReview,
  type CodingRuntimeDeliveryReview,
} from "./coding-runtime-delivery.js";
import { isVerifiedCommitResult, type VerifiedCommitResult } from "./verified-commit.js";
import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import {
  exactKeys,
  invalid,
  isOneOf,
  isRecord,
  validateSafeId,
  validateUntrustedDisplayText,
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
 * evidence. Patch content and file bodies are not part of this contract. A verified commit also
 * carries its bounded intended message for human review; that message stays on this channel.
 */
/**
 * The native OpenCode action a pending approval would run (#3897): the permission OpenCode
 * evaluated and the resources it named (a command line, URLs, or paths). MODEL-SELECTED text,
 * shown so the human decides about the real action; rendered as text, never markup or evidence.
 */
export interface CodingWorkbenchNativeActionReview {
  readonly permission: string;
  readonly resources: readonly string[];
}

export const CODING_WORKBENCH_NATIVE_ACTION_REVIEW_MAX_RESOURCES = 64;
export const CODING_WORKBENCH_NATIVE_ACTION_REVIEW_RESOURCE_MAX_CHARS = 2_048;

export interface CodingWorkbenchRuntimePendingApprovalReview {
  /** Binds the review to the exact pending permission the operator is deciding about. */
  readonly requestId: string;
  /** Present only for a native OpenCode action; edits carry their paths in `paths` as well. */
  readonly nativeAction?: CodingWorkbenchNativeActionReview;
  /** Workspace-relative, deduplicated, in the order the changeset declared them. */
  readonly paths: readonly string[];
  /** True when the changeset declared more files than `paths` carries. */
  readonly pathsTruncated: boolean;
  /** Files the changeset declares — may exceed `paths.length` when truncated. */
  readonly fileCount: number;
  readonly addedLines: number;
  readonly deletedLines: number;
  /** Authenticated, transient human review only; never the durable runtime/event projection. */
  readonly draftDelivery?: CodingRuntimeDeliveryReview;
  readonly verifiedCommit?: { readonly result: VerifiedCommitResult; readonly message: string };
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
  const admitted = checkApprovalReviewChannel(value, errors);
  return admitted && errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkApprovalReviewChannel(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & CodingWorkbenchRuntimeApprovalReviewChannelPayload {
  const session = isOneOf(value.session, CODING_WORKBENCH_RUNTIME_APPROVAL_REVIEW_SESSION_STATES);
  if (!session) {
    errors.push("approvalReviewChannelPayload.session is invalid");
  }
  if (value.session === "unpaired" && value.pending !== undefined) {
    errors.push("approvalReviewChannelPayload.pending must be absent when the session is unpaired");
  }
  const pending =
    value.pending === undefined || validatePendingApprovalReview(value.pending, errors);
  return session && pending;
}

function validatePendingApprovalReview(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimePendingApprovalReview {
  if (!isRecord(value)) {
    errors.push("approvalReviewChannelPayload.pending must be an object");
    return false;
  }
  errors.push(
    ...exactKeys(
      value,
      [
        "requestId",
        "paths",
        "pathsTruncated",
        "fileCount",
        "addedLines",
        "deletedLines",
        "verifiedCommit",
        "draftDelivery",
        "nativeAction",
      ],
      "pendingApprovalReview",
    ),
  );
  const request = validateSafeId(
    value.requestId,
    "pendingApprovalReview.requestId",
    errors,
    CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
  );
  const paths = validatePendingReviewContent(value, errors);
  const truncated = typeof value.pathsTruncated === "boolean";
  if (!truncated) {
    errors.push("pendingApprovalReview.pathsTruncated must be a boolean");
  }
  const fileCount = validateReviewCount(value.fileCount, "fileCount", errors);
  const added = validateReviewCount(value.addedLines, "addedLines", errors);
  const deleted = validateReviewCount(value.deletedLines, "deletedLines", errors);
  validateReviewFileCountConsistency(value, errors);
  const commit = value.verifiedCommit === undefined || validateCommitReview(value, errors);
  return [request, paths, truncated, fileCount, added, deleted, commit].every(Boolean);
}

function validatePendingReviewContent(value: Record<string, unknown>, errors: string[]): boolean {
  if (value.nativeAction !== undefined) return validateNativeActionReview(value, errors);
  if (value.draftDelivery === undefined) return validateReviewPaths(value.paths, errors);
  return validateDraftReview(value, errors);
}

function validateNativeActionReview(pending: Record<string, unknown>, errors: string[]): boolean {
  const before = errors.length;
  const value = pending.nativeAction;
  if (!isRecord(value)) {
    errors.push("nativeAction must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["permission", "resources"], "nativeAction"));
  validateSafeId(value.permission, "nativeAction.permission", errors, 64);
  if (
    !Array.isArray(value.resources) ||
    value.resources.length > CODING_WORKBENCH_NATIVE_ACTION_REVIEW_MAX_RESOURCES ||
    !value.resources.every((resource) =>
      validateUntrustedDisplayText(
        resource,
        CODING_WORKBENCH_NATIVE_ACTION_REVIEW_RESOURCE_MAX_CHARS,
        { minChars: 0 },
      ),
    )
  )
    errors.push("nativeAction.resources must be a bounded array of display text");
  if (pending.draftDelivery !== undefined || pending.verifiedCommit !== undefined)
    errors.push("a native action review cannot carry delivery or commit authority");
  if (!Array.isArray(pending.paths)) {
    errors.push("pendingApprovalReview.paths must be an array");
    return false;
  }
  // Edit asks also carry their contained paths; other native actions carry none.
  if (pending.paths.length > 0) validateReviewPaths(pending.paths, errors);
  return errors.length === before;
}

function validateCommitReview(pending: Record<string, unknown>, errors: string[]): boolean {
  const value = pending.verifiedCommit;
  if (!isRecord(value)) {
    errors.push("verifiedCommit must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["result", "message"], "verifiedCommit"));
  const result =
    isVerifiedCommitResult(value.result) &&
    value.result.status === "approval-required" &&
    value.result.proposalId === pending.requestId;
  if (!result) errors.push("verifiedCommit result must match the pending proposal");
  const display = validateUntrustedDisplayText(value.message, 8192);
  if (!display) errors.push("verifiedCommit.message is invalid");
  const message =
    typeof value.message === "string" &&
    value.message.trim().length !== 0 &&
    !value.message.includes("\0");
  if (!message) errors.push("verifiedCommit.message is invalid");
  return [result, display, message].every(Boolean);
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

function validateReviewPaths(value: unknown, errors: string[]): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("pendingApprovalReview.paths must be a non-empty array");
    return false;
  }
  if (value.length > CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS) {
    errors.push("pendingApprovalReview.paths exceeds the reviewable path cap");
    return false;
  }
  if (new Set(value).size !== value.length) {
    errors.push("pendingApprovalReview.paths must be unique");
  }
  const count = value.length;
  let admitted = true;
  for (let index = 0; index < count; index += 1) {
    const path: unknown = value[index];
    if (!isReviewablePath(path)) {
      errors.push(`pendingApprovalReview.paths[${String(index)}] is not a contained relative path`);
      admitted = false;
      if (!(index in value)) return false;
    }
  }
  return admitted;
}

/**
 * Fails closed on every escape shape the admission boundary already rejects: absolute, drive- or
 * home-anchored, backslash-bearing, NUL-bearing, empty/dot/dot-dot segments, and anything past the
 * length bound. A review surface must never be able to render a path the runtime would refuse.
 */
function isReviewablePath(value: unknown): value is string {
  return (
    validateUntrustedDisplayText(value, CODING_WORKBENCH_APPROVAL_REVIEW_PATH_MAX_CHARS) &&
    !value.includes(":") &&
    isPortableWorkspaceRelativePath(value)
  );
}

function validateReviewCount(value: unknown, key: string, errors: string[]): value is number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > CODING_WORKBENCH_APPROVAL_REVIEW_MAX_COUNT
  ) {
    errors.push(`pendingApprovalReview.${key} must be a bounded non-negative integer`);
    return false;
  }
  return true;
}

function validateDraftReview(pending: Record<string, unknown>, errors: string[]): boolean {
  const value = pending.draftDelivery;
  const delivery =
    isCodingRuntimeDeliveryReview(value) && value.record.proposalId === pending.requestId;
  if (!delivery) errors.push("draftDelivery must match the exact pending proposal");
  if (pending.verifiedCommit !== undefined)
    errors.push("delivery review cannot carry commit authority");
  const counts =
    Array.isArray(pending.paths) &&
    pending.paths.length === 0 &&
    pending.pathsTruncated === false &&
    pending.fileCount === 0 &&
    pending.addedLines === 0 &&
    pending.deletedLines === 0;
  if (!counts) errors.push("delivery review must not claim workspace edit counts");
  return [delivery, counts].every(Boolean);
}
