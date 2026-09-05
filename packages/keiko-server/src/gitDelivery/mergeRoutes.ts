// Governed merge routes (Issue #478, Epic #470, ADR-0087).
//
//   * POST /api/git-delivery/merge/preview  — READ-ONLY. Reads the provider's content-free merge-readiness
//       facts and builds the pre-merge context: the readiness summary (mergeable + severity-ranked
//       blockers), the eligible merge strategies (policy ∩ provider capability — never a hard-coded UI
//       default), the recommendation, the effective policy decision, and whether final approval is
//       required. Never mutates, never records evidence.
//   * POST /api/git-delivery/merge/approve  — Mints the server-issued approval claim the default
//       approval-gated merge policy pack (KEIKO_DEFAULT_MERGE_POLICY_PACK) requires before execute may
//       proceed. Before this route existed, no HTTP path anywhere could produce a
//       GitDeliveryApprovalClaim: `GitDeliveryApprovalStore.issue()` was called only from unit tests,
//       so a merge gated by the default pack was unreachable from any UI surface by construction — the
//       final-approval checkbox in GovernedMergeCard confirmed nothing the server could verify. This
//       route rebuilds the EXACT typed GitMergeCommand the execute route would build from the identical
//       request body (the shared `validate()` below) and binds the mint to it, so the claim this
//       returns is redeemable by execute for that exact target only (same binding-hash rule consume()
//       already enforced). Attributed to the fixed local-operator principal: this product is
//       loopback-bound and single-user (ADR-0129/AGENTS.md §1), so there is no separate authenticated
//       end user to attribute the mint to beyond the one human at the keyboard.
//   * POST /api/git-delivery/merge/execute  — Governed. Drives the #478 merge gateway end-to-end through
//       executeGovernedMerge (preflight + policy + final-approval + the readiness gate + the dedicated
//       `gh api` merge adapter) and appends content-free evidence for the allowed AND blocked outcome
//       alike. Returns the typed provider-rejection reason + reused recovery hint and the merged /
//       branch-deleted flags.
//
// Content-free in evidence: only the merge inputs (PR number, strategy, delete flag) and outcome enter the
// ledger. CSRF + JSON content type are enforced centrally by server.ts.

import type {
  GitDeliveryApprovalClaim,
  GitDeliveryApprovalRequirement,
} from "@oscharko-dev/keiko-contracts";
import { isGitDeliveryMergeStrategyHint } from "@oscharko-dev/keiko-contracts/runtime/git-delivery";
import type { GitMergeCommand } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import {
  DEFAULT_GIT_DELIVERY_APPROVAL_STORE,
  GIT_DELIVERY_LOCAL_OPERATOR_ID,
  parseGitDeliveryApprovalRequest,
  resolveGitDeliveryApprovalRequirement,
  type ParsedGitDeliveryApprovalRequest,
} from "./approvalStore.js";
import { defaultMintableRepoPack } from "./policyPackMintability.js";
import {
  buildGitDeliveryMergePreview,
  executeGovernedMerge,
  gitDeliveryMergeExecuteResponse,
  KEIKO_DEFAULT_MERGE_POLICY_PACK,
  readMergeProviderReadiness,
  type GitDeliveryMergeSeams,
} from "./mergeExecution.js";
import {
  hasOnlyAllowedKeys,
  isNonEmptyString,
  isPlainObject,
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

export type GitDeliveryMergeErrorCode =
  | "GIT_DELIVERY_MERGE_BAD_REQUEST"
  | "GIT_DELIVERY_MERGE_PAYLOAD_TOO_LARGE"
  | "GIT_DELIVERY_MERGE_FORBIDDEN_PAYLOAD"
  | "GIT_DELIVERY_MERGE_UNKNOWN_PROJECT"
  | "GIT_DELIVERY_MERGE_WORKTREE_UNAVAILABLE";

const SAFE_MESSAGES: Readonly<Record<GitDeliveryMergeErrorCode, string>> = {
  GIT_DELIVERY_MERGE_BAD_REQUEST: "The request body is not a valid governed merge.",
  GIT_DELIVERY_MERGE_PAYLOAD_TOO_LARGE: "The governed merge request exceeds the maximum size.",
  GIT_DELIVERY_MERGE_FORBIDDEN_PAYLOAD:
    "The request contained a forbidden field. Requests may not carry credentials or auth headers.",
  GIT_DELIVERY_MERGE_UNKNOWN_PROJECT: "The requested project is not a known workspace.",
  GIT_DELIVERY_MERGE_WORKTREE_UNAVAILABLE:
    "The repository worktree could not be inspected. Confirm the project is a Git repository.",
};

const errResult = (status: number, code: GitDeliveryMergeErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

const MERGE_REQUEST_ERRORS: GitDeliveryRequestErrors = {
  tooLarge: errResult(413, "GIT_DELIVERY_MERGE_PAYLOAD_TOO_LARGE"),
  badRequest: errResult(400, "GIT_DELIVERY_MERGE_BAD_REQUEST"),
  unknownProject: errResult(404, "GIT_DELIVERY_MERGE_UNKNOWN_PROJECT"),
};

// ─── Options ────────────────────────────────────────────────────────────────────────────────

export interface GitDeliveryMergeRouteOptions {
  readonly execution?: GitDeliveryMergeSeams;
}

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PR_NUMBER_RE = /^[1-9]\d{0,9}$/;
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

function isOwnerAndRepo(value: unknown): value is string {
  return typeof value === "string" && OWNER_REPO_RE.test(value);
}

function isPrNumberString(value: unknown): value is string {
  return typeof value === "string" && PR_NUMBER_RE.test(value);
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "projectId",
  "kind",
  "ownerAndRepo",
  "prExternalId",
  "baseBranchName",
  "headBranchName",
  "mergeStrategy",
  "deleteBranchAfterMerge",
  "expectedHeadRefHash",
  "approval",
]);

interface ValidatedRequest {
  readonly projectId: string;
  readonly command: GitMergeCommand;
  readonly approval: ParsedGitDeliveryApprovalRequest;
}

type Validation =
  | { readonly kind: "ok"; readonly value: ValidatedRequest }
  | { readonly kind: "err"; readonly result: RouteResult };

function optionalBool(value: unknown): boolean | undefined {
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : undefined;
}

function parseExpectedHeadRefHash(value: unknown): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value === "string" && SHA_RE.test(value)) return { ok: true, value };
  return { ok: false };
}

function scanError(parsed: Record<string, unknown>): RouteResult | undefined {
  if (scanForbiddenStrings(parsed)) {
    return errResult(400, "GIT_DELIVERY_MERGE_FORBIDDEN_PAYLOAD");
  }
  if (scanUnsafeFormatChars(parsed)) {
    return errResult(400, "GIT_DELIVERY_MERGE_BAD_REQUEST");
  }
  return undefined;
}

function buildMergeCommand(parsed: Record<string, unknown>): GitMergeCommand | undefined {
  if (
    parsed.kind !== "merge" ||
    !isOwnerAndRepo(parsed.ownerAndRepo) ||
    !isPrNumberString(parsed.prExternalId) ||
    !isSafeGitRef(parsed.baseBranchName) ||
    !isSafeGitRef(parsed.headBranchName) ||
    !isGitDeliveryMergeStrategyHint(parsed.mergeStrategy)
  ) {
    return undefined;
  }
  const deleteBranchAfterMerge = optionalBool(parsed.deleteBranchAfterMerge);
  const expectedHead = parseExpectedHeadRefHash(parsed.expectedHeadRefHash);
  if (deleteBranchAfterMerge === undefined || !expectedHead.ok) {
    return undefined;
  }
  return {
    kind: "merge",
    ownerAndRepo: parsed.ownerAndRepo,
    prExternalId: parsed.prExternalId,
    baseBranchName: parsed.baseBranchName,
    headBranchName: parsed.headBranchName,
    mergeStrategy: parsed.mergeStrategy,
    deleteBranchAfterMerge,
    ...(expectedHead.value !== undefined ? { expectedHeadRefHash: expectedHead.value } : {}),
  };
}

function validate(parsed: unknown): Validation {
  const bad: Validation = { kind: "err", result: errResult(400, "GIT_DELIVERY_MERGE_BAD_REQUEST") };
  if (!isPlainObject(parsed) || !hasOnlyAllowedKeys(parsed, ALLOWED_KEYS)) return bad;
  if (parsed.schemaVersion !== "1" || !isNonEmptyString(parsed.projectId)) return bad;
  const scanErr = scanError(parsed);
  if (scanErr !== undefined) return { kind: "err", result: scanErr };
  const command = buildMergeCommand(parsed);
  const approval = parseGitDeliveryApprovalRequest(parsed.approval);
  if (command === undefined || approval === undefined) return bad;
  return { kind: "ok", value: { projectId: parsed.projectId, command, approval } };
}

// ─── Preview handler (read-only) ────────────────────────────────────────────────────────────────

export const createHandleMergePreview = (
  options: GitDeliveryMergeRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  const now = (): number => (seams.now ?? Date.now)();
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const prepared = await prepareGitDeliveryRequest(ctx, deps, MERGE_REQUEST_ERRORS, validate);
    if (!prepared.ok) return prepared.result;
    const { workspace } = prepared;
    const { command } = prepared.value;
    const packs = seams.policyPacks ?? defaultMintableRepoPack(KEIKO_DEFAULT_MERGE_POLICY_PACK);
    const strategyPolicy = seams.strategyPolicy ?? {
      allowedStrategies: ["squash", "rebase", "merge-commit", "provider-default"],
    };
    const provider = await readMergeProviderReadiness(
      command,
      workspace,
      seams,
      now,
      correlationId,
    );
    return {
      status: 200,
      body: deps.redactor(buildGitDeliveryMergePreview(command, provider, packs, strategyPolicy)),
    };
  };
};

// ─── Approve handler (mints the server-issued approval claim execute consumes) ────────────────────

export interface GitDeliveryMergeApproveResponseBody {
  readonly schemaVersion: "1";
  readonly approval: GitDeliveryApprovalClaim;
  readonly expiresAt: string;
}

export const createHandleMergeApprove = (
  options: GitDeliveryMergeRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return async (ctx, deps): Promise<RouteResult> => {
    // Reuses the IDENTICAL `validate()` the preview/execute handlers use, so the GitMergeCommand this
    // mints against is byte-for-byte the same typed value execute will rebuild from the same request
    // body — the binding-hash consume() already enforces then matches by construction.
    const prepared = await prepareGitDeliveryRequest(ctx, deps, MERGE_REQUEST_ERRORS, validate);
    if (!prepared.ok) return prepared.result;
    const { workspace } = prepared;
    const { projectId, command } = prepared.value;
    const authority = gitDeliveryAuthorityGate(
      ctx,
      deps,
      projectId,
      workspace,
      "merge",
      {
        headBranchName: command.headBranchName,
        baseBranchName: command.baseBranchName,
      },
      {
        logSink: seams.activityLog,
        // Final-audit F2/#3390 (ADR-0138 D2): merge's own execute path already enforces a
        // mandatory, mode-independent consumed approval below, so this coarse admission layer
        // defers to it instead of demanding a second claim.
        deliveryApprovalDeferred: true,
      },
    );
    if (!authority.allowed) return authority.result;
    const store = seams.approvalStore ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE;
    const issued = store.issue({
      binding: {
        projectId,
        operation: "merge",
        command,
        runId: authority.runId,
        envelopeDigest: authority.envelopeDigest,
      },
      approvedByUserId: GIT_DELIVERY_LOCAL_OPERATOR_ID,
      nowMs: (seams.now ?? Date.now)(),
    });
    const body: GitDeliveryMergeApproveResponseBody = {
      schemaVersion: "1",
      approval: issued.approval,
      expiresAt: new Date(issued.expiresAtMs).toISOString(),
    };
    return { status: 200, body: deps.redactor(body) };
  };
};

// ─── Execute handler (governed) ───────────────────────────────────────────────────────────────

function mergeAuthorityTarget(command: GitMergeCommand): {
  readonly headBranchName: string;
  readonly baseBranchName: string;
} {
  return { headBranchName: command.headBranchName, baseBranchName: command.baseBranchName };
}

type MergeAuthorityTarget = ReturnType<typeof mergeAuthorityTarget>;

interface GovernedMergeDispatch {
  readonly ctx: RouteContext;
  readonly deps: UiHandlerDeps;
  readonly seams: GitDeliveryMergeSeams;
  readonly command: GitMergeCommand;
  readonly verifiedApproval: GitDeliveryApprovalRequirement;
  readonly workspace: WorkspaceInfo;
  readonly projectId: string;
  readonly target: MergeAuthorityTarget;
  readonly authority: GitDeliveryAuthorityIdentity;
  readonly correlationId: string;
}

// Runs the continuity-guarded dispatch: builds the guard (capturing a mid-flight denial's 403), calls
// the merge gateway, and — when the guard denied — returns that SAME 403 instead of projecting the
// gateway's synthetic no-spawn result as a misleading 200 internal failure. Split out of the handler
// purely to keep the handler under the repo's max-lines-per-function bar.
async function dispatchGovernedMerge(input: GovernedMergeDispatch): Promise<RouteResult> {
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
    operation: "merge",
    target,
    admitted: authority,
    next: seams.beforeRemoteDispatch,
    denialCapture,
    audit: { logSink: seams.activityLog, deliveryApprovalDeferred: true },
  });
  try {
    const result = await executeGovernedMerge(
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
    return { status: 200, body: deps.redactor(gitDeliveryMergeExecuteResponse(result)) };
  } catch {
    return errResult(409, "GIT_DELIVERY_MERGE_WORKTREE_UNAVAILABLE");
  }
}

async function handleMergeExecute(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  seams: GitDeliveryMergeSeams,
): Promise<RouteResult> {
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  const prepared = await prepareGitDeliveryRequest(ctx, deps, MERGE_REQUEST_ERRORS, validate);
  if (!prepared.ok) return prepared.result;
  const { workspace } = prepared;
  const { projectId, command, approval } = prepared.value;
  const target = mergeAuthorityTarget(command);
  const authority = gitDeliveryAuthorityGate(ctx, deps, projectId, workspace, "merge", target, {
    logSink: seams.activityLog,
    deliveryApprovalDeferred: true,
  });
  if (!authority.allowed) return authority.result;
  const verifiedApproval = resolveGitDeliveryApprovalRequirement(approval, {
    store: seams.approvalStore,
    binding: {
      projectId,
      operation: "merge",
      command,
      runId: authority.runId,
      envelopeDigest: authority.envelopeDigest,
    },
    nowMs: (seams.now ?? Date.now)(),
  });
  if (verifiedApproval === undefined) return errResult(400, "GIT_DELIVERY_MERGE_BAD_REQUEST");
  return dispatchGovernedMerge({
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

export const createHandleMergeExecute = (
  options: GitDeliveryMergeRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return (ctx, deps) => handleMergeExecute(ctx, deps, seams);
};

// ─── Route group ───────────────────────────────────────────────────────────────────────────────

export const createGitDeliveryMergeRouteGroup = (
  options: GitDeliveryMergeRouteOptions = {},
): readonly RouteDefinition[] => [
  {
    method: "POST",
    pattern: "/api/git-delivery/merge/preview",
    handler: createHandleMergePreview(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/merge/approve",
    handler: createHandleMergeApprove(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/merge/execute",
    handler: createHandleMergeExecute(options),
  },
];

export const GIT_DELIVERY_MERGE_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliveryMergeRouteGroup();
