// Governed merge routes (Issue #478, Epic #470, ADR-0065).
//
//   * POST /api/git-delivery/merge/preview  — READ-ONLY. Reads the provider's content-free merge-readiness
//       facts and builds the pre-merge context: the readiness summary (mergeable + severity-ranked
//       blockers), the eligible merge strategies (policy ∩ provider capability — never a hard-coded UI
//       default), the recommendation, the effective policy decision, and whether final approval is
//       required. Never mutates, never records evidence.
//   * POST /api/git-delivery/merge/execute  — Governed. Drives the #478 merge gateway end-to-end through
//       executeGovernedMerge (preflight + policy + final-approval + the readiness gate + the dedicated
//       `gh api` merge adapter) and appends content-free evidence for the allowed AND blocked outcome
//       alike. Returns the typed provider-rejection reason + reused recovery hint and the merged /
//       branch-deleted flags.
//
// Content-free in evidence: only the merge inputs (PR number, strategy, delete flag) and outcome enter the
// ledger. CSRF + JSON content type are enforced centrally by server.ts.

import type { IncomingMessage } from "node:http";
import {
  isGitDeliveryApprovalRequirement,
  isGitDeliveryMergeStrategyHint,
  type GitDeliveryApprovalRequirement,
} from "@oscharko-dev/keiko-contracts";
import type { GitMergeCommand } from "@oscharko-dev/keiko-tools";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { isGitDeliveryTrusted } from "./capability.js";
import { resolveProjectWorkspace } from "./execution.js";
import {
  buildGitDeliveryMergePreview,
  executeGovernedMerge,
  gitDeliveryMergeExecuteResponse,
  KEIKO_DEFAULT_MERGE_POLICY_PACK,
  readMergeProviderReadiness,
  type GitDeliveryMergeSeams,
} from "./mergeExecution.js";
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

export type GitDeliveryMergeErrorCode =
  | "GIT_DELIVERY_MERGE_BAD_REQUEST"
  | "GIT_DELIVERY_MERGE_PAYLOAD_TOO_LARGE"
  | "GIT_DELIVERY_MERGE_FORBIDDEN_PAYLOAD"
  | "GIT_DELIVERY_MERGE_DISABLED"
  | "GIT_DELIVERY_MERGE_UNKNOWN_PROJECT"
  | "GIT_DELIVERY_MERGE_WORKTREE_UNAVAILABLE";

const SAFE_MESSAGES: Readonly<Record<GitDeliveryMergeErrorCode, string>> = {
  GIT_DELIVERY_MERGE_BAD_REQUEST: "The request body is not a valid governed merge.",
  GIT_DELIVERY_MERGE_PAYLOAD_TOO_LARGE: "The governed merge request exceeds the maximum size.",
  GIT_DELIVERY_MERGE_FORBIDDEN_PAYLOAD:
    "The request contained a forbidden field. Requests may not carry credentials or auth headers.",
  GIT_DELIVERY_MERGE_DISABLED: "Governed Git delivery is not enabled for this deployment.",
  GIT_DELIVERY_MERGE_UNKNOWN_PROJECT: "The requested project is not a known workspace.",
  GIT_DELIVERY_MERGE_WORKTREE_UNAVAILABLE:
    "The repository worktree could not be inspected. Confirm the project is a Git repository.",
};

const errResult = (status: number, code: GitDeliveryMergeErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

// ─── Options ────────────────────────────────────────────────────────────────────────────────

export interface GitDeliveryMergeRouteOptions {
  readonly execution?: GitDeliveryMergeSeams;
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
        ? errResult(413, "GIT_DELIVERY_MERGE_PAYLOAD_TOO_LARGE")
        : errResult(400, "GIT_DELIVERY_MERGE_BAD_REQUEST");
    return { ok: false, result };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_MERGE_BAD_REQUEST") };
  }
}

// A git ref operand: non-empty, no whitespace, no leading "-" (flag-injection guard), no NUL/control.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const REF_CONTROL_CHAR = new RegExp("[\u0000-\u001f\u007f]");

function isSafeGitRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/\s/.test(value)) return false;
  if (value.startsWith("-")) return false;
  if (REF_CONTROL_CHAR.test(value)) return false;
  if (value.includes(":")) return false;
  return true;
}

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PR_NUMBER_RE = /^[1-9][0-9]{0,9}$/;
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
  readonly approval: GitDeliveryApprovalRequirement;
}

type Validation =
  | { readonly kind: "ok"; readonly value: ValidatedRequest }
  | { readonly kind: "err"; readonly result: RouteResult };

const NO_APPROVAL: GitDeliveryApprovalRequirement = { required: false };

function parseApproval(value: unknown): GitDeliveryApprovalRequirement | undefined {
  if (value === undefined) return NO_APPROVAL;
  return isGitDeliveryApprovalRequirement(value) ? value : undefined;
}

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
  const approval = parseApproval(parsed.approval);
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
    if (!isGitDeliveryTrusted(deps)) return errResult(404, "GIT_DELIVERY_MERGE_DISABLED");
    const read = await readParsed(ctx.req);
    if (!read.ok) return read.result;
    const validation = validate(read.value);
    if (validation.kind === "err") return validation.result;
    const { projectId, command } = validation.value;
    const workspace = resolveProjectWorkspace(deps, projectId);
    if (workspace === undefined) return errResult(404, "GIT_DELIVERY_MERGE_UNKNOWN_PROJECT");
    const packs = seams.policyPacks ?? { repoPack: KEIKO_DEFAULT_MERGE_POLICY_PACK };
    const strategyPolicy = seams.strategyPolicy ?? {
      allowedStrategies: ["squash", "rebase", "merge-commit", "provider-default"],
    };
    const provider = await readMergeProviderReadiness(command, workspace, seams, now);
    return {
      status: 200,
      body: deps.redactor(buildGitDeliveryMergePreview(command, provider, packs, strategyPolicy)),
    };
  };
};

// ─── Execute handler (governed) ───────────────────────────────────────────────────────────────

export const createHandleMergeExecute = (
  options: GitDeliveryMergeRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return async (ctx, deps): Promise<RouteResult> => {
    if (!isGitDeliveryTrusted(deps)) return errResult(404, "GIT_DELIVERY_MERGE_DISABLED");
    const read = await readParsed(ctx.req);
    if (!read.ok) return read.result;
    const validation = validate(read.value);
    if (validation.kind === "err") return validation.result;
    const { projectId, command, approval } = validation.value;
    const workspace = resolveProjectWorkspace(deps, projectId);
    if (workspace === undefined) return errResult(404, "GIT_DELIVERY_MERGE_UNKNOWN_PROJECT");
    let result;
    try {
      result = await executeGovernedMerge(command, approval, workspace, deps, seams);
    } catch {
      // Only the read-only snapshot step can throw (not a git repository); the gateway never throws.
      return errResult(409, "GIT_DELIVERY_MERGE_WORKTREE_UNAVAILABLE");
    }
    return { status: 200, body: deps.redactor(gitDeliveryMergeExecuteResponse(result)) };
  };
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
    pattern: "/api/git-delivery/merge/execute",
    handler: createHandleMergeExecute(options),
  },
];

export const GIT_DELIVERY_MERGE_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliveryMergeRouteGroup();
