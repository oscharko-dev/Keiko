// Agent-facing repository operation facade contract (Issue #1577, Epic #1571).
// Pure wire types and validators only. The facade grants no shell, process, provider, credential, or
// model authority; server handlers must delegate to existing Git read and Git delivery routes.

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
  "unsupported-direct-shell" | "unsupported-operation" | "idempotency-conflict" | "bad-request";

export const GIT_REPOSITORY_AGENT_DENIAL_REASONS: readonly GitRepositoryAgentDenialReason[] = [
  "unsupported-direct-shell",
  "unsupported-operation",
  "idempotency-conflict",
  "bad-request",
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

function containsDirectShellShape(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDirectShellShape);
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (DIRECT_SHELL_KEYS.has(key) || key.toLowerCase().includes("credential")) return true;
    if (containsDirectShellShape(child)) return true;
  }
  return false;
}

function parseFail(
  denialReason: GitRepositoryAgentDenialReason,
  message: string,
): GitRepositoryAgentParseFail {
  return { ok: false, denialReason, message };
}

function validateEnvelope(
  input: unknown,
):
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | GitRepositoryAgentParseFail {
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

function parseOperation(
  value: unknown,
): GitRepositoryAgentOperationKind | GitRepositoryAgentParseFail {
  if (isOperation(value)) return value;
  return parseFail("unsupported-operation", "Operation is not supported by the repository facade.");
}

function parseMode(
  operation: GitRepositoryAgentOperationKind,
  value: unknown,
): GitRepositoryAgentOperationMode | GitRepositoryAgentParseFail {
  if (isMode(value) && MODE_BY_OPERATION[operation].includes(value)) return value;
  return parseFail("bad-request", "Operation mode is invalid for this repository operation.");
}

function parseProjectId(value: unknown): string | GitRepositoryAgentParseFail {
  if (typeof value === "string" && value.length > 0) return value;
  return parseFail("bad-request", "projectId must be a string.");
}

function parseIdempotencyKey(
  mode: GitRepositoryAgentOperationMode,
  value: unknown,
): string | undefined | GitRepositoryAgentParseFail {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    return parseFail("bad-request", "idempotencyKey must be a non-empty string.");
  }
  if (mode === "execute" && value === undefined) {
    return parseFail("bad-request", "execute operations require an idempotencyKey.");
  }
  return value;
}

function parsePayload(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined | GitRepositoryAgentParseFail {
  if (value === undefined) return undefined;
  if (isRecord(value)) return value;
  return parseFail("bad-request", "payload must be an object.");
}

function isParseFail(value: unknown): value is GitRepositoryAgentParseFail {
  return isRecord(value) && value.ok === false;
}

export function parseGitRepositoryAgentOperationRequest(
  input: unknown,
): GitRepositoryAgentParseResult {
  const envelope = validateEnvelope(input);
  if (isParseFail(envelope)) return envelope;
  const operation = parseOperation(envelope.value.operation);
  if (isParseFail(operation)) return operation;
  const mode = parseMode(operation, envelope.value.mode);
  if (isParseFail(mode)) return mode;
  const projectId = parseProjectId(envelope.value.projectId);
  if (isParseFail(projectId)) return projectId;
  const idempotencyKey = parseIdempotencyKey(mode, envelope.value.idempotencyKey);
  if (isParseFail(idempotencyKey)) return idempotencyKey;
  const payload = parsePayload(envelope.value.payload);
  if (isParseFail(payload)) return payload;
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
