// Governed remote publish routes: read-only preview + governed execute (Issue #476, Epic #470).
//
//   * POST /api/git-delivery/push/preview  — READ-ONLY. Builds the pre-publish risk context: the remote
//       target, the risk class, would-create-remote-branch / force-blocked flags, the preflight findings
//       (incl. non-fast-forward and missing-upstream), and the policy decision. Never mutates, never
//       records evidence.
//   * POST /api/git-delivery/push/approve  — Mints the server-issued approval claim an issue-bound push
//       requires before execute may proceed (#3387, ADR-0138 D2/D4, epic #3384 correction 5: a delivery
//       effect is approval-required in every mode, including Full access — never mode-denied merely
//       because the mode is lower). Mirrors createHandleCommitApprove/createHandleMergeApprove exactly:
//       rebuilds the EXACT typed GitPushCommand the execute route would build from the identical request
//       body (the shared `validate()` below) and binds the mint to it plus the admitted run's
//       runId/envelopeDigest, so the claim this returns is redeemable by execute for that exact push
//       only — a claim minted for a different command, run, or operation never matches.
//   * POST /api/git-delivery/push/execute  — Governed. Drives the #476 publish gateway end-to-end through
//       executeGovernedPublish (preflight + policy + approval + the dedicated push-only adapter) and
//       appends content-free evidence for the allowed AND blocked outcome alike. Returns the typed
//       publish-rejection reason + reused recovery hint so a rejected push can be recovered without
//       guessing. An accepted run's push now requires an actually consumed, server-issued claim — a
//       request that supplies no claim (or an unredeemed `{ required: false }`) is refused with
//       `approval-required`, mirroring the commit route's unapproved-mutation closure (#3386).
//
// Content-free throughout: counts, flags, typed codes, branch/remote NAMES only — never command output,
// diff content, secrets, or credentials. CSRF + JSON content type are enforced centrally by server.ts.

import type { GitDeliveryApprovalClaim } from "@oscharko-dev/keiko-contracts";
import type { GitPushCommand } from "@oscharko-dev/keiko-tools";
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
import { gitDeliveryTerminationHandler, readWorktreeSnapshotFor } from "./execution.js";
import { defaultMintableRepoPack } from "./policyPackMintability.js";
import {
  buildGitDeliveryPushPreview,
  executeGovernedPublish,
  gitDeliveryPublishExecuteResponse,
  KEIKO_DEFAULT_PUBLISH_POLICY_PACK,
  type GitDeliveryPublishSeams,
} from "./pushExecution.js";
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
import {
  createTrustedGitDeliveryBranchProtectionReader,
  signatureRequirementOf,
  type GitDeliverySignatureRequirement,
} from "./branchProtectionPreflight.js";

// ─── Error envelope ───────────────────────────────────────────────────────────────────────────

export type GitDeliveryPushErrorCode =
  | "GIT_DELIVERY_PUSH_BAD_REQUEST"
  | "GIT_DELIVERY_PUSH_PAYLOAD_TOO_LARGE"
  | "GIT_DELIVERY_PUSH_FORBIDDEN_PAYLOAD"
  | "GIT_DELIVERY_PUSH_UNKNOWN_PROJECT"
  | "GIT_DELIVERY_PUSH_WORKTREE_UNAVAILABLE";

const SAFE_MESSAGES: Readonly<Record<GitDeliveryPushErrorCode, string>> = {
  GIT_DELIVERY_PUSH_BAD_REQUEST: "The request body is not a valid governed publish request.",
  GIT_DELIVERY_PUSH_PAYLOAD_TOO_LARGE: "The governed publish request exceeds the maximum size.",
  GIT_DELIVERY_PUSH_FORBIDDEN_PAYLOAD:
    "The request contained a forbidden field. Requests may not carry credentials, headers, or URLs.",
  GIT_DELIVERY_PUSH_UNKNOWN_PROJECT: "The requested project is not a known workspace.",
  GIT_DELIVERY_PUSH_WORKTREE_UNAVAILABLE:
    "The repository worktree could not be inspected. Confirm the project is a Git repository.",
};

const errResult = (status: number, code: GitDeliveryPushErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

const PUSH_REQUEST_ERRORS: GitDeliveryRequestErrors = {
  tooLarge: errResult(413, "GIT_DELIVERY_PUSH_PAYLOAD_TOO_LARGE"),
  badRequest: errResult(400, "GIT_DELIVERY_PUSH_BAD_REQUEST"),
  unknownProject: errResult(404, "GIT_DELIVERY_PUSH_UNKNOWN_PROJECT"),
};

// ─── Options ────────────────────────────────────────────────────────────────────────────────

export interface GitDeliveryPushRouteOptions {
  readonly execution?: GitDeliveryPublishSeams;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "projectId",
  "remoteAlias",
  "remoteBranchName",
  "sourceBranchName",
  "forcePush",
  "setUpstreamTracking",
  "approval",
]);

interface ValidatedRequest {
  readonly projectId: string;
  readonly command: GitPushCommand;
  readonly approval: ParsedGitDeliveryApprovalRequest;
}

type Validation =
  | { readonly kind: "ok"; readonly value: ValidatedRequest }
  | { readonly kind: "err"; readonly result: RouteResult };

function optionalBool(value: unknown): boolean | undefined {
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : undefined;
}

// The credential-shape + unsafe-format-char boundary scans. Returns the typed error RouteResult or
// undefined when the payload is clean.
function scanError(parsed: Record<string, unknown>): RouteResult | undefined {
  if (scanForbiddenStrings(parsed)) {
    return errResult(400, "GIT_DELIVERY_PUSH_FORBIDDEN_PAYLOAD");
  }
  if (scanUnsafeFormatChars(parsed)) {
    return errResult(400, "GIT_DELIVERY_PUSH_BAD_REQUEST");
  }
  return undefined;
}

// Builds the typed push command from validated ref + boolean operands, or undefined when any operand is
// malformed.
function buildPushCommand(parsed: Record<string, unknown>): GitPushCommand | undefined {
  if (
    !isSafeGitRef(parsed.remoteAlias) ||
    !isSafeGitRef(parsed.remoteBranchName) ||
    !isSafeGitRef(parsed.sourceBranchName)
  ) {
    return undefined;
  }
  const forcePush = optionalBool(parsed.forcePush);
  const setUpstreamTracking = optionalBool(parsed.setUpstreamTracking);
  if (forcePush === undefined || setUpstreamTracking === undefined) return undefined;
  return {
    kind: "push",
    sourceBranchName: parsed.sourceBranchName,
    remoteAlias: parsed.remoteAlias,
    remoteBranchName: parsed.remoteBranchName,
    forcePush,
    setUpstreamTracking,
  };
}

function validate(parsed: unknown): Validation {
  const bad: Validation = { kind: "err", result: errResult(400, "GIT_DELIVERY_PUSH_BAD_REQUEST") };
  if (!isPlainObject(parsed) || !hasOnlyAllowedKeys(parsed, ALLOWED_KEYS)) return bad;
  if (parsed.schemaVersion !== "1" || !isNonEmptyString(parsed.projectId)) return bad;
  const scanErr = scanError(parsed);
  if (scanErr !== undefined) return { kind: "err", result: scanErr };
  const command = buildPushCommand(parsed);
  const approval = parseGitDeliveryApprovalRequest(parsed.approval);
  if (command === undefined || approval === undefined) return bad;
  return { kind: "ok", value: { projectId: parsed.projectId, command, approval } };
}

async function pushSignatureRequirement(
  workspace: WorkspaceInfo,
  command: GitPushCommand,
  seams: GitDeliveryPublishSeams,
  correlationId: string,
): Promise<GitDeliverySignatureRequirement> {
  const reader =
    seams.branchProtectionReader ??
    createTrustedGitDeliveryBranchProtectionReader(
      gitDeliveryTerminationHandler(seams, correlationId),
    );
  try {
    return signatureRequirementOf(
      await reader(workspace, command.remoteAlias, command.remoteBranchName),
    );
  } catch {
    return "unavailable";
  }
}

// ─── Preview handler (read-only) ────────────────────────────────────────────────────────────────

export const createHandlePushPreview = (
  options: GitDeliveryPushRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  const now = (): number => (seams.now ?? Date.now)();
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const prepared = await prepareGitDeliveryRequest(ctx, deps, PUSH_REQUEST_ERRORS, validate);
    if (!prepared.ok) return prepared.result;
    const { workspace } = prepared;
    const { command } = prepared.value;
    const packs = seams.policyPacks ?? defaultMintableRepoPack(KEIKO_DEFAULT_PUBLISH_POLICY_PACK);
    try {
      const snapshot = await readWorktreeSnapshotFor(workspace, seams, now, correlationId);
      const signatureRequirement = await pushSignatureRequirement(
        workspace,
        command,
        seams,
        correlationId,
      );
      return {
        status: 200,
        body: deps.redactor(
          buildGitDeliveryPushPreview(command, snapshot, packs, signatureRequirement),
        ),
      };
    } catch {
      return errResult(409, "GIT_DELIVERY_PUSH_WORKTREE_UNAVAILABLE");
    }
  };
};

// ─── Execute handler (governed) ───────────────────────────────────────────────────────────────

function pushApprovalBinding(
  projectId: string,
  command: GitPushCommand,
  authority: GitDeliveryAuthorityIdentity,
): GitDeliveryApprovalBinding {
  return {
    projectId,
    operation: "push",
    command,
    runId: authority.runId,
    envelopeDigest: authority.envelopeDigest,
  };
}

interface PushMutationInput {
  readonly ctx: RouteContext;
  readonly deps: UiHandlerDeps;
  readonly seams: GitDeliveryPublishSeams;
  readonly projectId: string;
  readonly workspace: WorkspaceInfo;
  readonly command: GitPushCommand;
  readonly approval: ParsedGitDeliveryApprovalRequest;
  readonly authority: GitDeliveryAuthorityIdentity;
  readonly target: { readonly headBranchName: string; readonly remoteBranchName: string };
  readonly correlationId: string;
}

// #3387 (ADR-0138 D2): mirrors commitApprovalRequiredBlock (commitRoutes.ts) exactly — an accepted
// run's push requires an actually consumed, server-issued claim regardless of what the repo/org
// policy pack decides; a pack that never names "approval-gated" for push must not silently
// substitute for the human approval this closes. Reuses the kernel's own shared outcome vocabulary
// (GitPublishOutcome["status"] already carries "approval-required" for the pack-driven
// approval-gated path — see gitDeliveryPublishExecuteResponse in pushExecution.ts) rather than
// inventing a second, parallel status for the identical governance outcome.
function pushApprovalRequiredBlock(deps: Pick<UiHandlerDeps, "redactor">): RouteResult {
  return {
    status: 200,
    body: deps.redactor({
      schemaVersion: "1",
      status: "approval-required",
      actionKind: "push",
    }),
  };
}

function logPushApprovalRequired(
  activityLog: ServerLogSink,
  correlationId: string,
  runId: string,
): void {
  activityLog.write({
    category: "security",
    op: "git.delivery.push.approval.required",
    correlationId,
    status: 200,
    extra: { operation: "push", runId },
  });
}

// Resolves the approval requirement, arms the continuity guard, drives the publish gateway, and
// projects the content-free response. Extracted from createHandlePushExecute's returned handler
// purely to stay under the function-length budget (AGENTS.md §6) — no behavioral seam of its own.
async function runPushMutation(input: PushMutationInput): Promise<RouteResult> {
  const { ctx, deps, seams, projectId, workspace, command, approval, authority, target } = input;
  const verifiedApproval = resolveGitDeliveryApprovalRequirement(approval, {
    store: seams.approvalStore,
    binding: pushApprovalBinding(projectId, command, authority),
    nowMs: (seams.now ?? Date.now)(),
  });
  if (verifiedApproval === undefined) return errResult(400, "GIT_DELIVERY_PUSH_BAD_REQUEST");
  if (!verifiedApproval.required) {
    logPushApprovalRequired(
      seams.activityLog ?? processServerLogSink(),
      input.correlationId,
      authority.runId,
    );
    return pushApprovalRequiredBlock(deps);
  }
  const denialCapture: GitDeliveryAuthorityContinuityDenialCapture = {};
  const beforeRemoteDispatch = gitDeliveryAuthorityContinuityGuard({
    ctx,
    deps,
    projectId,
    workspace,
    operation: "push",
    target,
    admitted: authority,
    next: seams.beforeRemoteDispatch,
    denialCapture,
    // Same deferral as the up-front admission gate above: the approval was already verified as
    // consumed before this dispatch was reached, so the continuity re-check must not re-demand it.
    audit: { logSink: seams.activityLog, deliveryApprovalDeferred: true },
  });
  try {
    const result = await executeGovernedPublish(
      command,
      verifiedApproval,
      workspace,
      deps,
      { ...seams, beforeRemoteDispatch, authorityDenialCapture: denialCapture },
      input.correlationId,
    );
    // The continuity guard denied mid-flight (revoked/replaced authority): nothing was dispatched, and
    // `result` is the gateway's synthetic no-spawn stand-in. Return the SAME 403 the up-front admission
    // gate would have returned, not a 200 that projects the stand-in as a retryable internal failure.
    if (denialCapture.result !== undefined) return denialCapture.result;
    return { status: 200, body: deps.redactor(gitDeliveryPublishExecuteResponse(result)) };
  } catch {
    // Only the read-only snapshot step can throw (not a git repository); the gateway never throws.
    return errResult(409, "GIT_DELIVERY_PUSH_WORKTREE_UNAVAILABLE");
  }
}

export const createHandlePushExecute = (
  options: GitDeliveryPushRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    const prepared = await prepareGitDeliveryRequest(ctx, deps, PUSH_REQUEST_ERRORS, validate);
    if (!prepared.ok) return prepared.result;
    const { workspace } = prepared;
    const { projectId, command, approval } = prepared.value;
    const target = {
      headBranchName: command.sourceBranchName,
      remoteBranchName: command.remoteBranchName,
    };
    const authority = gitDeliveryAuthorityGate(ctx, deps, projectId, workspace, "push", target, {
      logSink: seams.activityLog,
      // Final-audit F2/#3390 (ADR-0138 D2, #3387): push's own execute path already enforces a
      // mandatory, mode-independent consumed approval below (`pushApprovalRequiredBlock`), so this
      // coarse admission layer defers to it instead of demanding a second claim.
      deliveryApprovalDeferred: true,
    });
    if (!authority.allowed) return authority.result;
    return runPushMutation({
      ctx,
      deps,
      seams,
      projectId,
      workspace,
      command,
      approval,
      authority,
      target,
      correlationId,
    });
  };
};

// ─── Approve handler (mints the server-issued approval claim execute consumes) ────────────────────

export interface GitDeliveryPushApproveResponseBody {
  readonly schemaVersion: "1";
  readonly approval: GitDeliveryApprovalClaim;
  readonly expiresAt: string;
}

function logPushApprovalMinted(
  activityLog: ServerLogSink,
  correlationId: string,
  runId: string,
): void {
  activityLog.write({
    category: "security",
    op: "git.delivery.push.approval.minted",
    correlationId,
    status: 200,
    extra: { operation: "push", runId },
  });
}

export const createHandlePushApprove = (
  options: GitDeliveryPushRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return async (ctx, deps): Promise<RouteResult> => {
    const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
    // Reuses the IDENTICAL `validate()` the preview/execute handlers use, so the GitPushCommand this
    // mints against is byte-for-byte the same typed value execute will rebuild from the same request
    // body — the binding-hash consume() already enforces then matches by construction.
    const prepared = await prepareGitDeliveryRequest(ctx, deps, PUSH_REQUEST_ERRORS, validate);
    if (!prepared.ok) return prepared.result;
    const { workspace } = prepared;
    const { projectId, command } = prepared.value;
    const target = {
      headBranchName: command.sourceBranchName,
      remoteBranchName: command.remoteBranchName,
    };
    const authority = gitDeliveryAuthorityGate(ctx, deps, projectId, workspace, "push", target, {
      logSink: seams.activityLog,
      // Final-audit F2/#3390 (ADR-0138 D2, #3387): push's own execute path already enforces a
      // mandatory, mode-independent consumed approval below (`pushApprovalRequiredBlock`), so this
      // coarse admission layer defers to it instead of demanding a second claim.
      deliveryApprovalDeferred: true,
    });
    if (!authority.allowed) return authority.result;
    const store = seams.approvalStore ?? DEFAULT_GIT_DELIVERY_APPROVAL_STORE;
    const issued = store.issue({
      binding: pushApprovalBinding(projectId, command, authority),
      approvedByUserId: GIT_DELIVERY_LOCAL_OPERATOR_ID,
      nowMs: (seams.now ?? Date.now)(),
    });
    logPushApprovalMinted(
      seams.activityLog ?? processServerLogSink(),
      correlationId,
      authority.runId,
    );
    const body: GitDeliveryPushApproveResponseBody = {
      schemaVersion: "1",
      approval: issued.approval,
      expiresAt: new Date(issued.expiresAtMs).toISOString(),
    };
    return { status: 200, body: deps.redactor(body) };
  };
};

// ─── Route group ───────────────────────────────────────────────────────────────────────────────

export const createGitDeliveryPushRouteGroup = (
  options: GitDeliveryPushRouteOptions = {},
): readonly RouteDefinition[] => [
  {
    method: "POST",
    pattern: "/api/git-delivery/push/preview",
    handler: createHandlePushPreview(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/push/approve",
    handler: createHandlePushApprove(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/push/execute",
    handler: createHandlePushExecute(options),
  },
];

export const GIT_DELIVERY_PUSH_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliveryPushRouteGroup();
