// Agent-facing repository operation facade contract (Issue #1577, Epic #1571).
// Pure wire types and validators only. The facade grants no shell, process, provider, credential, or
// model authority; server handlers must delegate to existing Git read and Git delivery routes.

import type {
  CodingWorkbenchApprovalRisk,
  CodingWorkbenchMode,
  CodingWorkbenchPolicyResourceScope,
} from "./coding-workbench.js";
import { CODING_WORKBENCH_MODES, codingWorkbenchPolicyEffectFor } from "./coding-workbench.js";

export const GIT_REPOSITORY_AGENT_SCHEMA_VERSION = "1" as const;

export type GitRepositoryAgentOperationMode = "read" | "preview" | "execute";

export const GIT_REPOSITORY_AGENT_OPERATION_MODES: readonly GitRepositoryAgentOperationMode[] = [
  "read",
  "preview",
  "execute",
] as const;

export type GitRepositoryAgentOperationKind =
  | "status"
  | "diff"
  | "branch-list"
  | "branch-create"
  | "branch-switch"
  | "stage"
  | "unstage"
  | "commit"
  | "fetch"
  | "pull"
  | "push"
  | "pull-request"
  | "merge";

export const GIT_REPOSITORY_AGENT_OPERATION_KINDS: readonly GitRepositoryAgentOperationKind[] = [
  "status",
  "diff",
  "branch-list",
  "branch-create",
  "branch-switch",
  "stage",
  "unstage",
  "commit",
  "fetch",
  "pull",
  "push",
  "pull-request",
  "merge",
] as const;

export type GitRepositoryAgentDenialReason =
  | "unsupported-direct-shell"
  | "unsupported-operation"
  | "idempotency-conflict"
  | "bad-request"
  // The effective product-wide autonomy mode does not admit this operation without a per-action
  // human approval (ADR-0129 / ADR-0138). Mode-independent hard denials keep their own reasons.
  | "autonomy-mode-denied";

export const GIT_REPOSITORY_AGENT_DENIAL_REASONS: readonly GitRepositoryAgentDenialReason[] = [
  "unsupported-direct-shell",
  "unsupported-operation",
  "idempotency-conflict",
  "bad-request",
  "autonomy-mode-denied",
] as const;

export interface GitRepositoryAgentOperationRequest {
  readonly schemaVersion: typeof GIT_REPOSITORY_AGENT_SCHEMA_VERSION;
  readonly operation: GitRepositoryAgentOperationKind;
  readonly mode: GitRepositoryAgentOperationMode;
  readonly projectId: string;
  readonly idempotencyKey?: string | undefined;
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
}

export interface GitRepositoryAgentOperationDelegatedResponse {
  readonly schemaVersion: typeof GIT_REPOSITORY_AGENT_SCHEMA_VERSION;
  readonly operation: GitRepositoryAgentOperationKind;
  readonly mode: GitRepositoryAgentOperationMode;
  readonly status: "delegated";
  readonly routeStatus: number;
  readonly replay?: boolean | undefined;
  readonly response: unknown;
}

export interface GitRepositoryAgentOperationDeniedResponse {
  readonly schemaVersion: typeof GIT_REPOSITORY_AGENT_SCHEMA_VERSION;
  readonly operation?: GitRepositoryAgentOperationKind | undefined;
  readonly mode?: GitRepositoryAgentOperationMode | undefined;
  readonly status: "denied";
  readonly denialReason: GitRepositoryAgentDenialReason;
  readonly message: string;
}

export type GitRepositoryAgentOperationResponse =
  GitRepositoryAgentOperationDelegatedResponse | GitRepositoryAgentOperationDeniedResponse;

export interface GitRepositoryAgentParseOk {
  readonly ok: true;
  readonly value: GitRepositoryAgentOperationRequest;
}

export interface GitRepositoryAgentParseFail {
  readonly ok: false;
  readonly denialReason: GitRepositoryAgentDenialReason;
  readonly message: string;
}

export type GitRepositoryAgentParseResult = GitRepositoryAgentParseOk | GitRepositoryAgentParseFail;

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "idempotencyKey",
  "operation",
  "mode",
  "projectId",
  "payload",
]);

const DIRECT_SHELL_KEYS: ReadonlySet<string> = new Set([
  "argv",
  "args",
  "body",
  "command",
  "credential",
  "endpoint",
  "cwd",
  "env",
  "executable",
  "ghEndpoint",
  "gitSubcommand",
  "headers",
  "method",
  "providerPayload",
  "providerState",
  "repositoryRoot",
  "root",
  "script",
  "shell",
  "token",
  "url",
]);

const MODE_BY_OPERATION: Readonly<
  Record<GitRepositoryAgentOperationKind, readonly GitRepositoryAgentOperationMode[]>
> = {
  status: ["read"],
  diff: ["read"],
  "branch-list": ["read"],
  "branch-create": ["execute"],
  "branch-switch": ["execute"],
  stage: ["execute"],
  unstage: ["execute"],
  commit: ["preview", "execute"],
  fetch: ["preview", "execute"],
  pull: ["preview", "execute"],
  push: ["preview", "execute"],
  "pull-request": ["preview", "execute"],
  merge: ["preview", "execute"],
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperation(value: unknown): value is GitRepositoryAgentOperationKind {
  return (
    typeof value === "string" &&
    GIT_REPOSITORY_AGENT_OPERATION_KINDS.includes(value as GitRepositoryAgentOperationKind)
  );
}

function isMode(value: unknown): value is GitRepositoryAgentOperationMode {
  return (
    typeof value === "string" &&
    GIT_REPOSITORY_AGENT_OPERATION_MODES.includes(value as GitRepositoryAgentOperationMode)
  );
}

// Case-folded once, from the readable table above, so the lookup and the table can never disagree.
// A hand-written second lowercase list would silently drop `ghEndpoint`/`gitSubcommand` the moment
// either side was edited.
const DIRECT_SHELL_KEYS_LOWERCASE: ReadonlySet<string> = new Set(
  [...DIRECT_SHELL_KEYS].map((key) => key.toLowerCase()),
);

// The screen walks attacker-shaped bodies, so it needs a depth budget: unbounded recursion over a
// deeply nested payload risks a RangeError surfacing as an untyped 500 instead of a typed denial.
// Exceeding the budget denies — a body too nested to screen is never admitted.
const DIRECT_SHELL_SHAPE_MAX_DEPTH = 64;

function containsDirectShellShape(value: unknown, depth = 0): boolean {
  if (depth > DIRECT_SHELL_SHAPE_MAX_DEPTH) return true;
  if (Array.isArray(value)) {
    return value.some((element) => containsDirectShellShape(element, depth + 1));
  }
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    // Case-INSENSITIVE: the lookup used to be an exact Set hit, so `{Shell:"rm -rf /"}` walked
    // past a control whose whole purpose is rejecting command-shaped payloads.
    const lowercaseKey = key.toLowerCase();
    if (DIRECT_SHELL_KEYS_LOWERCASE.has(lowercaseKey) || lowercaseKey.includes("credential")) {
      return true;
    }
    if (containsDirectShellShape(child, depth + 1)) return true;
  }
  return false;
}

function parseFail(
  denialReason: GitRepositoryAgentDenialReason,
  message: string,
): GitRepositoryAgentParseFail {
  return { ok: false, denialReason, message };
}

interface InternalParseOk<T> {
  readonly ok: true;
  readonly value: T;
}

type InternalParseResult<T> = InternalParseOk<T> | GitRepositoryAgentParseFail;

function validateEnvelope(input: unknown): InternalParseResult<Readonly<Record<string, unknown>>> {
  if (!isRecord(input)) return parseFail("bad-request", "Request body must be an object.");
  if (containsDirectShellShape(input)) {
    return parseFail(
      "unsupported-direct-shell",
      "Repository operations must use typed Git facade actions, not shell commands.",
    );
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key))
      return parseFail("bad-request", "Request contains an extra field.");
  }
  if (input.schemaVersion !== GIT_REPOSITORY_AGENT_SCHEMA_VERSION) {
    return parseFail("bad-request", "schemaVersion is invalid.");
  }
  return { ok: true, value: input };
}

function parseOperation(value: unknown): InternalParseResult<GitRepositoryAgentOperationKind> {
  if (isOperation(value)) return { ok: true, value };
  return parseFail("unsupported-operation", "Operation is not supported by the repository facade.");
}

function parseMode(
  operation: GitRepositoryAgentOperationKind,
  value: unknown,
): InternalParseResult<GitRepositoryAgentOperationMode> {
  if (isMode(value) && MODE_BY_OPERATION[operation].includes(value)) {
    return { ok: true, value };
  }
  return parseFail("bad-request", "Operation mode is invalid for this repository operation.");
}

function parseProjectId(value: unknown): InternalParseResult<string> {
  if (typeof value === "string" && value.length > 0) return { ok: true, value };
  return parseFail("bad-request", "projectId must be a string.");
}

function parseIdempotencyKey(
  mode: GitRepositoryAgentOperationMode,
  value: unknown,
): InternalParseResult<string | undefined> {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    return parseFail("bad-request", "idempotencyKey must be a non-empty string.");
  }
  if (mode === "execute" && value === undefined) {
    return parseFail("bad-request", "execute operations require an idempotencyKey.");
  }
  return { ok: true, value };
}

function parsePayload(
  value: unknown,
): InternalParseResult<Readonly<Record<string, unknown>> | undefined> {
  if (value === undefined) return { ok: true, value };
  if (isRecord(value)) return { ok: true, value };
  return parseFail("bad-request", "payload must be an object.");
}

export function parseGitRepositoryAgentOperationRequest(
  input: unknown,
): GitRepositoryAgentParseResult {
  const envelope = validateEnvelope(input);
  if (!envelope.ok) return envelope;
  const parsedOperation = parseOperation(envelope.value.operation);
  if (!parsedOperation.ok) return parsedOperation;
  const operation = parsedOperation.value;
  const parsedMode = parseMode(operation, envelope.value.mode);
  if (!parsedMode.ok) return parsedMode;
  const mode = parsedMode.value;
  const parsedProjectId = parseProjectId(envelope.value.projectId);
  if (!parsedProjectId.ok) return parsedProjectId;
  const projectId = parsedProjectId.value;
  const parsedIdempotencyKey = parseIdempotencyKey(mode, envelope.value.idempotencyKey);
  if (!parsedIdempotencyKey.ok) return parsedIdempotencyKey;
  const idempotencyKey = parsedIdempotencyKey.value;
  const parsedPayload = parsePayload(envelope.value.payload);
  if (!parsedPayload.ok) return parsedPayload;
  const payload = parsedPayload.value;
  return {
    ok: true,
    value: {
      schemaVersion: GIT_REPOSITORY_AGENT_SCHEMA_VERSION,
      operation,
      mode,
      projectId,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(payload === undefined ? {} : { payload }),
    },
  };
}

// ─── Autonomy admission (ADR-0129 product-wide authority model, ADR-0138 monotonic semantics) ─────
//
// The facade is the door an AGENT walks through to write to the user's repository, so the product's
// three modes have to mean something here. They did not: admission was the closed operation envelope
// plus the delegated route's own policy pack, and nothing anywhere asked which autonomy mode the
// local human had accepted. A read is admitted in every mode ("allows reads and planning"); a
// preview is read-only planning and likewise always admitted; an EXECUTE is admitted only at or
// above the mode that grants its authority class without a per-action approval.
//
// Pure and total: a rule table plus the shared authority ordering. It never widens anything — the
// delegated route still runs preflight, policy packs, approval and the mode-independent hard denials.

export type GitRepositoryAgentAuthorityClass =
  // Inspection of the repository. No mutation, no network.
  | "repository-read"
  // A workspace-contained write: index, branch pointer, local commit.
  | "workspace-write"
  // Leaves the machine or lets the network into it: fetch, pull, push, pull request, merge.
  | "repository-delivery";

const AUTHORITY_CLASS_BY_OPERATION: Readonly<
  Record<GitRepositoryAgentOperationKind, GitRepositoryAgentAuthorityClass>
> = {
  status: "repository-read",
  diff: "repository-read",
  "branch-list": "repository-read",
  "branch-create": "workspace-write",
  "branch-switch": "workspace-write",
  stage: "workspace-write",
  unstage: "workspace-write",
  commit: "workspace-write",
  fetch: "repository-delivery",
  pull: "repository-delivery",
  push: "repository-delivery",
  "pull-request": "repository-delivery",
  merge: "repository-delivery",
};

// KEIKO-0227: consolidated onto coding-workbench.ts's shared CODING_WORKBENCH_MODE_POLICIES
// (ADR-0138 D2's total mode/resource-scope/risk matrix) instead of an independently-maintained
// threshold table. Each authority class maps to the resource scope + risk pair that carries its
// intent through that shared matrix. This is a genuine design decision, not a mechanical 1:1
// substitution -- git-repository-agent.ts's classes have no risk dimension of their own:
//
//  - "repository-read" and "workspace-write" both name "workspace-contained" at "low" risk. Reads
//    never actually reach this lookup (no repository-read operation ever carries an "execute"
//    mode per MODE_BY_OPERATION -- the `mode !== "execute"` guard below always admits them first),
//    so this entry exists only for the Record's exhaustiveness; "workspace-contained"/"low" is the
//    closest honest choice if that ever changed. For "workspace-write" it preserves the existing
//    threshold unchanged: allowed starting at supervised-coding, approval-required below it.
//  - "repository-delivery" (fetch/pull/push/pull-request/merge -- leaves the machine or lets the
//    network in) names "delivery". CODING_WORKBENCH_MODE_POLICIES declares "delivery"
//    approval-required at every risk tier in every mode, including autonomous-delivery, so the
//    specific risk chosen here never changes the outcome; "high" is the most honest label for an
//    action that can affect shared or remote state. This is the deliberate, owner-approved
//    convergence onto the STRICTER model: the facade previously admitted these five operations
//    outright once effectiveMode reached autonomous-delivery, with no approval channel of its own
//    -- a materially more permissive, independently-maintained contract for the identical
//    operations than the shared table already enforced (ADR-0087 D6: merge is an explicit,
//    approval-gated action, auto-merge scheduling out of scope; ADR-0129 D4).
const AUTHORITY_CLASS_POLICY: Readonly<
  Record<
    GitRepositoryAgentAuthorityClass,
    {
      readonly resourceScope: CodingWorkbenchPolicyResourceScope;
      readonly risk: CodingWorkbenchApprovalRisk;
    }
  >
> = {
  "repository-read": { resourceScope: "workspace-contained", risk: "low" },
  "workspace-write": { resourceScope: "workspace-contained", risk: "low" },
  "repository-delivery": { resourceScope: "delivery", risk: "high" },
};

export function gitRepositoryAgentAuthorityClassFor(
  operation: GitRepositoryAgentOperationKind,
): GitRepositoryAgentAuthorityClass {
  return AUTHORITY_CLASS_BY_OPERATION[operation];
}

/**
 * True when `effectiveMode` admits this operation in this mode without a separate per-action
 * approval. Reads and previews are always admitted. An execute is admitted only when the shared
 * CODING_WORKBENCH_MODE_POLICIES matrix resolves this operation's class to "allowed" at
 * `effectiveMode`. "approval-required" is treated as inadmissible here: this boolean facade has no
 * approval channel of its own, so anything short of an unconditional "allowed" fails closed.
 */
export function gitRepositoryAgentOperationAdmitted(
  operation: GitRepositoryAgentOperationKind,
  mode: GitRepositoryAgentOperationMode,
  effectiveMode: CodingWorkbenchMode,
): boolean {
  if (mode !== "execute") return true;
  const { resourceScope, risk } =
    AUTHORITY_CLASS_POLICY[gitRepositoryAgentAuthorityClassFor(operation)];
  return codingWorkbenchPolicyEffectFor(effectiveMode, resourceScope, risk) === "allowed";
}

/**
 * The lowest mode that admits this operation's class through `gitRepositoryAgentOperationAdmitted`
 * without a separate approval, or `undefined` when no mode does -- reachable only for
 * "repository-delivery" today, whose "delivery" resource scope is approval-required at every risk
 * tier in every mode. Derived by scanning the same shared matrix `gitRepositoryAgentOperationAdmitted`
 * itself consults, so it can never disagree with the admission decision above -- there is no
 * second, independently-maintained threshold anywhere in this module.
 */
export function gitRepositoryAgentMinimumMode(
  operation: GitRepositoryAgentOperationKind,
): CodingWorkbenchMode | undefined {
  return CODING_WORKBENCH_MODES.find((mode) =>
    gitRepositoryAgentOperationAdmitted(operation, "execute", mode),
  );
}

export function isGitRepositoryAgentOperationResponse(
  input: unknown,
): input is GitRepositoryAgentOperationResponse {
  if (!isRecord(input)) return false;
  if (input.schemaVersion !== GIT_REPOSITORY_AGENT_SCHEMA_VERSION) return false;
  if (input.status === "delegated") {
    return (
      isOperation(input.operation) && isMode(input.mode) && typeof input.routeStatus === "number"
    );
  }
  if (input.status === "denied") {
    return (
      typeof input.message === "string" &&
      typeof input.denialReason === "string" &&
      GIT_REPOSITORY_AGENT_DENIAL_REASONS.includes(
        input.denialReason as GitRepositoryAgentDenialReason,
      )
    );
  }
  return false;
}
