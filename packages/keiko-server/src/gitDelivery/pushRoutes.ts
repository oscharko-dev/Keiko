// Governed remote publish routes: read-only preview + governed execute (Issue #476, Epic #470).
//
//   * POST /api/git-delivery/push/preview  — READ-ONLY. Builds the pre-publish risk context: the remote
//       target, the risk class, would-create-remote-branch / force-blocked flags, the preflight findings
//       (incl. non-fast-forward and missing-upstream), and the policy decision. Never mutates, never
//       records evidence.
//   * POST /api/git-delivery/push/execute  — Governed. Drives the #476 publish gateway end-to-end through
//       executeGovernedPublish (preflight + policy + approval + the dedicated push-only adapter) and
//       appends content-free evidence for the allowed AND blocked outcome alike. Returns the typed
//       publish-rejection reason + reused recovery hint so a rejected push can be recovered without
//       guessing.
//
// Content-free throughout: counts, flags, typed codes, branch/remote NAMES only — never command output,
// diff content, secrets, or credentials. CSRF + JSON content type are enforced centrally by server.ts.

import type { GitPushCommand } from "@oscharko-dev/keiko-tools";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  parseGitDeliveryApprovalRequest,
  resolveGitDeliveryApprovalRequirement,
  type ParsedGitDeliveryApprovalRequest,
} from "./approvalStore.js";
import { readWorktreeSnapshotFor } from "./execution.js";
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
  gitDeliveryAuthorityDenial,
  prepareGitDeliveryRequest,
  type GitDeliveryRequestErrors,
} from "./requestPreparation.js";
import {
  readTrustedGitDeliveryBranchProtection,
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
): Promise<GitDeliverySignatureRequirement> {
  const reader = seams.branchProtectionReader ?? readTrustedGitDeliveryBranchProtection;
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
    const prepared = await prepareGitDeliveryRequest(ctx, deps, PUSH_REQUEST_ERRORS, validate);
    if (!prepared.ok) return prepared.result;
    const { workspace } = prepared;
    const { command } = prepared.value;
    const packs = seams.policyPacks ?? defaultMintableRepoPack(KEIKO_DEFAULT_PUBLISH_POLICY_PACK);
    try {
      const snapshot = await readWorktreeSnapshotFor(workspace, seams, now);
      const signatureRequirement = await pushSignatureRequirement(workspace, command, seams);
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

export const createHandlePushExecute = (
  options: GitDeliveryPushRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return async (ctx, deps): Promise<RouteResult> => {
    const prepared = await prepareGitDeliveryRequest(ctx, deps, PUSH_REQUEST_ERRORS, validate);
    if (!prepared.ok) return prepared.result;
    const { workspace } = prepared;
    const { projectId, command, approval } = prepared.value;
    const authorityDenial = gitDeliveryAuthorityDenial(ctx, deps, projectId, workspace, "push", {
      headBranchName: command.sourceBranchName,
      baseBranchName: command.remoteBranchName,
    });
    if (authorityDenial !== undefined) return authorityDenial;
    const verifiedApproval = resolveGitDeliveryApprovalRequirement(approval, {
      store: seams.approvalStore,
      binding: { projectId, operation: "push", command },
      nowMs: (seams.now ?? Date.now)(),
    });
    if (verifiedApproval === undefined) return errResult(400, "GIT_DELIVERY_PUSH_BAD_REQUEST");
    let result;
    try {
      result = await executeGovernedPublish(command, verifiedApproval, workspace, deps, seams);
    } catch {
      // Only the read-only snapshot step can throw (not a git repository); the gateway never throws.
      return errResult(409, "GIT_DELIVERY_PUSH_WORKTREE_UNAVAILABLE");
    }
    return { status: 200, body: deps.redactor(gitDeliveryPublishExecuteResponse(result)) };
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
    pattern: "/api/git-delivery/push/execute",
    handler: createHandlePushExecute(options),
  },
];

export const GIT_DELIVERY_PUSH_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliveryPushRouteGroup();
