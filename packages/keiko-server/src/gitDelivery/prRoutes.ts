// Governed GitHub pull request routes (Issue #477, Epic #470, ADR-0064).
//
//   * POST /api/git-delivery/pr/preview  — READ-ONLY. Builds the pre-create context: the synthesized,
//       user-editable metadata draft (title/body/risk narrative), the readiness summary (objectExists vs
//       reviewReady) with structured blockers, the draft-vs-ready recommendation, the reviewer/label/
//       linkage suggestions, and the effective policy decision. Never mutates, never records evidence.
//   * POST /api/git-delivery/pr/execute  — Governed. Drives the #477 PR gateway end-to-end through
//       executeGovernedPullRequest (preflight + policy + approval + the dedicated `gh api` adapter) and
//       appends content-free evidence for the allowed AND blocked outcome alike. Returns the typed
//       provider-rejection reason + reused recovery hint so a rejected operation recovers without
//       guessing, and the provider-assigned PR number on a successful create.
//
// Content-free in evidence: title/body strings flow to the provider but only their byte lengths enter
// the ledger. CSRF + JSON content type are enforced centrally by server.ts.

import type { IncomingMessage } from "node:http";
import {
  isGitDeliveryApprovalRequirement,
  type GitDeliveryApprovalRequirement,
} from "@oscharko-dev/keiko-contracts";
import type { GitPullRequestCommand } from "@oscharko-dev/keiko-tools";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { readWorktreeSnapshotFor, resolveProjectWorkspace } from "./execution.js";
import {
  buildGitDeliveryPrPreview,
  executeGovernedPullRequest,
  gitDeliveryPrExecuteResponse,
  KEIKO_DEFAULT_PR_POLICY_PACK,
  type GitDeliveryPullRequestSeams,
} from "./prExecution.js";
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

// ─── Options ────────────────────────────────────────────────────────────────────────────────

export interface GitDeliveryPrRouteOptions {
  readonly execution?: GitDeliveryPullRequestSeams;
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
        ? errResult(413, "GIT_DELIVERY_PR_PAYLOAD_TOO_LARGE")
        : errResult(400, "GIT_DELIVERY_PR_BAD_REQUEST");
    return { ok: false, result };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_PR_BAD_REQUEST") };
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

function isOwnerAndRepo(value: unknown): value is string {
  return typeof value === "string" && OWNER_REPO_RE.test(value);
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

function isPrNumberString(value: unknown): value is string {
  return typeof value === "string" && PR_NUMBER_RE.test(value);
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
function parseConvertFlags(
  parsed: Record<string, unknown>,
): { convertToDraft: boolean; convertFromDraft: boolean } | undefined {
  const convertToDraft = optionalBool(parsed.convertToDraft);
  const convertFromDraft = optionalBool(parsed.convertFromDraft);
  if (convertToDraft === undefined || convertFromDraft === undefined) return undefined;
  if (convertToDraft && convertFromDraft) return undefined;
  return { convertToDraft, convertFromDraft };
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
  const approval = parseApproval(parsed.approval);
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
    const read = await readParsed(ctx.req);
    if (!read.ok) return read.result;
    const validation = validate(read.value);
    if (validation.kind === "err") return validation.result;
    const { projectId, command } = validation.value;
    const workspace = resolveProjectWorkspace(deps, projectId);
    if (workspace === undefined) return errResult(404, "GIT_DELIVERY_PR_UNKNOWN_PROJECT");
    const packs = seams.policyPacks ?? { repoPack: KEIKO_DEFAULT_PR_POLICY_PACK };
    try {
      const snapshot = await readWorktreeSnapshotFor(workspace, seams, now);
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

export const createHandlePrExecute = (
  options: GitDeliveryPrRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return async (ctx, deps): Promise<RouteResult> => {
    const read = await readParsed(ctx.req);
    if (!read.ok) return read.result;
    const validation = validate(read.value);
    if (validation.kind === "err") return validation.result;
    const { projectId, command, approval } = validation.value;
    const workspace = resolveProjectWorkspace(deps, projectId);
    if (workspace === undefined) return errResult(404, "GIT_DELIVERY_PR_UNKNOWN_PROJECT");
    let result;
    try {
      result = await executeGovernedPullRequest(command, approval, workspace, deps, seams);
    } catch {
      // Only the read-only snapshot step can throw (not a git repository); the gateway never throws.
      return errResult(409, "GIT_DELIVERY_PR_WORKTREE_UNAVAILABLE");
    }
    return { status: 200, body: deps.redactor(gitDeliveryPrExecuteResponse(result)) };
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
    pattern: "/api/git-delivery/pr/execute",
    handler: createHandlePrExecute(options),
  },
];

export const GIT_DELIVERY_PR_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliveryPrRouteGroup();
