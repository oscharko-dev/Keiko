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
  result,
  validateSafeId,
  validateUntrustedDisplayText,
} from "./coding-workbench-runtime-api-validation.js";
import { CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS } from "./coding-workbench-runtime-api.js";
import { isPortableWorkspaceRelativePath } from "./workspace-contract-primitives.js";
import { isMcpToolActionName } from "./mcp-servers.js";

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
  /**
   * A write the run's Jira Pod would make, as the exact call the model sent plus the names Jira
   * gave the ids it uses (#4359). The card then reads like Chat's approval of the same write
   * instead of naming a native action. MODEL-SELECTED, display only, like `resources`.
   */
  readonly jira?: CodingWorkbenchNativeJiraWriteReview;
}

/** What Jira itself called the ids of a call, from reads this run already made: [id, name]. */
export type CodingWorkbenchNativeJiraNames = readonly (readonly [string, string])[];

export interface CodingWorkbenchNativeJiraWriteReview {
  /** The Pod tool the call reaches, such as `jira.create`. */
  readonly tool: string;
  /** The call's arguments as plain JSON. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly names: {
    readonly projects: CodingWorkbenchNativeJiraNames;
    readonly issueTypes: CodingWorkbenchNativeJiraNames;
    readonly fields: CodingWorkbenchNativeJiraNames;
  };
}

export const CODING_WORKBENCH_NATIVE_JIRA_REVIEW_MAX_INPUT_CHARS = 16_384;
export const CODING_WORKBENCH_NATIVE_JIRA_REVIEW_MAX_NAMES = 64;

export const CODING_WORKBENCH_NATIVE_ACTION_REVIEW_MAX_RESOURCES = 64;
export const CODING_WORKBENCH_NATIVE_ACTION_REVIEW_RESOURCE_MAX_CHARS = 2_048;

/** Why a governed verification names no command yet; a plain sentence on the card, never empty. */
export const CODING_WORKBENCH_VERIFICATION_PREVIEW_DEFERRALS = [
  "targeted-test",
  "package-selection",
  "host-setup",
] as const;
export type CodingWorkbenchVerificationPreviewDeferral =
  (typeof CODING_WORKBENCH_VERIFICATION_PREVIEW_DEFERRALS)[number];

/** Closed reasons a preview could not be produced; the card falls back to the class label. */
export const CODING_WORKBENCH_VERIFICATION_PREVIEW_UNAVAILABLE_REASONS = [
  "workspace-unresolved",
  "no-runnable-step",
  "preview-failed",
] as const;
export type CodingWorkbenchVerificationPreviewUnavailableReason =
  (typeof CODING_WORKBENCH_VERIFICATION_PREVIEW_UNAVAILABLE_REASONS)[number];

export const CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS = 8;
export const CODING_WORKBENCH_VERIFICATION_PREVIEW_COMMAND_MAX_CHARS = 1_024;

/**
 * What a governed verification ask (`test`, `typecheck`, `lint`, `build`) would run, resolved from
 * the project the way the runner plans it. The command lines are MODEL-INFLUENCED project content
 * shown to the person who approves: they carry only the content (credential-floor) projection,
 * travel only on the authenticated review channel, and never reach evidence or the Activity Log.
 * A line longer than the cap is cut and ends in an ellipsis, and `truncated` says so.
 */
export type CodingWorkbenchVerificationPreview =
  | {
      readonly status: "commands";
      readonly commands: readonly string[];
      readonly truncated: boolean;
    }
  | {
      readonly status: "deferred";
      readonly reason: CodingWorkbenchVerificationPreviewDeferral;
    }
  | {
      readonly status: "unavailable";
      readonly reason: CodingWorkbenchVerificationPreviewUnavailableReason;
    };

export const CODING_WORKBENCH_GIT_BRANCH_REVIEW_NAME_MAX_CHARS = 255;

/** The task branch a pending `git-branch` approval would create and switch to. */
export interface CodingWorkbenchGitBranchReview {
  readonly branchName: string;
}

export interface CodingWorkbenchRuntimePendingApprovalReview {
  /** Binds the review to the exact pending permission the operator is deciding about. */
  readonly requestId: string;
  /** Present only for a native OpenCode action; edits carry their paths in `paths` as well. */
  readonly nativeAction?: CodingWorkbenchNativeActionReview;
  /** Present only for a governed verification ask; carries no paths. */
  readonly verificationPreview?: CodingWorkbenchVerificationPreview;
  /**
   * Present only for a governed task-branch ask (`git-branch`, #4491 U-27): the branch Approve
   * would create and switch to, so the person sees what they approve. A ref name, not a secret;
   * it carries no paths.
   */
  readonly gitBranch?: CodingWorkbenchGitBranchReview;
  /** Workspace-relative, deduplicated, in the order the changeset declared them. */
  readonly paths: readonly string[];
  /** True when the changeset declared more files than `paths` carries. */
  readonly pathsTruncated: boolean;
  /** Files the changeset declares — may exceed `paths.length` when truncated. */
  readonly fileCount: number;
  readonly addedLines: number;
  readonly deletedLines: number;
  /**
   * True when a file was too large to count: `addedLines` and `deletedLines` then cover the other
   * files only. An honest marker, never a silent zero.
   */
  readonly countsUnavailable?: boolean;
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
      [
        "requestId",
        "paths",
        "pathsTruncated",
        "fileCount",
        "addedLines",
        "deletedLines",
        "countsUnavailable",
        "verifiedCommit",
        "draftDelivery",
        "nativeAction",
        "verificationPreview",
        "gitBranch",
      ],
      "pendingApprovalReview",
    ),
  );
  validateSafeId(
    value.requestId,
    "pendingApprovalReview.requestId",
    errors,
    CODING_WORKBENCH_RUNTIME_API_ID_MAX_CHARS,
  );
  if (value.nativeAction !== undefined) validateNativeActionReview(value, errors);
  else if (value.verificationPreview !== undefined)
    validateVerificationPreviewReview(value, errors);
  else if (value.gitBranch !== undefined) validateGitBranchReview(value, errors);
  else if (value.draftDelivery === undefined)
    validateReviewPaths(value.paths, errors, value.verifiedCommit !== undefined);
  else validateDraftReview(value, errors);
  if (typeof value.pathsTruncated !== "boolean") {
    errors.push("pendingApprovalReview.pathsTruncated must be a boolean");
  }
  validateReviewCount(value.fileCount, "fileCount", errors);
  validateReviewCount(value.addedLines, "addedLines", errors);
  validateReviewCount(value.deletedLines, "deletedLines", errors);
  if (value.countsUnavailable !== undefined && typeof value.countsUnavailable !== "boolean")
    errors.push("pendingApprovalReview.countsUnavailable must be a boolean");
  validateReviewFileCountConsistency(value, errors);
  if (value.verifiedCommit !== undefined) validateCommitReview(value, errors);
}

function validateNativeActionReview(pending: Record<string, unknown>, errors: string[]): void {
  const value = pending.nativeAction;
  if (!isRecord(value)) {
    errors.push("nativeAction must be an object");
    return;
  }
  errors.push(...exactKeys(value, ["permission", "resources", "jira"], "nativeAction"));
  if (value.jira !== undefined) validateNativeJiraReview(value.jira, errors);
  if (!isMcpToolActionName(value.permission))
    validateSafeId(value.permission, "nativeAction.permission", errors, 64);
  if (!validNativeResources(value.resources))
    errors.push("nativeAction.resources must be a bounded array of display text");
  if (pending.draftDelivery !== undefined || pending.verifiedCommit !== undefined)
    errors.push("a native action review cannot carry delivery or commit authority");
  if (!Array.isArray(pending.paths)) {
    errors.push("pendingApprovalReview.paths must be an array");
    return;
  }
  // Edit asks also carry their contained paths; other native actions carry none.
  if (pending.paths.length > 0) validateReviewPaths(pending.paths, errors);
}

function validateGitBranchReview(pending: Record<string, unknown>, errors: string[]): void {
  if (
    pending.draftDelivery !== undefined ||
    pending.verifiedCommit !== undefined ||
    !Array.isArray(pending.paths) ||
    pending.paths.length > 0
  )
    errors.push("a git branch review carries no paths, delivery or commit authority");
  const value = pending.gitBranch;
  if (!isRecord(value)) {
    errors.push("gitBranch must be an object");
    return;
  }
  errors.push(...exactKeys(value, ["branchName"], "gitBranch"));
  if (
    !validateUntrustedDisplayText(
      value.branchName,
      CODING_WORKBENCH_GIT_BRANCH_REVIEW_NAME_MAX_CHARS,
    )
  )
    errors.push("gitBranch.branchName must be bounded display text");
}

function validateVerificationPreviewReview(
  pending: Record<string, unknown>,
  errors: string[],
): void {
  if (
    pending.draftDelivery !== undefined ||
    pending.verifiedCommit !== undefined ||
    !Array.isArray(pending.paths) ||
    pending.paths.length > 0
  )
    errors.push("a verification preview review carries no paths, delivery or commit authority");
  const value = pending.verificationPreview;
  if (!isRecord(value)) {
    errors.push("verificationPreview must be an object");
    return;
  }
  const shape =
    typeof value.status === "string" && Object.hasOwn(PREVIEW_SHAPES, value.status)
      ? PREVIEW_SHAPES[value.status]
      : undefined;
  if (shape === undefined) {
    errors.push("verificationPreview.status is invalid");
    return;
  }
  errors.push(...exactKeys(value, shape.keys, "verificationPreview"));
  if (!shape.valid(value)) errors.push(shape.message);
}

interface PreviewShape {
  readonly keys: readonly string[];
  readonly valid: (value: Record<string, unknown>) => boolean;
  readonly message: string;
}

const PREVIEW_SHAPES: Readonly<Record<string, PreviewShape | undefined>> = {
  commands: {
    keys: ["status", "commands", "truncated"],
    valid: (value) => validPreviewCommands(value.commands) && typeof value.truncated === "boolean",
    message: "verificationPreview.commands must be 1 to 8 bounded display lines",
  },
  deferred: {
    keys: ["status", "reason"],
    valid: (value) => isOneOf(value.reason, CODING_WORKBENCH_VERIFICATION_PREVIEW_DEFERRALS),
    message: "verificationPreview.reason is invalid",
  },
  unavailable: {
    keys: ["status", "reason"],
    valid: (value) =>
      isOneOf(value.reason, CODING_WORKBENCH_VERIFICATION_PREVIEW_UNAVAILABLE_REASONS),
    message: "verificationPreview.reason is invalid",
  },
};

function validPreviewCommands(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= CODING_WORKBENCH_VERIFICATION_PREVIEW_MAX_COMMANDS &&
    value.every((line) =>
      validateUntrustedDisplayText(line, CODING_WORKBENCH_VERIFICATION_PREVIEW_COMMAND_MAX_CHARS),
    )
  );
}

function validNativeResources(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= CODING_WORKBENCH_NATIVE_ACTION_REVIEW_MAX_RESOURCES &&
    value.every((resource) =>
      validateUntrustedDisplayText(
        resource,
        CODING_WORKBENCH_NATIVE_ACTION_REVIEW_RESOURCE_MAX_CHARS,
        { minChars: 0 },
      ),
    )
  );
}

function validateNativeJiraReview(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("nativeAction.jira must be an object");
    return;
  }
  errors.push(...exactKeys(value, ["tool", "input", "names"], "nativeAction.jira"));
  if (!validateUntrustedDisplayText(value.tool, 128))
    errors.push("nativeAction.jira.tool must be display text");
  if (
    !isRecord(value.input) ||
    JSON.stringify(value.input).length > CODING_WORKBENCH_NATIVE_JIRA_REVIEW_MAX_INPUT_CHARS
  )
    errors.push("nativeAction.jira.input must be a bounded JSON object");
  if (!isRecord(value.names)) {
    errors.push("nativeAction.jira.names must be an object");
    return;
  }
  errors.push(
    ...exactKeys(value.names, ["projects", "issueTypes", "fields"], "nativeAction.jira.names"),
  );
  for (const family of ["projects", "issueTypes", "fields"] as const)
    if (!validNativeJiraNames(value.names[family]))
      errors.push(`nativeAction.jira.names.${family} must be bounded [id, name] pairs`);
}

function validNativeJiraNames(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= CODING_WORKBENCH_NATIVE_JIRA_REVIEW_MAX_NAMES &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        validateUntrustedDisplayText(entry[0], 128) &&
        validateUntrustedDisplayText(entry[1], 256),
    )
  );
}

function validateCommitReview(pending: Record<string, unknown>, errors: string[]): void {
  const value = pending.verifiedCommit;
  if (!isRecord(value)) {
    errors.push("verifiedCommit must be an object");
    return;
  }
  errors.push(...exactKeys(value, ["result", "message"], "verifiedCommit"));
  if (
    !isVerifiedCommitResult(value.result) ||
    value.result.status !== "approval-required" ||
    value.result.proposalId !== pending.requestId
  )
    errors.push("verifiedCommit result must match the pending proposal");
  if (!validateUntrustedDisplayText(value.message, 8192))
    errors.push("verifiedCommit.message is invalid");
  if (
    typeof value.message !== "string" ||
    value.message.trim().length === 0 ||
    value.message.includes("\0")
  )
    errors.push("verifiedCommit.message is invalid");
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

function validateReviewPaths(value: unknown, errors: string[], fromRepository = false): void {
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
    if (!(fromRepository ? isReviewableRepositoryPath(path) : isReviewablePath(path))) {
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
    validateUntrustedDisplayText(value, CODING_WORKBENCH_APPROVAL_REVIEW_PATH_MAX_CHARS) &&
    !value.includes(":") &&
    isPortableWorkspaceRelativePath(value)
  );
}

/**
 * A staged path as the repository spells it. The commit review lists paths the person's own Git
 * reported, never a model-selected changeset, and Git names any byte sequence a POSIX filesystem
 * holds: a colon or a backslash is an ordinary character there, and Git itself never emits a
 * Windows separator or drive. Those two stay legal; everything that makes a path escape does not:
 * absolute, home- or drive-anchored, NUL, empty/dot/dot-dot segments (a backslash also splits a
 * segment, so `..\x` is refused), a leading backslash (a UNC or `\\?\` name, refused outright as
 * the fail-closed choice: no real repository path starts that way), invisible format characters
 * and anything past the length bound. The path is display text only: the card shows it and no
 * file operation ever resolves it, so this check keeps the card honest and not the filesystem safe.
 */
function isReviewableRepositoryPath(value: unknown): boolean {
  return (
    validateUntrustedDisplayText(value, CODING_WORKBENCH_APPROVAL_REVIEW_PATH_MAX_CHARS) &&
    !value.startsWith("\\") &&
    !value.split(/[/\\]/u).includes("..") &&
    isPortableWorkspaceRelativePath(value.replaceAll("\\", "_"))
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

function validateDraftReview(pending: Record<string, unknown>, errors: string[]): void {
  const value = pending.draftDelivery;
  if (!isCodingRuntimeDeliveryReview(value) || value.record.proposalId !== pending.requestId)
    errors.push("draftDelivery must match the exact pending proposal");
  if (pending.verifiedCommit !== undefined)
    errors.push("delivery review cannot carry commit authority");
  if (
    !Array.isArray(pending.paths) ||
    pending.paths.length !== 0 ||
    pending.pathsTruncated !== false ||
    pending.fileCount !== 0 ||
    pending.addedLines !== 0 ||
    pending.deletedLines !== 0
  )
    errors.push("delivery review must not claim workspace edit counts");
}
