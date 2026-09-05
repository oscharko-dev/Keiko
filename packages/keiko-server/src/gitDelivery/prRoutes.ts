// Governed GitHub pull request routes (Issue #477, Epic #470, ADR-0086).
//
//   * POST /api/git-delivery/pr/preview  — READ-ONLY. Builds the pre-create context: the synthesized,
//       user-editable metadata draft (title/body/risk narrative), the readiness summary (objectExists vs
//       reviewReady) with structured blockers, the draft-vs-ready recommendation, the reviewer/label/
//       linkage suggestions, and the effective policy decision. Never mutates, never records evidence.
//   * POST /api/git-delivery/pr/approve  — Mints the server-issued approval claim an issue-bound draft
//       PR requires before execute may proceed (#3387, ADR-0138 D2/D4, epic #3384 correction 5: a
//       delivery effect is approval-required in every mode, including Full access — never mode-denied
//       merely because the mode is lower). Mirrors createHandleCommitApprove/createHandleMergeApprove
//       exactly: rebuilds the EXACT typed GitPullRequestCommand the execute route would build from the
//       identical request body (the shared `validate()` below) and binds the mint to it plus the
//       admitted run's runId/envelopeDigest, so the claim this returns is redeemable by execute for
//       that exact create/update proposal only — a claim minted for a different command, run, or
//       operation never matches.
//   * POST /api/git-delivery/pr/execute  — Governed. Drives the #477 PR gateway end-to-end through
//       executeGovernedPullRequest (preflight + policy + approval + the dedicated `gh api` adapter) and
//       appends content-free evidence for the allowed AND blocked outcome alike. Returns the typed
//       provider-rejection reason + reused recovery hint so a rejected operation recovers without
//       guessing, and the provider-assigned PR number on a successful create. An accepted run's PR
//       create/update now requires an actually consumed, server-issued claim — a request that supplies
//       no claim (or an unredeemed `{ required: false }`) is refused with `approval-required`,
//       mirroring the commit route's unapproved-mutation closure (#3386).
//
// Content-free in evidence: title/body strings flow to the provider but only their byte lengths enter
// the ledger. CSRF + JSON content type are enforced centrally by server.ts.

import type {
  GitDeliveryApprovalClaim,
  GitDeliveryApprovalRequirement,
} from "@oscharko-dev/keiko-contracts";
import type { GitPullRequestCommand } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  DEFAULT_GIT_DELIVERY_APPROVAL_STORE,
  GIT_DELIVERY_LOCAL_OPERATOR_ID,
  parseGitDeliveryApprovalRequest,
  resolveGitDeliveryApprovalRequirement,
  type GitDeliveryApprovalBinding,
  type ParsedGitDeliveryApprovalRequest,
} from "./approvalStore.js";
import { readWorktreeSnapshotFor } from "./execution.js";
import { defaultMintableRepoPack } from "./policyPackMintability.js";
import {
  buildGitDeliveryPrPreview,
  executeGovernedPullRequest,
  gitDeliveryPrExecuteResponse,
  KEIKO_DEFAULT_PR_POLICY_PACK,
  type GitDeliveryPullRequestSeams,
} from "./prExecution.js";
import {
  createGitDeliveryPrMarkReadyRouteGroup,
  type GitDeliveryPrMarkReadyRouteOptions,
} from "./prMarkReadyExecution.js";
import {
  hasOnlyAllowedKeys,
  isNonEmptyString,
  isOwnerAndRepo,
  isPlainObject,
  isPrNumberString,
  isSafeGitRef,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
} from "./requestGuards.js";
import {
  gitDeliveryAuthorityContinuityGuard,
  gitDeliveryAuthorityGate,
  prepareGitDeliveryRequest,
  type GitDeliveryAuthorityContinuityDenialCapture,
  type GitDeliveryAuthorityIdentity,
  type GitDeliveryRequestErrors,
} from "./requestPreparation.js";

// ─── Error envelope ───────────────────────────────────────────────────────────────────────────

export type GitDeliveryPrErrorCode =
  | "GIT_DELIVERY_PR_BAD_REQUEST"
  | "GIT_DELIVERY_PR_PAYLOAD_TOO_LARGE"
  | "GIT_DELIVERY_PR_FORBIDDEN_PAYLOAD"
  | "GIT_DELIVERY_PR_UNKNOWN_PROJECT"
  | "GIT_DELIVERY_PR_WORKTREE_UNAVAILABLE";

const SAFE_MESSAGES: Readonly<Record<GitDeliveryPrErrorCode, string>> = {
  GIT_DELIVERY_PR_BAD_REQUEST: "The request body is not a valid governed pull request.",
  GIT_DELIVERY_PR_PAYLOAD_TOO_LARGE: "The governed pull request request exceeds the maximum size.",
  GIT_DELIVERY_PR_FORBIDDEN_PAYLOAD:
    "The request contained a forbidden field. Requests may not carry credentials or auth headers.",
  GIT_DELIVERY_PR_UNKNOWN_PROJECT: "The requested project is not a known workspace.",
  GIT_DELIVERY_PR_WORKTREE_UNAVAILABLE:
    "The repository worktree could not be inspected. Confirm the project is a Git repository.",
};

const errResult = (status: number, code: GitDeliveryPrErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

const PR_REQUEST_ERRORS: GitDeliveryRequestErrors = {
  tooLarge: errResult(413, "GIT_DELIVERY_PR_PAYLOAD_TOO_LARGE"),
  badRequest: errResult(400, "GIT_DELIVERY_PR_BAD_REQUEST"),
  unknownProject: errResult(404, "GIT_DELIVERY_PR_UNKNOWN_PROJECT"),
};

// ─── Options ────────────────────────────────────────────────────────────────────────────────

export interface GitDeliveryPrRouteOptions {
  readonly execution?: GitDeliveryPullRequestSeams;
  // #3389: the mark-ready mint/execute routes are mounted alongside create/update/preview on this
  // same route group (routes.ts imports the GIT_DELIVERY_PR_ROUTE_GROUP const, never a second group)
  // — this seam lets tests inject a fake mark-ready adapter/approval-store independently of the
  // generic PR execution seams above.
  readonly markReady?: GitDeliveryPrMarkReadyRouteOptions;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "projectId",
  "kind",
  "ownerAndRepo",
  "headBranchName",
  "baseBranchName",
  "title",
  "body",
  "isDraft",
  "prExternalId",
  "convertToDraft",
  "convertFromDraft",
  "approval",
]);

interface ValidatedRequest {
  readonly projectId: string;
  readonly command: GitPullRequestCommand;
  readonly approval: ParsedGitDeliveryApprovalRequest;
}

type Validation =
  | { readonly kind: "ok"; readonly value: ValidatedRequest }
  | { readonly kind: "err"; readonly result: RouteResult };

function optionalBool(value: unknown): boolean | undefined {
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : undefined;
}

function isBodyString(value: unknown): value is string {
  // A PR body may be empty; it must still be a string.
  return typeof value === "string";
}

function scanError(parsed: Record<string, unknown>): RouteResult | undefined {
  if (scanForbiddenStrings(parsed)) {
    return errResult(400, "GIT_DELIVERY_PR_FORBIDDEN_PAYLOAD");
  }
  if (scanUnsafeFormatChars(parsed)) {
    return errResult(400, "GIT_DELIVERY_PR_BAD_REQUEST");
  }
  return undefined;
}

function buildCreateCommand(parsed: Record<string, unknown>): GitPullRequestCommand | undefined {
  if (
    !isOwnerAndRepo(parsed.ownerAndRepo) ||
    !isSafeGitRef(parsed.headBranchName) ||
    !isSafeGitRef(parsed.baseBranchName) ||
    !isNonEmptyString(parsed.title) ||
    !isBodyString(parsed.body)
  ) {
    return undefined;
  }
  const isDraft = optionalBool(parsed.isDraft);
  if (isDraft === undefined) return undefined;
  return {
    kind: "pr-create",
    ownerAndRepo: parsed.ownerAndRepo,
    headBranchName: parsed.headBranchName,
    baseBranchName: parsed.baseBranchName,
    title: parsed.title,
    body: parsed.body,
    isDraft,
  };
}

// Narrowing guard: when true, the shared string operands are all valid strings on `parsed`.
interface ValidUpdateFields {
  readonly ownerAndRepo: string;
  readonly prExternalId: string;
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly title: string;
  readonly body: string;
}

function hasValidUpdateFields(
  parsed: Record<string, unknown>,
): parsed is Record<string, unknown> & ValidUpdateFields {
  return (
    isOwnerAndRepo(parsed.ownerAndRepo) &&
    isPrNumberString(parsed.prExternalId) &&
    isSafeGitRef(parsed.headBranchName) &&
    isSafeGitRef(parsed.baseBranchName) &&
    isNonEmptyString(parsed.title) &&
    isBodyString(parsed.body)
  );
}

// Exactly one of convert-to-draft / convert-from-draft may be set; both default to false.
//
// #3389 (epic #3384 correction 1): `convertFromDraft` (draft->ready) is REJECTED here unconditionally
// — it is never a valid field on the generic `pr-update` command. Before this change the transition
// executed under the run-bound authority gate alone, with no one-use approval bound to the exact
// PR/head/base facts (the approval-less path AC3 requires closed). The transition is reachable ONLY
// through the dedicated `pr-mark-ready` intent (prMarkReadyExecution.ts), whose approval binds
// exactly those facts and re-verifies them immediately before and after the mutation. `convertToDraft`
// (ready->draft) is unaffected: it is not the transition this correction closes.
function parseConvertFlags(
  parsed: Record<string, unknown>,
): { convertToDraft: boolean; convertFromDraft: boolean } | undefined {
  const convertToDraft = optionalBool(parsed.convertToDraft);
  const convertFromDraft = optionalBool(parsed.convertFromDraft);
  if (convertToDraft === undefined || convertFromDraft === undefined) return undefined;
  if (convertFromDraft) return undefined;
  return { convertToDraft, convertFromDraft: false };
}

function buildUpdateCommand(parsed: Record<string, unknown>): GitPullRequestCommand | undefined {
  if (!hasValidUpdateFields(parsed)) return undefined;
  const converts = parseConvertFlags(parsed);
  if (converts === undefined) return undefined;
  return {
    kind: "pr-update",
    ownerAndRepo: parsed.ownerAndRepo,
    prExternalId: parsed.prExternalId,
    headBranchName: parsed.headBranchName,
    baseBranchName: parsed.baseBranchName,
    title: parsed.title,
    body: parsed.body,
    convertToDraft: converts.convertToDraft,
    convertFromDraft: converts.convertFromDraft,
  };
}

function buildPrCommand(parsed: Record<string, unknown>): GitPullRequestCommand | undefined {
  if (parsed.kind === "pr-create") return buildCreateCommand(parsed);
  if (parsed.kind === "pr-update") return buildUpdateCommand(parsed);
  return undefined;
}

function validate(parsed: unknown): Validation {
  const bad: Validation = { kind: "err", result: errResult(400, "GIT_DELIVERY_PR_BAD_REQUEST") };
  if (!isPlainObject(parsed) || !hasOnlyAllowedKeys(parsed, ALLOWED_KEYS)) return bad;
  if (parsed.schemaVersion !== "1" || !isNonEmptyString(parsed.projectId)) return bad;
  const scanErr = scanError(parsed);
  if (scanErr !== undefined) return { kind: "err", result: scanErr };
  const command = buildPrCommand(parsed);
  const approval = parseGitDeliveryApprovalRequest(parsed.approval);
  if (command === undefined || approval === undefined) return bad;
  return { kind: "ok", value: { projectId: parsed.projectId, command, approval } };
}

// ─── Preview handler (read-only) ────────────────────────────────────────────────────────────────

export const createHandlePrPreview = (
  options: GitDeliveryPrRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  const now = (): number => (seams.now ?? Date.now)();
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const prepared = await prepareGitDeliveryRequest(ctx, deps, PR_REQUEST_ERRORS, validate);
    if (!prepared.ok) return prepared.result;
    const { workspace } = prepared;
    const { command } = prepared.value;
    const packs = seams.policyPacks ?? defaultMintableRepoPack(KEIKO_DEFAULT_PR_POLICY_PACK);
    try {
      const snapshot = await readWorktreeSnapshotFor(workspace, seams, now, correlationId);
      return {
        status: 200,
        body: deps.redactor(buildGitDeliveryPrPreview(command, snapshot, packs)),
      };
    } catch {
      return errResult(409, "GIT_DELIVERY_PR_WORKTREE_UNAVAILABLE");
    }
  };
};

// ─── Execute handler (governed) ───────────────────────────────────────────────────────────────

function prAuthorityTarget(command: GitPullRequestCommand): {
  readonly headBranchName: string;
  readonly baseBranchName: string;
} {
  return { headBranchName: command.headBranchName, baseBranchName: command.baseBranchName };
}

function prApprovalBinding(
  projectId: string,
  command: GitPullRequestCommand,
  authority: GitDeliveryAuthorityIdentity,
): GitDeliveryApprovalBinding {
  return {
    projectId,
    operation: "pr",
    command,
    runId: authority.runId,
    envelopeDigest: authority.envelopeDigest,
  };
}

type PrAuthorityTarget = ReturnType<typeof prAuthorityTarget>;

// #3387 (ADR-0138 D2): mirrors commitApprovalRequiredBlock (commitRoutes.ts) exactly — an accepted
// run's PR create/update requires an actually consumed, server-issued claim regardless of what the
// repo/org policy pack decides; a pack that never names "approval-gated" for pr-create/pr-update
// must not silently substitute for the human approval this closes. Reuses the kernel's own shared
// outcome vocabulary (GitPullRequestOutcome["status"] already carries "approval-required" for the
// pack-driven approval-gated path — see gitDeliveryPrExecuteResponse in prExecution.ts) rather than
// inventing a second, parallel status for the identical governance outcome.
function prApprovalRequiredBlock(
  deps: Pick<UiHandlerDeps, "redactor">,
  command: GitPullRequestCommand,
): RouteResult {
  return {
    status: 200,
    body: deps.redactor({
      schemaVersion: "1",
      status: "approval-required",
      actionKind: command.kind,
    }),
  };
}

function logPrApprovalRequired(
  activityLog: ServerLogSink,
  correlationId: string,
  runId: string,
): void {
  activityLog.write({
    category: "security",
    op: "git.delivery.pr.approval.required",
    correlationId,
    status: 200,
    extra: { operation: "pr", runId },
  });
}

interface GovernedPrDispatch {
  readonly ctx: RouteContext;
  readonly deps: UiHandlerDeps;
  readonly seams: GitDeliveryPullRequestSeams;
  readonly command: GitPullRequestCommand;
  readonly verifiedApproval: GitDeliveryApprovalRequirement;
  readonly workspace: WorkspaceInfo;
  readonly projectId: string;
  readonly target: PrAuthorityTarget;
  readonly authority: GitDeliveryAuthorityIdentity;
  readonly correlationId: string;
}

// Runs the continuity-guarded dispatch: builds the guard (capturing a mid-flight denial's 403), calls
// the PR gateway, and — when the guard denied — returns that SAME 403 instead of projecting the
// gateway's synthetic no-spawn result as a misleading 200 internal failure. Split out of the handler
// purely to keep the handler under the repo's max-lines-per-function bar.
async function dispatchGovernedPr(input: GovernedPrDispatch): Promise<RouteResult> {
  const {
    ctx,
    deps,
    seams,
    command,
    verifiedApproval,
    workspace,
    projectId,
    target,
    authority,
    correlationId,
  } = input;
  const denialCapture: GitDeliveryAuthorityContinuityDenialCapture = {};
  const beforeRemoteDispatch = gitDeliveryAuthorityContinuityGuard({
    ctx,
    deps,
    projectId,
    workspace,
    operation: "pull-request",
    target,
    admitted: authority,
    next: seams.beforeRemoteDispatch,
    denialCapture,
    audit: { logSink: seams.activityLog, deliveryApprovalDeferred: true },
  });
  try {
    const result = await executeGovernedPullRequest(
      command,
      verifiedApproval,
      workspace,
      deps,
      { ...seams, beforeRemoteDispatch, authorityDenialCapture: denialCapture },
      correlationId,
    );
    // The continuity guard denied mid-flight (revoked/replaced authority): nothing was dispatched, and
    // `result` is the gateway's synthetic no-spawn stand-in. Return the SAME 403 the up-front admission
    // gate would have returned, not a 200 that projects the stand-in as a retryable internal failure.
    if (denialCapture.result !== undefined) return denialCapture.result;
    return { status: 200, body: deps.redactor(gitDeliveryPrExecuteResponse(result)) };
  } catch {
    return errResult(409, "GIT_DELIVERY_PR_WORKTREE_UNAVAILABLE");
  }
}

async function handlePrExecute(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  seams: GitDeliveryPullRequestSeams,
): Promise<RouteResult> {
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  const prepared = await prepareGitDeliveryRequest(ctx, deps, PR_REQUEST_ERRORS, validate);
  if (!prepared.ok) return prepared.result;
  const { workspace } = prepared;
  const { projectId, command, approval } = prepared.value;
  const target = prAuthorityTarget(command);
  const authority = gitDeliveryAuthorityGate(
    ctx,
    deps,
    projectId,
    workspace,
    "pull-request",
    target,
    {
      logSink: seams.activityLog,
      // Final-audit F2/#3390 (ADR-0138 D2, #3387): PR create/update's own execute path already
      // enforces a mandatory, mode-independent consumed approval below, so this coarse admission
      // layer defers to it instead of demanding a second claim.
      deliveryApprovalDeferred: true,
    },
  );
  if (!authority.allowed) return authority.result;
  const verifiedApproval = resolveGitDeliveryApprovalRequirement(approval, {
    store: seams.approvalStore,
    binding: prApprovalBinding(projectId, command, authority),
    nowMs: (seams.now ?? Date.now)(),
  });
  if (verifiedApproval === undefined) return errResult(400, "GIT_DELIVERY_PR_BAD_REQUEST");
  if (!verifiedApproval.required) {
    logPrApprovalRequired(
      seams.activityLog ?? processServerLogSink(),
      correlationId,
      authority.runId,
    );
    return prApprovalRequiredBlock(deps, command);
  }
  return dispatchGovernedPr({
    ctx,
    deps,
    seams,
    command,
    verifiedApproval,
    workspace,
    projectId,
    target,
    authority,
    correlationId,
  });
}

export const createHandlePrExecute = (
  options: GitDeliveryPrRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return (ctx, deps) => handlePrExecute(ctx, deps, seams);
};

// ─── Approve handler (mints the server-issued approval claim execute consumes) ────────────────────

export interface GitDeliveryPrApproveResponseBody {
  readonly schemaVersion: "1";
  readonly approval: GitDeliveryApprovalClaim;
  readonly expiresAt: string;
}

function logPrApprovalMinted(
  activityLog: ServerLogSink,
  correlationId: string,
  runId: string,
): void {
  activityLog.write({
    category: "security",
    op: "git.delivery.pr.approval.minted",
    correlationId,
    status: 200,
    extra: { operation: "pr", runId },
  });
}

export const createHandlePrApprove = (
  options: GitDeliveryPrRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    // Reuses the IDENTICAL `validate()` the preview/execute handlers use, so the
    // GitPullRequestCommand this mints against is byte-for-byte the same typed value execute will
    // rebuild from the same request body — the binding-hash consume() already enforces then matches
    // by construction.
    const prepared = await prepareGitDeliveryRequest(ctx, deps, PR_REQUEST_ERRORS, validate);
    if (!prepared.ok) return prepared.result;
    const { workspace } = prepared;
    const { projectId, command } = prepared.value;
    const target = prAuthorityTarget(command);
    const authority = gitDeliveryAuthorityGate(
      ctx,
      deps,
      projectId,
      workspace,
      "pull-request",
      target,
      { logSink: seams.activityLog, deliveryApprovalDeferred: true },
    );
    if (!authority.allowed) return authority.result;
    const store = seams.approvalStore ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE;
    const issued = store.issue({
      binding: prApprovalBinding(projectId, command, authority),
      approvedByUserId: GIT_DELIVERY_LOCAL_OPERATOR_ID,
      nowMs: (seams.now ?? Date.now)(),
    });
    logPrApprovalMinted(
      seams.activityLog ?? processServerLogSink(),
      correlationId,
      authority.runId,
    );
    const body: GitDeliveryPrApproveResponseBody = {
      schemaVersion: "1",
      approval: issued.approval,
      expiresAt: new Date(issued.expiresAtMs).toISOString(),
    };
    return { status: 200, body: deps.redactor(body) };
  };
};

// ─── Route group ───────────────────────────────────────────────────────────────────────────────

export const createGitDeliveryPrRouteGroup = (
  options: GitDeliveryPrRouteOptions = {},
): readonly RouteDefinition[] => [
  {
    method: "POST",
    pattern: "/api/git-delivery/pr/preview",
    handler: createHandlePrPreview(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/pr/approve",
    handler: createHandlePrApprove(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/pr/execute",
    handler: createHandlePrExecute(options),
  },
  // #3389: the mark-ready mint/execute route DEFINITIONS live only in prMarkReadyExecution.ts
  // (createGitDeliveryPrMarkReadyRouteGroup) — spread here rather than re-listed, so this route
  // table and that module's own route group can never drift apart.
  ...createGitDeliveryPrMarkReadyRouteGroup(options.markReady),
];

export const GIT_DELIVERY_PR_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliveryPrRouteGroup();
