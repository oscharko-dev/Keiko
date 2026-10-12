import { deepFreeze } from "./deep-freeze.js";
import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
  CodingWorkbenchModelSource,
  CodingWorkbenchRuntimeSource,
  CodingWorkbenchValidationResult,
} from "./coding-workbench.js";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_CONNECTOR_SCOPES,
  CODING_WORKBENCH_MODEL_SOURCES,
  CODING_WORKBENCH_MODES,
  CODING_WORKBENCH_RUNTIME_SOURCES,
} from "./coding-workbench.js";
import { validateCodingWorkbenchAuthorityEnvelope } from "./coding-workbench-validation.js";
// Shared runtime contract version + vocabularies live on a dependency-free leaf (KEIKO-0532) so
// this module and coding-workbench-runtime-api-validation.ts can both depend on them without
// depending on each other for it. Re-exported below so existing consumers of this module (index.ts,
// coding-workbench-runtime-api.ts, code-task-governance.ts) see no change to the public surface.
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  CODING_WORKBENCH_RUNTIME_FAILURE_CODES,
  CODING_WORKBENCH_RUNTIME_STATE_NAMES,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeStateName,
} from "./coding-workbench-runtime-constants.js";
// The object/enum-member/exact-key/result/strict-UTC-instant validation primitives are owned by
// coding-workbench-runtime-api-validation.ts alone; this module no longer keeps its own copies.
import {
  exactKeys,
  isOneOf,
  isRecord,
  validateStrictUtcInstant,
} from "./coding-workbench-runtime-api-validation.js";
// The GitHub issue reference parser is a dependency-free leaf (#3385). Its runtime surface is
// re-exported from HERE so the server and the browser reach it through the existing
// `runtime/coding-workbench-runtime` subpath; the barrel exposes the same names as types only.
import { GITHUB_ISSUE_REFERENCE_MAX_CHARS } from "./github-issue-reference.js";
// The transport bound on a repository path is owned by the GitHub-authorization wire (#3385):
// the preview request names a repository the same way, so it takes the same bound rather than a
// second number that could drift from it.
import { MAX_GITHUB_ISSUE_READER_REPOSITORY_PATH_CHARS } from "./bff-wire.js";
// No longer imported as a value here: the execution binding never carries `issueBinding` (epic
// #3384 correction 8), so this module has nothing left to validate it against. Still re-exported
// for existing consumers of this subpath.
export { validateCodingWorkbenchIssueBinding } from "./coding-workbench-issue-binding.js";

export {
  canonicalGitHubOwnerAndRepo,
  findGitHubIssueReferences,
  GITHUB_ISSUE_NUMBER_MAX,
  GITHUB_ISSUE_REFERENCE_MAX_CHARS,
  GITHUB_ISSUE_REFERENCE_REJECTIONS,
  isGitHubOwnerAndRepo,
  parseGitHubIssueNumber,
  parseGitHubIssueReference,
  sameGitHubOwnerAndRepo,
} from "./github-issue-reference.js";
export type {
  GitHubIssueReference,
  GitHubIssueReferenceParseResult,
  GitHubIssueReferenceRejection,
  ParseGitHubIssueReferenceOptions,
} from "./github-issue-reference.js";

export {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  CODING_WORKBENCH_RUNTIME_FAILURE_CODES,
  CODING_WORKBENCH_RUNTIME_STATE_NAMES,
};
export type { CodingWorkbenchRuntimeFailureCode, CodingWorkbenchRuntimeStateName };
export const CODING_WORKBENCH_TASK_INTENT_MAX_CHARS = 65_536;

export type CodingWorkbenchLifecycleCommand = "start" | "stop" | "takeover" | "recover";
export const CODING_WORKBENCH_LIFECYCLE_COMMANDS: readonly CodingWorkbenchLifecycleCommand[] =
  Object.freeze(["start", "stop", "takeover", "recover"] as const);

export type CodingWorkbenchRuntimeIntent =
  | {
      readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
      readonly requestId: string;
      readonly command: "start";
      /** Transient model input. It must never be copied into runtime state, events, or evidence. */
      readonly taskIntent: string;
      readonly requestedMode: CodingWorkbenchMode;
      readonly modelSource: CodingWorkbenchModelSource;
    }
  | {
      readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
      readonly requestId: string;
      readonly command: Exclude<CodingWorkbenchLifecycleCommand, "start">;
      readonly runId: string;
    };

export interface CodingWorkbenchRuntimeState {
  readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly revision: number;
  readonly updatedAt: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly runtimeSource?: CodingWorkbenchRuntimeSource | undefined;
  readonly modelSource?: CodingWorkbenchModelSource | undefined;
  readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
}

// Deliberately carries no `issueBinding`: the issue binding is a fact of the run's public
// snapshot only (`CodingWorkbenchRuntimeSnapshot.issueBinding`), never of the execution binding or
// the authority envelope/facts that embed it — restating it here would create a second source of
// truth for the same fact (epic #3384 correction 8).
export interface CodingWorkbenchRuntimeExecutionBinding {
  readonly taskId: string;
  readonly projectId: string;
  readonly projectDigest: string;
  readonly workspaceId: string;
  readonly workspaceRootDigest: string;
  readonly branchRef: string;
  readonly branchHeadDigest: string;
}

/**
 * Why an issue could not be bound to a run. Closed vocabulary, so a caller can render a specific,
 * actionable state instead of a generic failure, and so no reason can be invented at a call site.
 *
 * `repository-mismatch` is the one that must never be papered over: the pasted issue names a
 * different repository than the bound workspace, and the product asks the user to switch, open or
 * clone rather than silently retargeting the run.
 */
export type CodingWorkbenchIssueBindingFailure =
  | "invalid-reference"
  | "repository-mismatch"
  | "auth-required"
  | "issue-unavailable"
  | "clone-failed"
  | "authority-denied"
  | "cancelled";

export const CODING_WORKBENCH_ISSUE_BINDING_FAILURES: readonly CodingWorkbenchIssueBindingFailure[] =
  Object.freeze([
    "invalid-reference",
    "repository-mismatch",
    "auth-required",
    "issue-unavailable",
    "clone-failed",
    "authority-denied",
    "cancelled",
  ] as const);

/**
 * Why a run start refused the chosen model with a sentence of its own (#3603), carried beside the
 * `model-unavailable` failure code as `modelRefusalReason`: the model's window cannot hold a coding
 * run's prompt, or the verification that could prove a larger window is still running. Every other
 * model refusal carries no reason and keeps the generic sentence.
 */
export type CodingWorkbenchModelRefusalReason =
  "model-context-window-insufficient" | "model-verification-pending";

/**
 * The server-resolved, immutable facts that bind one run to exactly one GitHub issue.
 *
 * Deliberately NOT a second run binding. Task, project, workspace and branch identity already live
 * on `CodingWorkbenchRuntimeExecutionBinding`, and a run carries exactly one of those; restating
 * them here would create two sources of truth for the same facts and a way for them to disagree.
 * This interface adds only what the issue itself contributes.
 *
 * Every field is content-free. The issue title, body and comments are transient model context and
 * never reach a snapshot, an evidence record or a log line; what persists is
 * `contentRevisionDigest`, which changes when the issue text changes and therefore invalidates a
 * claim made against the old text without ever storing it.
 */
export interface CodingWorkbenchIssueBinding {
  readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  /**
   * The content-free repository identity the task workspace already derives
   * (`deriveRepositoryId`), so the binding and the workspace name the same repository by the same
   * value rather than by two independently-minted ids.
   */
  readonly repositoryId: string;
  /**
   * sha256 of the canonical (lower-cased) `owner/repo` the checkout's configured remote resolves
   * to. The remote URL itself never leaves the server, so a binding can be compared against the
   * live remote without an endpoint reaching a response or an evidence document; digesting the
   * canonical repository rather than the URL string means an `https` and an `ssh` clone of one
   * repository agree, and a checkout repointed at another repository does not.
   */
  readonly remoteDigest: string;
  /** The issue number as displayed to the user. Positive, and bounded by the provider's range. */
  readonly issueNumber: number;
  /**
   * Digest of the provider-assigned immutable issue id. A transferred or renumbered issue keeps its
   * number in the URL the user pasted but changes this value, which is how the run detects that the
   * thing it was accepted for is no longer the thing behind that number.
   */
  readonly issueIdDigest: string;
  /**
   * The server-resolved default branch of the bound repository. This is the run envelope's base
   * ref, the branch a published pull request targets, and the branch GitHub closes the issue
   * against — one fact, resolved once, so those three cannot drift apart.
   */
  readonly defaultBaseRef: string;
  /** sha256 over the bounded issue content actually read, never the content. */
  readonly contentRevisionDigest: string;
  /** sha256 over every field above; downstream stages bind to this single opaque value. */
  readonly bindingDigest: string;
}

/** The bound issue's lifecycle as the provider reports it; only `open` may be bound to a run. */
export type CodingWorkbenchIssueState = "open" | "closed";
export const CODING_WORKBENCH_ISSUE_STATES: readonly CodingWorkbenchIssueState[] = Object.freeze([
  "open",
  "closed",
] as const);

/** Bounds on the browser-facing preview: a title and an excerpt, never the whole issue. */
export const CODING_WORKBENCH_ISSUE_PREVIEW_TITLE_MAX_CHARS = 256;
export const CODING_WORKBENCH_ISSUE_PREVIEW_EXCERPT_MAX_CHARS = 2_048;
/** One pasted reference; re-stated from the parser leaf so consumers need only this module. */
export const CODING_WORKBENCH_ISSUE_REF_MAX_CHARS = GITHUB_ISSUE_REFERENCE_MAX_CHARS;

export interface CodingWorkbenchIssuePreviewProvenance {
  /** The repository the issue was read from, as the checkout's remote resolves it. */
  readonly ownerAndRepo: string;
  readonly issueNumber: number;
  /** Server-constructed canonical issue URL, never the provider's own `html_url` echoed back. */
  readonly url: string;
}

/**
 * What the browser shows before the user confirms (#3385). Transient and untrusted by
 * construction: `untrusted` is a literal so a consumer cannot forget it, and the text fields are
 * bounded so the preview is a glance at the issue, not a copy of it. It never enters a snapshot,
 * a log line or an evidence record — the binding beside it is what persists.
 */
export interface CodingWorkbenchIssuePreview {
  readonly untrusted: true;
  readonly title: string;
  readonly bodyExcerpt: string;
  readonly bodyExcerptTruncated: boolean;
  readonly commentCount: number;
  readonly comments?: readonly string[] | undefined;
  readonly commentsTruncated?: boolean | undefined;
  readonly state: CodingWorkbenchIssueState;
  readonly provenance: CodingWorkbenchIssuePreviewProvenance;
}

/** `POST /api/coding-workbench/issue/preview`: a registered repository and one pasted reference. */
export interface CodingWorkbenchIssuePreviewRequestWire {
  /**
   * Intent, not authority: the server accepts the path only if it names an already-registered
   * project, resolves the canonical root itself, and derives every identity from that root.
   */
  readonly repositoryPath: string;
  /** Raw user text — an issue URL, `owner/repo#n`, or `#n` relative to the repository's remote. */
  readonly issueRef: string;
}

/**
 * The content-free half of a successful preview: what the browser may show as the canonical
 * reference. `contentRevisionDigest` and `schemaVersion` stay server-side; the browser never
 * authors a binding, so it has no use for the fields that only a producer needs.
 */
export type CodingWorkbenchIssueBindingProjection = Pick<
  CodingWorkbenchIssueBinding,
  | "repositoryId"
  | "remoteDigest"
  | "issueNumber"
  | "issueIdDigest"
  | "defaultBaseRef"
  | "bindingDigest"
>;

export interface CodingWorkbenchIssuePreviewResponseWire {
  readonly preview: CodingWorkbenchIssuePreview;
  readonly binding: CodingWorkbenchIssueBindingProjection;
}

/** The typed refusal: the closed failure beside the standard error envelope. */
export interface CodingWorkbenchIssuePreviewFailureWire {
  readonly failure: CodingWorkbenchIssueBindingFailure;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId?: string | undefined;
  };
}

export interface CodingWorkbenchRuntimeAuthorityEnvelope {
  readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
  readonly authority: CodingWorkbenchAuthorityEnvelope;
  readonly binding: CodingWorkbenchRuntimeExecutionBinding;
  readonly intentDigest: string;
  readonly nonceDigest: string;
  readonly issuedAt: string;
}

export interface CodingWorkbenchRuntimeMintConfirmation {
  readonly approvalId: string;
  readonly approvalToken: string;
  readonly taskId: string;
  readonly operatorId: string;
  readonly intentDigest: string;
  readonly expiresAt: string;
}

export interface CodingWorkbenchRuntimeAuthorityFacts {
  readonly binding: CodingWorkbenchRuntimeExecutionBinding;
  readonly actionClasses: readonly CodingWorkbenchActionClass[];
  readonly connectorScopes: readonly CodingWorkbenchConnectorScope[];
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly budgetDigest: string;
  readonly commandPolicyDigest: string;
  readonly networkPolicyDigest: string;
  readonly gatesDigest: string;
  readonly branchConstraintsDigest: string;
  readonly modelProfileDigest: string;
  /**
   * Content-free fingerprint of the issue bound to this run (`CodingWorkbenchIssueBinding.bindingDigest`),
   * absent when no issue is bound. This is NOT the execution binding restated: the binding never
   * carries `issueBinding` (epic #3384 correction 8 — the issue binding is a fact of the run's public
   * snapshot only, `CodingWorkbenchRuntimeSnapshot.issueBinding`). This digest exists solely so the
   * runtime-authority drift check can still detect a mid-run rebind to a different issue without a
   * second copy of the binding itself, the same content-free-fingerprint pattern already used by
   * `CodingWorkbenchDraftDeliveryBinding.issueBindingDigest` (draft-delivery.ts) and
   * `CodingWorkbenchVerifiedCommitRecord.issueBindingDigest` (verified-commit.ts).
   */
  readonly issueBindingDigest?: string | undefined;
}

export interface CodingWorkbenchRuntimeDelegationUsage {
  readonly toolCalls: number;
  readonly patchBytes: number;
  readonly promptTokens: number;
}

export interface CodingWorkbenchRuntimeAdapterStartRequest {
  readonly authorityRef: { readonly runId: string; readonly envelopeDigest: string };
  readonly delegationId: string;
  readonly idempotencyKey: string;
  readonly binding: CodingWorkbenchRuntimeExecutionBinding;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly modelSource: CodingWorkbenchModelSource;
}

export interface CodingWorkbenchRuntimeAdapterPort {
  readonly start: (request: CodingWorkbenchRuntimeAdapterStartRequest) => Promise<void>;
  readonly stop: (runId: string) => Promise<void>;
}

// deepFreeze: a shallow freeze left every per-state array writable, so
// `LEGAL_TRANSITIONS.succeeded.push("running")` succeeded against the transition guard that reads it.
const LEGAL_TRANSITIONS: Readonly<
  Record<CodingWorkbenchRuntimeStateName, readonly CodingWorkbenchRuntimeStateName[]>
> = deepFreeze({
  idle: ["starting", "recovery-required"],
  starting: ["ready", "stopping", "failed", "cancelled", "taken-over", "recovery-required"],
  ready: ["running", "stopping", "failed", "taken-over", "recovery-required"],
  running: [
    "paused",
    "awaiting-approval",
    "stopping",
    "succeeded",
    "failed",
    "taken-over",
    "recovery-required",
  ],
  paused: ["running", "awaiting-approval", "stopping", "failed", "taken-over", "recovery-required"],
  "awaiting-approval": ["running", "stopping", "failed", "taken-over", "recovery-required"],
  stopping: ["cancelled", "succeeded", "failed", "recovery-required"],
  succeeded: ["idle", "recovery-required"],
  failed: ["idle", "recovery-required"],
  cancelled: ["idle", "recovery-required"],
  "taken-over": ["idle", "recovery-required"],
  "recovery-required": ["idle"],
} as const);

function appendValidationIssues(errors: string[], ...issues: readonly string[]): boolean {
  errors.push(...issues);
  return issues.length === 0;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isLegalCodingWorkbenchRuntimeTransition(
  from: CodingWorkbenchRuntimeStateName,
  to: CodingWorkbenchRuntimeStateName,
): boolean {
  return (
    isOneOf(from, CODING_WORKBENCH_RUNTIME_STATE_NAMES) &&
    isOneOf(to, CODING_WORKBENCH_RUNTIME_STATE_NAMES) &&
    LEGAL_TRANSITIONS[from].includes(to)
  );
}

function validateObservedLifecycleCommand(
  command: unknown,
  priorValid: boolean,
  errors: string[],
): boolean {
  if (isOneOf(command, CODING_WORKBENCH_LIFECYCLE_COMMANDS)) return true;
  if (priorValid) appendValidationIssues(errors, "command is invalid");
  return false;
}

function observedIntegerIsValid(value: unknown, minimum: number): value is number {
  const safeInteger = Number.isSafeInteger(value);
  return typeof value === "number" && safeInteger && value >= minimum;
}

function validateRuntimeIntentKeys(value: Record<string, unknown>, errors: string[]): boolean {
  const common = ["schemaVersion", "requestId", "command"];
  const allowed =
    value.command === "start"
      ? [...common, "taskIntent", "requestedMode", "modelSource"]
      : [...common, "runId"];
  return appendValidationIssues(
    errors,
    ...Object.keys(value)
      .filter((key) => !allowed.includes(key))
      .map((key) => `runtimeIntent.${key} is not allowed`),
  );
}

function admitCodingWorkbenchRuntimeIntent(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeIntent {
  let valid = true;
  if (!isRecord(value)) {
    appendValidationIssues(errors, "runtime intent must be an object");
    return false;
  }
  valid = [validateRuntimeIntentKeys(value, errors), valid].every(Boolean);
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION)
    valid = [appendValidationIssues(errors, "schemaVersion is invalid"), valid].every(Boolean);
  if (!isNonEmpty(value.requestId))
    valid = [appendValidationIssues(errors, "requestId must be a non-empty string"), valid].every(
      Boolean,
    );
  const commandIsValid = isOneOf(value.command, CODING_WORKBENCH_LIFECYCLE_COMMANDS);
  if (!commandIsValid)
    valid = [appendValidationIssues(errors, "command is invalid"), valid].every(Boolean);
  let commandDiagnosticEmitted = !commandIsValid;
  const branchCommand = value.command;
  if (branchCommand === "start") valid = [validateStartIntent(value, errors), valid].every(Boolean);
  else {
    const observedCommand = value.command;
    const observedValid = isOneOf(observedCommand, CODING_WORKBENCH_LIFECYCLE_COMMANDS);
    if (observedValid && !isNonEmpty(value.runId))
      valid = appendValidationIssues(errors, "runId must be a non-empty string");
    const observedCommandIsValid = validateObservedLifecycleCommand(
      observedCommand,
      !commandDiagnosticEmitted,
      errors,
    );
    commandDiagnosticEmitted = [commandDiagnosticEmitted, !observedCommandIsValid].some(Boolean);
    valid = [observedCommandIsValid, valid].every(Boolean);
  }
  valid = [
    validateObservedLifecycleCommand(branchCommand, !commandDiagnosticEmitted, errors),
    valid,
  ].every(Boolean);
  return valid;
}

export function validateCodingWorkbenchRuntimeIntent(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeIntent> {
  const errors: string[] = [];
  return admitCodingWorkbenchRuntimeIntent(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

function admitCodingWorkbenchRuntimeAuthorityEnvelope(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeAuthorityEnvelope {
  let valid = true;
  if (!isRecord(value)) {
    appendValidationIssues(errors, "runtime authority must be an object");
    return false;
  }
  valid = [
    appendValidationIssues(
      errors,
      ...exactKeys(
        value,
        ["schemaVersion", "authority", "binding", "intentDigest", "nonceDigest", "issuedAt"],
        "runtimeAuthority",
      ),
    ),
    valid,
  ].every(Boolean);
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION)
    valid = [appendValidationIssues(errors, "schemaVersion is invalid"), valid].every(Boolean);
  const authority = validateCodingWorkbenchAuthorityEnvelope(value.authority);
  if (!authority.ok)
    valid = [
      appendValidationIssues(errors, ...authority.errors.map((error) => `authority.${error}`)),
      valid,
    ].every(Boolean);
  valid = [validateBinding(value.binding, errors), valid].every(Boolean);
  valid = [validateDigest(value.intentDigest, "intentDigest", errors), valid].every(Boolean);
  valid = [validateDigest(value.nonceDigest, "nonceDigest", errors), valid].every(Boolean);
  valid = [validateRuntimeUtcField(value.issuedAt, "issuedAt", errors), valid].every(Boolean);
  if (authority.ok && authority.value.workspace.rootDigest !== bindingRootDigest(value.binding)) {
    valid = [
      appendValidationIssues(
        errors,
        "binding workspace root digest must match authority workspace",
      ),
      valid,
    ].every(Boolean);
  }
  if (authority.ok && isRecord(value.binding)) {
    valid = [
      validateAuthorityBindingCorrelation(authority.value, value.binding, errors),
      valid,
    ].every(Boolean);
  }
  return valid;
}

export function validateCodingWorkbenchRuntimeAuthorityEnvelope(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeAuthorityEnvelope> {
  const errors: string[] = [];
  return admitCodingWorkbenchRuntimeAuthorityEnvelope(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

function admitCodingWorkbenchRuntimeState(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeState {
  let valid = true;
  if (!isRecord(value)) {
    appendValidationIssues(errors, "runtime state must be an object");
    return false;
  }
  valid = [
    appendValidationIssues(
      errors,
      ...exactKeys(
        value,
        [
          "schemaVersion",
          "state",
          "revision",
          "updatedAt",
          "runId",
          "taskId",
          "workspaceId",
          "runtimeSource",
          "modelSource",
          "failureCode",
        ],
        "runtimeState",
      ),
    ),
    valid,
  ].every(Boolean);
  if (value.schemaVersion !== CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION)
    valid = [appendValidationIssues(errors, "schemaVersion is invalid"), valid].every(Boolean);
  if (!isOneOf(value.state, CODING_WORKBENCH_RUNTIME_STATE_NAMES))
    valid = [appendValidationIssues(errors, "state is invalid"), valid].every(Boolean);
  const revisionIsSafeInteger = Number.isSafeInteger(value.revision);
  const revision = revisionIsSafeInteger ? value.revision : undefined;
  if (!revisionIsSafeInteger || !observedIntegerIsValid(revision, 0))
    valid = [appendValidationIssues(errors, "revision must be non-negative"), valid].every(Boolean);
  valid = [validateRuntimeUtcField(value.updatedAt, "updatedAt", errors), valid].every(Boolean);
  valid = [validateOptionalStateFields(value, errors), valid].every(Boolean);
  valid = [validateStateShape(value, errors), valid].every(Boolean);
  return valid;
}

export function validateCodingWorkbenchRuntimeState(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeState> {
  const errors: string[] = [];
  return admitCodingWorkbenchRuntimeState(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

function admitCodingWorkbenchRuntimeMintConfirmation(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeMintConfirmation {
  let valid = true;
  if (!isRecord(value)) {
    appendValidationIssues(errors, "mint confirmation must be an object");
    return false;
  }
  valid = [
    appendValidationIssues(
      errors,
      ...exactKeys(
        value,
        ["approvalId", "approvalToken", "taskId", "operatorId", "intentDigest", "expiresAt"],
        "mintConfirmation",
      ),
    ),
    valid,
  ].every(Boolean);
  for (const key of ["approvalId", "approvalToken", "taskId", "operatorId"] as const)
    if (!isNonEmpty(value[key]))
      valid = [appendValidationIssues(errors, `${key} is required`), valid].every(Boolean);
  valid = [validateDigest(value.intentDigest, "intentDigest", errors), valid].every(Boolean);
  valid = [validateRuntimeUtcField(value.expiresAt, "expiresAt", errors), valid].every(Boolean);
  return valid;
}

export function validateCodingWorkbenchRuntimeMintConfirmation(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeMintConfirmation> {
  const errors: string[] = [];
  return admitCodingWorkbenchRuntimeMintConfirmation(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

const AUTHORITY_FACT_KEYS = [
  "binding",
  "actionClasses",
  "connectorScopes",
  "runtimeSource",
  "modelSource",
  "budgetDigest",
  "commandPolicyDigest",
  "networkPolicyDigest",
  "gatesDigest",
  "branchConstraintsDigest",
  "modelProfileDigest",
  "issueBindingDigest",
];

function admitCodingWorkbenchRuntimeAuthorityFacts(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeAuthorityFacts {
  let valid = true;
  if (!isRecord(value)) {
    appendValidationIssues(errors, "authority facts must be an object");
    return false;
  }
  valid = [
    appendValidationIssues(errors, ...exactKeys(value, AUTHORITY_FACT_KEYS, "authorityFacts")),
    valid,
  ].every(Boolean);
  valid = [validateBinding(value.binding, errors), valid].every(Boolean);
  for (const key of AUTHORITY_FACT_KEYS.filter(
    (key) => key.endsWith("Digest") && key !== "issueBindingDigest",
  ))
    valid = [validateDigest(value[key], key, errors), valid].every(Boolean);
  if (value.issueBindingDigest !== undefined)
    valid = [validateDigest(value.issueBindingDigest, "issueBindingDigest", errors), valid].every(
      Boolean,
    );
  if (!Array.isArray(value.actionClasses) || !Array.isArray(value.connectorScopes))
    valid = [appendValidationIssues(errors, "authority scopes must be arrays"), valid].every(
      Boolean,
    );
  else {
    if (!runtimeScopeMembersValid(value.actionClasses, CODING_WORKBENCH_ACTION_CLASSES))
      valid = [
        appendValidationIssues(errors, "actionClasses contains an invalid member"),
        valid,
      ].every(Boolean);
    if (!runtimeScopeMembersValid(value.connectorScopes, CODING_WORKBENCH_CONNECTOR_SCOPES))
      valid = [
        appendValidationIssues(errors, "connectorScopes contains an invalid member"),
        valid,
      ].every(Boolean);
  }
  if (!isOneOf(value.runtimeSource, CODING_WORKBENCH_RUNTIME_SOURCES))
    valid = [appendValidationIssues(errors, "runtimeSource is invalid"), valid].every(Boolean);
  if (!isOneOf(value.modelSource, CODING_WORKBENCH_MODEL_SOURCES))
    valid = [appendValidationIssues(errors, "modelSource is invalid"), valid].every(Boolean);
  return valid;
}

export function validateCodingWorkbenchRuntimeAuthorityFacts(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeAuthorityFacts> {
  const errors: string[] = [];
  return admitCodingWorkbenchRuntimeAuthorityFacts(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

const ADAPTER_REQUEST_KEYS = [
  "authorityRef",
  "delegationId",
  "idempotencyKey",
  "binding",
  "runtimeSource",
  "modelSource",
];

function admitCodingWorkbenchRuntimeAdapterStartRequest(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchRuntimeAdapterStartRequest {
  let valid = true;
  if (!isRecord(value)) {
    appendValidationIssues(errors, "adapter request must be an object");
    return false;
  }
  valid = [
    appendValidationIssues(errors, ...exactKeys(value, ADAPTER_REQUEST_KEYS, "adapterRequest")),
    valid,
  ].every(Boolean);
  valid = [validateBinding(value.binding, errors), valid].every(Boolean);
  if (!isRecord(value.authorityRef))
    valid = [appendValidationIssues(errors, "authorityRef is required"), valid].every(Boolean);
  else {
    valid = [
      appendValidationIssues(
        errors,
        ...exactKeys(value.authorityRef, ["runId", "envelopeDigest"], "authorityRef"),
      ),
      valid,
    ].every(Boolean);
    if (!isNonEmpty(value.authorityRef.runId))
      valid = [appendValidationIssues(errors, "authorityRef.runId is required"), valid].every(
        Boolean,
      );
    valid = [
      validateDigest(value.authorityRef.envelopeDigest, "authorityRef.envelopeDigest", errors),
      valid,
    ].every(Boolean);
  }
  for (const key of ["delegationId", "idempotencyKey"] as const)
    if (!isNonEmpty(value[key]))
      valid = [appendValidationIssues(errors, `${key} is required`), valid].every(Boolean);
  if (!isOneOf(value.runtimeSource, CODING_WORKBENCH_RUNTIME_SOURCES))
    valid = [appendValidationIssues(errors, "runtimeSource is invalid"), valid].every(Boolean);
  if (!isOneOf(value.modelSource, CODING_WORKBENCH_MODEL_SOURCES))
    valid = [appendValidationIssues(errors, "modelSource is invalid"), valid].every(Boolean);
  return valid;
}

export function validateCodingWorkbenchRuntimeAdapterStartRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchRuntimeAdapterStartRequest> {
  const errors: string[] = [];
  return admitCodingWorkbenchRuntimeAdapterStartRequest(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

const ISSUE_PREVIEW_REQUEST_KEYS = ["repositoryPath", "issueRef"] as const;

function isBoundedNulFreeString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    !value.includes("\0")
  );
}

/**
 * Parse the preview request body. Exact keys, both required, both bounded, neither judged beyond
 * transport shape: whether the path is a registered project and whether the reference is an issue
 * are the server's decisions, made after this returns. Anything else is `undefined`.
 */
export function parseCodingWorkbenchIssuePreviewRequest(
  value: unknown,
): CodingWorkbenchIssuePreviewRequestWire | undefined {
  if (!isRecord(value)) return undefined;
  if (exactKeys(value, [...ISSUE_PREVIEW_REQUEST_KEYS], "issuePreview").length > 0) {
    return undefined;
  }
  const { repositoryPath, issueRef } = value;
  if (!isBoundedNulFreeString(repositoryPath, MAX_GITHUB_ISSUE_READER_REPOSITORY_PATH_CHARS)) {
    return undefined;
  }
  if (!isBoundedNulFreeString(issueRef, CODING_WORKBENCH_ISSUE_REF_MAX_CHARS)) return undefined;
  return { repositoryPath, issueRef };
}

function validateIssuePreviewText(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (
    typeof value.title !== "string" ||
    !previewTextIsWithinBound(value.title, CODING_WORKBENCH_ISSUE_PREVIEW_TITLE_MAX_CHARS)
  ) {
    valid = [
      appendValidationIssues(errors, "issuePreview.title must be a bounded string"),
      valid,
    ].every(Boolean);
  }
  if (
    typeof value.bodyExcerpt !== "string" ||
    !previewTextIsWithinBound(value.bodyExcerpt, CODING_WORKBENCH_ISSUE_PREVIEW_EXCERPT_MAX_CHARS)
  ) {
    valid = [
      appendValidationIssues(errors, "issuePreview.bodyExcerpt must be a bounded string"),
      valid,
    ].every(Boolean);
  }
  if (typeof value.bodyExcerptTruncated !== "boolean") {
    valid = [
      appendValidationIssues(errors, "issuePreview.bodyExcerptTruncated must be a boolean"),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateIssuePreviewComments(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (
    value.comments !== undefined &&
    (!Array.isArray(value.comments) ||
      value.comments.length > 8 ||
      !previewCommentMembersValid(value.comments))
  ) {
    valid = [
      appendValidationIssues(
        errors,
        "issuePreview.comments must contain at most eight bounded excerpts",
      ),
      valid,
    ].every(Boolean);
  }
  if (value.commentsTruncated !== undefined && typeof value.commentsTruncated !== "boolean") {
    valid = [
      appendValidationIssues(errors, "issuePreview.commentsTruncated must be a boolean"),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateIssuePreviewProvenance(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = [
      appendValidationIssues(errors, "issuePreview.provenance must be an object"),
      valid,
    ].every(Boolean);
    return valid;
  }
  valid = [
    appendValidationIssues(
      errors,
      ...exactKeys(value, ["ownerAndRepo", "issueNumber", "url"], "provenance"),
    ),
    valid,
  ].every(Boolean);
  if (!isNonEmpty(value.ownerAndRepo))
    valid = [appendValidationIssues(errors, "provenance.ownerAndRepo is required"), valid].every(
      Boolean,
    );
  const issueNumberIsSafeInteger = Number.isSafeInteger(value.issueNumber);
  const issueNumber = issueNumberIsSafeInteger ? value.issueNumber : undefined;
  if (!issueNumberIsSafeInteger || !observedIntegerIsValid(issueNumber, 1)) {
    valid = [
      appendValidationIssues(errors, "provenance.issueNumber must be a positive integer"),
      valid,
    ].every(Boolean);
  }
  if (!isNonEmpty(value.url))
    valid = [appendValidationIssues(errors, "provenance.url is required"), valid].every(Boolean);

  return valid;
}

function admitCodingWorkbenchIssuePreview(
  value: unknown,
  errors: string[],
): value is CodingWorkbenchIssuePreview {
  let valid = true;
  if (!isRecord(value)) {
    appendValidationIssues(errors, "issue preview must be an object");
    return false;
  }
  valid = [
    appendValidationIssues(
      errors,
      ...exactKeys(
        value,
        [
          "untrusted",
          "title",
          "bodyExcerpt",
          "bodyExcerptTruncated",
          "commentCount",
          "comments",
          "commentsTruncated",
          "state",
          "provenance",
        ],
        "issuePreview",
      ),
    ),
    valid,
  ].every(Boolean);
  if (value.untrusted !== true)
    valid = [appendValidationIssues(errors, "issuePreview.untrusted must be true"), valid].every(
      Boolean,
    );
  valid = [validateIssuePreviewText(value, errors), valid].every(Boolean);
  valid = [validateIssuePreviewComments(value, errors), valid].every(Boolean);
  const commentCountIsSafeInteger = Number.isSafeInteger(value.commentCount);
  const commentCount = commentCountIsSafeInteger ? value.commentCount : undefined;
  if (!commentCountIsSafeInteger || !observedIntegerIsValid(commentCount, 0)) {
    valid = [
      appendValidationIssues(errors, "issuePreview.commentCount must be a non-negative integer"),
      valid,
    ].every(Boolean);
  }
  if (!isOneOf(value.state, CODING_WORKBENCH_ISSUE_STATES))
    valid = [appendValidationIssues(errors, "issuePreview.state is invalid"), valid].every(Boolean);
  valid = [validateIssuePreviewProvenance(value.provenance, errors), valid].every(Boolean);
  return valid;
}

/**
 * The preview's shape, held to exact keys so a later change cannot quietly widen what crosses the
 * browser boundary — the same reason the snapshot's issue projection is validated that way.
 */
export function validateCodingWorkbenchIssuePreview(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchIssuePreview> {
  const errors: string[] = [];
  return admitCodingWorkbenchIssuePreview(value, errors)
    ? { ok: true, value }
    : { ok: false, errors };
}

function validateAuthorityBindingCorrelation(
  authority: CodingWorkbenchAuthorityEnvelope,
  binding: Record<string, unknown>,
  errors: string[],
): boolean {
  let valid = true;
  if (!authority.taskRefs.includes(String(binding.taskId))) {
    valid = [
      appendValidationIssues(
        errors,
        "binding task id must be present in authority task references",
      ),
      valid,
    ].every(Boolean);
  }
  if (authority.workspace.workspaceId !== binding.workspaceId) {
    valid = [
      appendValidationIssues(errors, "binding workspace id must match authority workspace"),
      valid,
    ].every(Boolean);
  }
  if (authority.branch.headRef !== binding.branchRef) {
    valid = [
      appendValidationIssues(
        errors,
        "binding branch reference must match authority head reference",
      ),
      valid,
    ].every(Boolean);
  }
  if (
    !authority.branch.allowedPrefixes.some((prefix) => String(binding.branchRef).startsWith(prefix))
  ) {
    valid = [
      appendValidationIssues(
        errors,
        "binding branch reference must satisfy authority branch constraints",
      ),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateBinding(value: unknown, errors: string[]): boolean {
  let valid = true;
  if (!isRecord(value)) {
    valid = [appendValidationIssues(errors, "binding must be an object"), valid].every(Boolean);
    return valid;
  }
  valid = [
    appendValidationIssues(
      errors,
      ...exactKeys(
        value,
        [
          "taskId",
          "projectId",
          "projectDigest",
          "workspaceId",
          "workspaceRootDigest",
          "branchRef",
          "branchHeadDigest",
        ],
        "binding",
      ),
    ),
    valid,
  ].every(Boolean);
  for (const key of ["taskId", "projectId", "workspaceId", "branchRef"] as const) {
    if (!isNonEmpty(value[key]))
      valid = [
        appendValidationIssues(errors, `binding.${key} must be a non-empty string`),
        valid,
      ].every(Boolean);
  }
  for (const key of ["projectDigest", "workspaceRootDigest", "branchHeadDigest"] as const) {
    valid = [validateDigest(value[key], `binding.${key}`, errors), valid].every(Boolean);
  }

  return valid;
}

function bindingRootDigest(value: unknown): unknown {
  return isRecord(value) ? value.workspaceRootDigest : undefined;
}

function validateDigest(value: unknown, path: string, errors: string[]): boolean {
  let valid = true;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    valid = [
      appendValidationIssues(errors, `${path} must be a 64-character lowercase hex digest`),
      valid,
    ].every(Boolean);
  }

  return valid;
}

function validateOptionalStateFields(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  for (const key of ["runId", "taskId", "workspaceId"] as const) {
    if (value[key] !== undefined && !isNonEmpty(value[key]))
      valid = [appendValidationIssues(errors, `${key} must be a non-empty string`), valid].every(
        Boolean,
      );
  }
  if (
    value.runtimeSource !== undefined &&
    !isOneOf(value.runtimeSource, CODING_WORKBENCH_RUNTIME_SOURCES)
  )
    valid = [appendValidationIssues(errors, "runtimeSource is invalid"), valid].every(Boolean);
  if (
    value.modelSource !== undefined &&
    !isOneOf(value.modelSource, CODING_WORKBENCH_MODEL_SOURCES)
  )
    valid = [appendValidationIssues(errors, "modelSource is invalid"), valid].every(Boolean);
  if (
    value.failureCode !== undefined &&
    !isOneOf(value.failureCode, CODING_WORKBENCH_RUNTIME_FAILURE_CODES)
  )
    valid = [appendValidationIssues(errors, "failureCode is invalid"), valid].every(Boolean);

  return valid;
}

function validateStateShape(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (!isOneOf(value.state, CODING_WORKBENCH_RUNTIME_STATE_NAMES)) return valid;
  const unbound = value.state === "idle";
  const bindings = [
    value.runId,
    value.taskId,
    value.workspaceId,
    value.runtimeSource,
    value.modelSource,
  ];
  if (unbound && bindings.some((entry) => entry !== undefined))
    valid = [
      appendValidationIssues(errors, "unbound state must not carry run binding"),
      valid,
    ].every(Boolean);
  const recoveryHasBinding =
    value.state === "recovery-required" && bindings.some((entry) => entry !== undefined);
  const requiresBinding = !unbound && value.state !== "recovery-required";
  if ((requiresBinding || recoveryHasBinding) && bindings.some((entry) => !isNonEmpty(entry)))
    valid = [
      appendValidationIssues(errors, "run-bound state requires complete binding"),
      valid,
    ].every(Boolean);
  valid = [validateStateFailureShape(value, errors), valid].every(Boolean);

  return valid;
}

function validateStateFailureShape(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  const requiresFailure = value.state === "failed" || value.state === "recovery-required";
  if (requiresFailure && value.failureCode === undefined)
    valid = [appendValidationIssues(errors, "failure state requires failureCode"), valid].every(
      Boolean,
    );
  const permitsFailure = ["failed", "cancelled", "taken-over", "recovery-required"].includes(
    String(value.state),
  );
  if (!permitsFailure && value.failureCode !== undefined)
    valid = [appendValidationIssues(errors, "state must not carry failureCode"), valid].every(
      Boolean,
    );

  return valid;
}

function validateStartIntent(value: Record<string, unknown>, errors: string[]): boolean {
  let valid = true;
  if (
    !isNonEmpty(value.taskIntent) ||
    value.taskIntent.length > CODING_WORKBENCH_TASK_INTENT_MAX_CHARS
  ) {
    valid = [
      appendValidationIssues(errors, "taskIntent must be a bounded non-empty string"),
      valid,
    ].every(Boolean);
  }
  // Validated against the package's own frozen tables, not local copies. The re-declared arrays here
  // were a second source of truth for two closed vocabularies the rest of this same file already
  // validates against CODING_WORKBENCH_MODEL_SOURCES — so adding a mode would have silently left
  // this one validator rejecting it.
  if (!isOneOf(value.requestedMode, CODING_WORKBENCH_MODES)) {
    valid = [appendValidationIssues(errors, "requestedMode is invalid"), valid].every(Boolean);
  }
  if (!isOneOf(value.modelSource, CODING_WORKBENCH_MODEL_SOURCES)) {
    valid = [appendValidationIssues(errors, "modelSource is invalid"), valid].every(Boolean);
  }

  return valid;
}

// The shared owner still implements strict UTC semantics; this phase adds only the primitive witness.
function validateRuntimeUtcField(value: unknown, path: string, errors: string[]): value is string {
  const previousErrors = errors.length;
  validateStrictUtcInstant(value, path, errors);
  return typeof value === "string" && errors.length === previousErrors;
}

// Concrete physical scope observations, not a generic unknown-to-domain certificate.
function runtimeScopeMembersValid(value: unknown, allowed: readonly string[]): boolean {
  if (!Array.isArray(value)) return false;
  const extent = value.length;
  for (let index = 0; index < extent; index += 1) {
    if (!isOneOf(value[index], allowed)) return false;
  }
  return true;
}

function previewCommentMembersValid(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const extent = value.length;
  for (let index = 0; index < extent; index += 1) {
    const comment: unknown = value[index];
    if (typeof comment !== "string" || comment.length > 1_024) return false;
  }
  return true;
}

function previewTextIsWithinBound(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}
