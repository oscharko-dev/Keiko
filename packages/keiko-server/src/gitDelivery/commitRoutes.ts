// Governed local Git commit routes: read-only preview + governed execute (Issue #475, Epic #470).
//
//   * POST /api/git-delivery/commit/preview  — READ-ONLY. Builds the pre-commit verification context:
//       staged scope, commit-intent quality warnings (mixed-scope / WIP / large-change), message-policy
//       validation of the draft, preflight findings, and the policy decision. Never mutates, never
//       records evidence.
//   * POST /api/git-delivery/commit/execute  — Governed. Enforces the message policy FIRST (the kernel
//       only sees a byte length, so message rules are evaluated here with the pure contract validator);
//       a violation blocks the commit with typed codes BEFORE the kernel runs. SECOND, refuses to
//       commit staged content that still contains an unresolved merge-conflict marker (`git add`
//       clears git's own "unmerged path" state the moment a conflicted file is staged, so nothing
//       downstream — the worktree snapshot, the kernel's preflight, the commit adapter — would
//       otherwise ever notice a conflicted file whose markers were staged without being resolved; the
//       commit would silently bake the literal marker lines into history). A message that passes both
//       gates drives executeGovernedMutation (preflight + policy + approval + execute) and appends
//       evidence.
//
// Content-free throughout: counts, structural area tokens, typed warning/violation/finding codes, and
// the deterministic suggestion scaffold only — never the message body, diff, or raw paths.

import type { IncomingMessage } from "node:http";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  analyzeGitCommitIntent,
  evaluateGitPolicy,
  KEIKO_DEFAULT_COMMIT_MESSAGE_POLICY,
  validateGitCommitMessage,
  type GitCommitChangeSummary,
  type GitCommitIntentAnalysis,
  type GitCommitMessagePolicy,
  type GitCommitMessageValidation,
  type GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import { evaluateGitPreflight, summarizeStagedChangeset } from "@oscharko-dev/keiko-tools";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  parseGitDeliveryApprovalRequest,
  resolveGitDeliveryApprovalRequirement,
  type ParsedGitDeliveryApprovalRequest,
} from "./approvalStore.js";
import {
  executeGovernedMutation,
  gitDeliveryMutationResponse,
  KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK,
  readStagedConflictMarkerFileCountFor,
  readStagedPathsFor,
  readWorktreeSnapshotFor,
  resolveProjectWorkspace,
  type GitDeliveryExecutionSeams,
} from "./execution.js";
import {
  hasOnlyAllowedKeys,
  isNonEmptyString,
  isPlainObject,
  readParsedGitDeliveryBody,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
  type GitDeliveryParsedBody,
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

const readParsed = (req: IncomingMessage): Promise<GitDeliveryParsedBody<RouteResult>> =>
  readParsedGitDeliveryBody(
    req,
    () => errResult(413, "GIT_DELIVERY_COMMIT_PAYLOAD_TOO_LARGE"),
    () => errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST"),
  );

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
  workspace: WorkspaceInfo,
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
  readonly approval: ParsedGitDeliveryApprovalRequest;
}

function validateExecute(obj: Record<string, unknown>): ExecuteRequest | undefined {
  if (!isNonEmptyString(obj.message)) return undefined;
  if (obj.allowEmpty !== undefined && typeof obj.allowEmpty !== "boolean") return undefined;
  const approval = parseGitDeliveryApprovalRequest(obj.approval);
  if (approval === undefined) return undefined;
  return {
    projectId: obj.projectId as string,
    message: obj.message,
    allowEmpty: obj.allowEmpty === true,
    approval,
  };
}

// Message-policy gate (AC2): a policy-violating message blocks the commit BEFORE the kernel runs.
// Returns undefined when the message is clean (proceed).
function messagePolicyBlockResult(
  message: string,
  policy: GitCommitMessagePolicy,
  deps: Pick<UiHandlerDeps, "redactor">,
): RouteResult | undefined {
  const validation = validateGitCommitMessage(message, policy);
  if (validation.ok) return undefined;
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

// Unresolved-conflict-marker gate: refuses to commit staged content that still contains a
// `<<<<<<<`/`=======`/`>>>>>>>` marker git-add-ed without being resolved. Runs BEFORE the kernel — by
// the time `git add` has staged the file, git's OWN "unmerged path" tracking for it is already
// cleared, so nothing downstream would otherwise ever notice. A read failure here (e.g. the worktree
// is not inspectable) fails closed to WORKTREE_UNAVAILABLE, same as every other worktree read this
// route performs. Returns undefined when nothing was flagged (proceed).
async function conflictMarkerBlockResult(
  workspace: WorkspaceInfo,
  seams: GitDeliveryExecutionSeams,
  deps: Pick<UiHandlerDeps, "redactor">,
): Promise<RouteResult | undefined> {
  let conflictMarkerFileCount: number;
  try {
    conflictMarkerFileCount = await readStagedConflictMarkerFileCountFor(
      workspace,
      seams,
      seams.now ?? Date.now,
    );
  } catch {
    return errResult(409, "GIT_DELIVERY_COMMIT_WORKTREE_UNAVAILABLE");
  }
  if (conflictMarkerFileCount === 0) return undefined;
  return {
    status: 200,
    body: deps.redactor({
      schemaVersion: "1",
      status: "blocked",
      actionKind: "commit",
      blockReason: "unresolved-conflict-markers",
      conflictMarkerFileCount,
    }),
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

    const messageBlock = messagePolicyBlockResult(req.message, policy, deps);
    if (messageBlock !== undefined) return messageBlock;

    const conflictBlock = await conflictMarkerBlockResult(workspace, seams, deps);
    if (conflictBlock !== undefined) return conflictBlock;

    const command = { kind: "commit" as const, message: req.message, allowEmpty: req.allowEmpty };
    const verifiedApproval = resolveGitDeliveryApprovalRequirement(req.approval, {
      store: seams.approvalStore,
      binding: { projectId: req.projectId, operation: "commit", command },
      nowMs: (seams.now ?? Date.now)(),
    });
    if (verifiedApproval === undefined) return errResult(400, "GIT_DELIVERY_COMMIT_BAD_REQUEST");
    let result;
    try {
      result = await executeGovernedMutation(command, verifiedApproval, workspace, deps, seams);
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
