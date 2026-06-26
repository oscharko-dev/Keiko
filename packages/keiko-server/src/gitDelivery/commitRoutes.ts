// Governed local Git commit routes: read-only preview + governed execute (Issue #475, Epic #470).
//
//   * POST /api/git-delivery/commit/preview  — READ-ONLY. Builds the pre-commit verification context:
//       staged scope, commit-intent quality warnings (mixed-scope / WIP / large-change), message-policy
//       validation of the draft, preflight findings, and the policy decision. Never mutates, never
//       records evidence.
//   * POST /api/git-delivery/commit/execute  — Governed. Enforces the message policy FIRST (the kernel
//       only sees a byte length, so message rules are evaluated here with the pure contract validator);
//       a violation blocks the commit with typed codes BEFORE the kernel runs. A valid message drives
//       executeGovernedMutation (preflight + policy + approval + execute) and appends evidence.
//
// Content-free throughout: counts, structural area tokens, typed warning/violation/finding codes, and
// the deterministic suggestion scaffold only — never the message body, diff, or raw paths.

import type { IncomingMessage } from "node:http";
import {
  analyzeGitCommitIntent,
  evaluateGitPolicy,
  isGitDeliveryApprovalRequirement,
  KEIKO_DEFAULT_COMMIT_MESSAGE_POLICY,
  validateGitCommitMessage,
  type GitCommitChangeSummary,
  type GitCommitIntentAnalysis,
  type GitCommitMessagePolicy,
  type GitCommitMessageValidation,
  type GitDeliveryApprovalRequirement,
  type GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import { evaluateGitPreflight, summarizeStagedChangeset } from "@oscharko-dev/keiko-tools";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  executeGovernedMutation,
  gitDeliveryMutationResponse,
  KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK,
  readStagedPathsFor,
  readWorktreeSnapshotFor,
  resolveProjectWorkspace,
  type GitDeliveryExecutionSeams,
} from "./execution.js";
import {
  GitDeliveryBodyTooLargeError,
  hasOnlyAllowedKeys,
  isNonEmptyString,
  isPlainObject,
  readGitDeliveryBody,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
} from "./requestGuards.js";

// ─── Error envelope ───────────────────────────────────────────────────────────────────────────

export type GitDeliveryCommitErrorCode =
  | "GIT_DELIVERY_COMMIT_BAD_REQUEST"
  | "GIT_DELIVERY_COMMIT_PAYLOAD_TOO_LARGE"
  | "GIT_DELIVERY_COMMIT_FORBIDDEN_PAYLOAD"
  | "GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT"
  | "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE";

const SAFE_MESSAGES: Readonly<Record<GitDeliveryCommitErrorCode, string>> = {
  GIT_DELIVERY_COMMIT_BAD_REQUEST: "The request body is not a valid governed commit request.",
  GIT_DELIVERY_COMMIT_PAYLOAD_TOO_LARGE: "The governed commit request exceeds the maximum size.",
  GIT_DELIVERY_COMMIT_FORBIDDEN_PAYLOAD:
    "The request contained a forbidden field. Requests may not carry credentials, headers, or URLs.",
  GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT: "The requested project is not a known workspace.",
  GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE:
    "The repository worktree could not be inspected. Confirm the project is a Git repository.",
};

const errResult = (status: number, code: GitDeliveryCommitErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

const UTF8 = new TextEncoder();

// ─── Options ────────────────────────────────────────────────────────────────────────────────

export interface GitDeliveryCommitRouteOptions {
  readonly execution?: GitDeliveryExecutionSeams;
  // The trusted server-side commit-message policy. Default = the repository's conventional-commit style.
  readonly messagePolicy?: GitCommitMessagePolicy;
}

type BodyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly result: RouteResult };

async function readParsed(req: IncomingMessage): Promise<BodyRead> {
  let raw: string;
  try {
    raw = await readGitDeliveryBody(req);
  } catch (error) {
    const result =
      error instanceof GitDeliveryBodyTooLargeError
        ? errResult(413, "GIT_DELIVERY_COMMIT_PAYLOAD_TOO_LARGE")
        : errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST");
    return { ok: false, result };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST") };
  }
}

// Envelope pre-checks shared by both handlers. Returns the validated object or an error RouteResult.
function preValidate(
  parsed: unknown,
  allowed: ReadonlySet<string>,
):
  | { readonly ok: true; readonly obj: Record<string, unknown> }
  | { readonly ok: false; readonly result: RouteResult } {
  const bad = { ok: false as const, result: errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST") };
  if (!isPlainObject(parsed) || !hasOnlyAllowedKeys(parsed, allowed)) return bad;
  if (parsed.schemaVersion !== "1" || !isNonEmptyString(parsed.projectId)) return bad;
  if (scanForbiddenStrings(parsed)) {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_COMMIT_FORBIDDEN_PAYLOAD") };
  }
  if (scanUnsafeFormatChars(parsed)) return bad;
  return { ok: true, obj: parsed };
}

// ─── Preview (read-only) ──────────────────────────────────────────────────────────────────────

const PREVIEW_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "projectId", "messageDraft"]);

export interface GitDeliveryCommitPreviewBody {
  readonly schemaVersion: "1";
  readonly summary: GitCommitChangeSummary;
  readonly intent: GitCommitIntentAnalysis;
  readonly messageValidation: GitCommitMessageValidation;
  readonly preflightFindingCodes: readonly string[];
  readonly policyOutcome: string;
  readonly policyBlockReason?: string;
}

function buildPreviewBody(
  summary: GitCommitChangeSummary,
  messageDraft: string,
  policy: GitCommitMessagePolicy,
  preflightCodes: readonly string[],
  policyOutcome: string,
  policyBlockReason: string | undefined,
): GitDeliveryCommitPreviewBody {
  return {
    schemaVersion: "1",
    summary,
    intent: analyzeGitCommitIntent({ summary, message: messageDraft }),
    messageValidation: validateGitCommitMessage(messageDraft, policy),
    preflightFindingCodes: preflightCodes,
    policyOutcome,
    ...(policyBlockReason !== undefined ? { policyBlockReason } : {}),
  };
}

// Reads the live worktree and assembles the read-only preview. May throw if the worktree cannot be
// inspected (not a git repository); the handler maps that to a typed content-free error.
async function computePreview(
  workspace: import("@oscharko-dev/keiko-workspace").WorkspaceInfo,
  messageDraft: string,
  policy: GitCommitMessagePolicy,
  seams: GitDeliveryExecutionSeams,
  now: () => number,
): Promise<GitDeliveryCommitPreviewBody> {
  const snapshot = await readWorktreeSnapshotFor(workspace, seams, now);
  const stagedPaths = await readStagedPathsFor(workspace, seams, now);
  const summary = summarizeStagedChangeset(stagedPaths);
  const commitInputs: GitDeliveryResolvedInputs = {
    kind: "commit",
    messageByteLength: UTF8.encode(messageDraft).length,
    stagedPathCount: snapshot.stagedFileCount,
    allowEmptyCommit: false,
  };
  const preflight = evaluateGitPreflight(commitInputs, snapshot);
  const packs = seams.policyPacks ?? { repoPack: KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK };
  const decision = evaluateGitPolicy(packs.orgPack, packs.repoPack, {
    actionKind: "commit",
    ...(snapshot.currentBranchName !== undefined
      ? { targetBranchName: snapshot.currentBranchName }
      : {}),
    activeProviderCapabilities: [],
  });
  return buildPreviewBody(
    summary,
    messageDraft,
    policy,
    preflight.findings.map((f) => f.code),
    decision.outcome,
    decision.outcome === "blocked" ? decision.reason : undefined,
  );
}

export const createHandleCommitPreview = (
  options: GitDeliveryCommitRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  const policy = options.messagePolicy ?? KEIKO_DEFAULT_COMMIT_MESSAGE_POLICY;
  const now = (): number => (seams.now ?? Date.now)();
  return async (ctx, deps): Promise<RouteResult> => {
    const read = await readParsed(ctx.req);
    if (!read.ok) return read.result;
    const pre = preValidate(read.value, PREVIEW_KEYS);
    if (!pre.ok) return pre.result;
    const messageDraft = typeof pre.obj.messageDraft === "string" ? pre.obj.messageDraft : "";
    const workspace = resolveProjectWorkspace(deps, pre.obj.projectId as string);
    if (workspace === undefined) return errResult(404, "GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT");
    let body: GitDeliveryCommitPreviewBody;
    try {
      body = await computePreview(workspace, messageDraft, policy, seams, now);
    } catch {
      return errResult(409, "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE");
    }
    return { status: 200, body: deps.redactor(body) };
  };
};

// ─── Execute (governed, with message-policy gate) ───────────────────────────────────────────────

const EXECUTE_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "projectId",
  "message",
  "allowEmpty",
  "approval",
]);

interface ExecuteRequest {
  readonly projectId: string;
  readonly message: string;
  readonly allowEmpty: boolean;
  readonly approval: GitDeliveryApprovalRequirement;
}

const NO_APPROVAL: GitDeliveryApprovalRequirement = { required: false };

function validateExecute(obj: Record<string, unknown>): ExecuteRequest | undefined {
  if (!isNonEmptyString(obj.message)) return undefined;
  if (obj.allowEmpty !== undefined && typeof obj.allowEmpty !== "boolean") return undefined;
  const approval: GitDeliveryApprovalRequirement | undefined =
    obj.approval === undefined
      ? NO_APPROVAL
      : isGitDeliveryApprovalRequirement(obj.approval)
        ? obj.approval
        : undefined;
  if (approval === undefined) return undefined;
  return {
    projectId: obj.projectId as string,
    message: obj.message,
    allowEmpty: obj.allowEmpty === true,
    approval,
  };
}

export const createHandleCommitExecute = (
  options: GitDeliveryCommitRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  const policy = options.messagePolicy ?? KEIKO_DEFAULT_COMMIT_MESSAGE_POLICY;
  return async (ctx, deps): Promise<RouteResult> => {
    const read = await readParsed(ctx.req);
    if (!read.ok) return read.result;
    const pre = preValidate(read.value, EXECUTE_KEYS);
    if (!pre.ok) return pre.result;
    const req = validateExecute(pre.obj);
    if (req === undefined) return errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST");
    const workspace = resolveProjectWorkspace(deps, req.projectId);
    if (workspace === undefined) return errResult(404, "GIT_DELIVERY_COMMIT_UNKNOWN_PROJECT");

    // Message-policy gate (AC2): a policy-violating message blocks the commit BEFORE the kernel runs.
    const validation = validateGitCommitMessage(req.message, policy);
    if (!validation.ok) {
      return {
        status: 200,
        body: deps.redactor({
          schemaVersion: "1",
          status: "blocked",
          actionKind: "commit",
          blockReason: "message-policy",
          messageViolations: validation.violations,
        }),
      };
    }
    let result;
    try {
      result = await executeGovernedMutation(
        { kind: "commit", message: req.message, allowEmpty: req.allowEmpty },
        req.approval,
        workspace,
        deps,
        seams,
      );
    } catch {
      return errResult(409, "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE");
    }
    return { status: 200, body: deps.redactor(gitDeliveryMutationResponse(result)) };
  };
};

// ─── Route group ───────────────────────────────────────────────────────────────────────────────

export const createGitDeliveryCommitRouteGroup = (
  options: GitDeliveryCommitRouteOptions = {},
): readonly RouteDefinition[] => [
  {
    method: "POST",
    pattern: "/api/git-delivery/commit/preview",
    handler: createHandleCommitPreview(options),
  },
  {
    method: "POST",
    pattern: "/api/git-delivery/commit/execute",
    handler: createHandleCommitExecute(options),
  },
];

export const GIT_DELIVERY_COMMIT_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliveryCommitRouteGroup();
