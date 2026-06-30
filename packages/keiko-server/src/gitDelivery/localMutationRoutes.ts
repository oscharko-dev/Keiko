// Governed local Git branch + staging execution routes (Issue #475, Epic #470).
//
// Four additive POST handlers that EXECUTE a governed local mutation through the #472 kernel:
//   * POST /api/git-delivery/local-branch/create
//   * POST /api/git-delivery/local-branch/switch
//   * POST /api/git-delivery/staging/stage
//   * POST /api/git-delivery/staging/unstage
//
// Every handler runs the SAME chain: bounded body + envelope hardening (allowed keys,
// credential-shape + unsafe-format-char scans) →
// typed field validation → project authorization → executeGovernedMutation (live snapshot → kernel
// preflight/policy/approval/execute → evidence) → redacted content-free response. CSRF + JSON content
// type are enforced centrally by server.ts.

import type { IncomingMessage } from "node:http";
import {
  isGitDeliveryApprovalRequirement,
  type GitDeliveryApprovalRequirement,
} from "@oscharko-dev/keiko-contracts";
import type { GitMutationCommand } from "@oscharko-dev/keiko-tools";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  executeGovernedMutation,
  gitDeliveryMutationResponse,
  resolveProjectWorkspace,
  type GitDeliveryExecutionSeams,
} from "./execution.js";
import {
  GitDeliveryBodyTooLargeError,
  hasOnlyAllowedKeys,
  isContainedPathspec,
  isNonEmptyString,
  isPlainObject,
  readGitDeliveryBody,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
} from "./requestGuards.js";

// ─── Error envelope (typed, content-free) ────────────────────────────────────────────────────

export type GitDeliveryLocalErrorCode =
  | "GIT_DELIVERY_LOCAL_BAD_REQUEST"
  | "GIT_DELIVERY_LOCAL_PAYLOAD_TOO_LARGE"
  | "GIT_DELIVERY_LOCAL_FORBIDDEN_PAYLOAD"
  | "GIT_DELIVERY_LOCAL_UNKNOWN_PROJECT"
  | "GIT_DELIVERY_LOCAL_WORKTREE_UNAVAILABLE";

export interface GitDeliveryLocalErrorBody {
  readonly error: { readonly code: GitDeliveryLocalErrorCode; readonly message: string };
}

const SAFE_MESSAGES: Readonly<Record<GitDeliveryLocalErrorCode, string>> = {
  GIT_DELIVERY_LOCAL_BAD_REQUEST: "The request body is not a valid governed local Git request.",
  GIT_DELIVERY_LOCAL_PAYLOAD_TOO_LARGE:
    "The governed local Git request exceeds the maximum permitted size.",
  GIT_DELIVERY_LOCAL_FORBIDDEN_PAYLOAD:
    "The request contained a forbidden field. Requests may not carry credentials, headers, or URLs.",
  GIT_DELIVERY_LOCAL_UNKNOWN_PROJECT: "The requested project is not a known workspace.",
  GIT_DELIVERY_LOCAL_WORKTREE_UNAVAILABLE:
    "The repository worktree could not be inspected. Confirm the project is a Git repository.",
};

const errResult = (status: number, code: GitDeliveryLocalErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } } satisfies GitDeliveryLocalErrorBody,
});

// ─── Per-action command parsing ───────────────────────────────────────────────────────────────
// Each spec declares its allowed request keys and a pure command parser. projectId + optional approval
// are shared; the command-specific fields are validated in `parse`.

type ParsedCommand =
  { readonly ok: true; readonly command: GitMutationCommand } | { readonly ok: false };

interface LocalMutationSpec {
  readonly pattern: string;
  readonly allowedKeys: ReadonlySet<string>;
  readonly parse: (obj: Record<string, unknown>) => ParsedCommand;
}

const sharedKeys = ["schemaVersion", "projectId", "approval"] as const;

const BRANCH_CREATE_SPEC: LocalMutationSpec = {
  pattern: "/api/git-delivery/local-branch/create",
  allowedKeys: new Set([...sharedKeys, "branchName", "baseBranchName", "startPointRefHash"]),
  parse: (obj) => {
    if (
      isNonEmptyString(obj.branchName) &&
      isNonEmptyString(obj.baseBranchName) &&
      isNonEmptyString(obj.startPointRefHash)
    ) {
      return {
        ok: true,
        command: {
          kind: "branch-create",
          branchName: obj.branchName,
          baseBranchName: obj.baseBranchName,
          startPointRefHash: obj.startPointRefHash,
        },
      };
    }
    return { ok: false };
  },
};

const BRANCH_SWITCH_SPEC: LocalMutationSpec = {
  pattern: "/api/git-delivery/local-branch/switch",
  allowedKeys: new Set([...sharedKeys, "branchName"]),
  parse: (obj) =>
    isNonEmptyString(obj.branchName)
      ? { ok: true, command: { kind: "branch-switch", branchName: obj.branchName } }
      : { ok: false },
};

function parsePathspecs(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every(isContainedPathspec)) return undefined;
  return value;
}

const STAGE_SPEC: LocalMutationSpec = {
  pattern: "/api/git-delivery/staging/stage",
  allowedKeys: new Set([...sharedKeys, "pathspecs", "includeUntracked"]),
  parse: (obj) => {
    const pathspecs = parsePathspecs(obj.pathspecs);
    if (pathspecs === undefined || typeof obj.includeUntracked !== "boolean") return { ok: false };
    return {
      ok: true,
      command: { kind: "stage", pathspecs, includeUntracked: obj.includeUntracked },
    };
  },
};

const UNSTAGE_SPEC: LocalMutationSpec = {
  pattern: "/api/git-delivery/staging/unstage",
  allowedKeys: new Set([...sharedKeys, "pathspecs"]),
  parse: (obj) => {
    const pathspecs = parsePathspecs(obj.pathspecs);
    return pathspecs === undefined
      ? { ok: false }
      : { ok: true, command: { kind: "unstage", pathspecs } };
  },
};

// ─── Shared validation ──────────────────────────────────────────────────────────────────────

interface ValidatedRequest {
  readonly projectId: string;
  readonly command: GitMutationCommand;
  readonly approval: GitDeliveryApprovalRequirement;
}

type Validation =
  | { readonly kind: "ok"; readonly value: ValidatedRequest }
  | { readonly kind: "err"; readonly result: RouteResult };

function parseApproval(value: unknown): GitDeliveryApprovalRequirement | undefined {
  if (value === undefined) return { required: false };
  return isGitDeliveryApprovalRequirement(value) ? value : undefined;
}

function validate(spec: LocalMutationSpec, parsed: unknown): Validation {
  const bad: Validation = {
    kind: "err",
    result: errResult(400, "GIT_DELIVERY_LOCAL_BAD_REQUEST"),
  };
  if (!isPlainObject(parsed) || !hasOnlyAllowedKeys(parsed, spec.allowedKeys)) return bad;
  if (parsed.schemaVersion !== "1") return bad;
  if (scanForbiddenStrings(parsed)) {
    return { kind: "err", result: errResult(400, "GIT_DELIVERY_LOCAL_FORBIDDEN_PAYLOAD") };
  }
  if (scanUnsafeFormatChars(parsed)) return bad;
  if (!isNonEmptyString(parsed.projectId)) return bad;
  const approval = parseApproval(parsed.approval);
  if (approval === undefined) return bad;
  const command = spec.parse(parsed);
  if (!command.ok) return bad;
  return { kind: "ok", value: { projectId: parsed.projectId, command: command.command, approval } };
}

// ─── Handler factory ──────────────────────────────────────────────────────────────────────────

export interface GitDeliveryLocalRouteOptions {
  readonly execution?: GitDeliveryExecutionSeams;
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
        ? errResult(413, "GIT_DELIVERY_LOCAL_PAYLOAD_TOO_LARGE")
        : errResult(400, "GIT_DELIVERY_LOCAL_BAD_REQUEST");
    return { ok: false, result };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, result: errResult(400, "GIT_DELIVERY_LOCAL_BAD_REQUEST") };
  }
}

export const createHandleLocalMutation = (
  spec: LocalMutationSpec,
  options: GitDeliveryLocalRouteOptions = {},
): ((ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>) => {
  const seams = options.execution ?? {};
  return async (ctx, deps): Promise<RouteResult> => {
    const read = await readParsed(ctx.req);
    if (!read.ok) return read.result;
    const validation = validate(spec, read.value);
    if (validation.kind === "err") return validation.result;
    const { projectId, command, approval } = validation.value;
    const workspace = resolveProjectWorkspace(deps, projectId);
    if (workspace === undefined) return errResult(404, "GIT_DELIVERY_LOCAL_UNKNOWN_PROJECT");
    let result;
    try {
      result = await executeGovernedMutation(command, approval, workspace, deps, seams);
    } catch {
      // The live worktree could not be read (not a git repository, git unavailable). The kernel itself
      // never throws — only the read-only snapshot step can — so this is a precondition failure, not a
      // mutation; nothing was executed.
      return errResult(409, "GIT_DELIVERY_LOCAL_WORKTREE_UNAVAILABLE");
    }
    return { status: 200, body: deps.redactor(gitDeliveryMutationResponse(result)) };
  };
};

export const createGitDeliveryLocalMutationRouteGroup = (
  options: GitDeliveryLocalRouteOptions = {},
): readonly RouteDefinition[] =>
  [BRANCH_CREATE_SPEC, BRANCH_SWITCH_SPEC, STAGE_SPEC, UNSTAGE_SPEC].map((spec) => ({
    method: "POST",
    pattern: spec.pattern,
    handler: createHandleLocalMutation(spec, options),
  }));

// Mechanically-mergeable route group spread into API_ROUTES by routes.ts.
export const GIT_DELIVERY_LOCAL_MUTATION_ROUTE_GROUP: readonly RouteDefinition[] =
  createGitDeliveryLocalMutationRouteGroup();
