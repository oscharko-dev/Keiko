// Typed repository-operation facade for agents (Issue #1577, Epic #1571).
//
// This is an admission and dispatch layer only. It accepts a closed semantic operation envelope,
// rejects shell/provider-shaped input before delegation, and forwards to existing Git read /
// git-delivery route handlers. It does not import or create any new Git, gh, terminal, or provider
// adapter authority.

import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  GIT_REPOSITORY_AGENT_SCHEMA_VERSION,
  parseGitRepositoryAgentOperationRequest,
  type GitRepositoryAgentDenialReason,
  type GitRepositoryAgentOperationKind,
  type GitRepositoryAgentOperationRequest,
  type GitRepositoryAgentOperationResponse,
} from "@oscharko-dev/keiko-contracts";
import { STREAMING, type RouteContext, type RouteDefinition, type RouteResult } from "../routes.js";
import { handleGitBranches, handleGitDiff, handleGitStatus } from "../gitRoutes.js";
import type { UiHandlerDeps } from "../deps.js";
import { createGitDeliveryCommitRouteGroup } from "./commitRoutes.js";
import { createGitDeliveryLocalMutationRouteGroup } from "./localMutationRoutes.js";
import { createGitDeliveryMergeRouteGroup } from "./mergeRoutes.js";
import { createGitDeliveryPrRouteGroup } from "./prRoutes.js";
import { createGitDeliveryPushRouteGroup } from "./pushRoutes.js";
import { createGitDeliverySyncRouteGroup } from "./syncRoutes.js";
import {
  GitDeliveryBodyTooLargeError,
  hasOnlyAllowedKeys,
  isPlainObject,
  readGitDeliveryBody,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
} from "./requestGuards.js";

type DelegatedResult = RouteResult;

type AgentErrorCode =
  | "GIT_AGENT_OPERATION_BAD_REQUEST"
  | "GIT_AGENT_OPERATION_PAYLOAD_TOO_LARGE"
  | "GIT_AGENT_OPERATION_FORBIDDEN_PAYLOAD"
  | "GIT_AGENT_OPERATION_UNSUPPORTED";

const SAFE_MESSAGES: Readonly<Record<AgentErrorCode, string>> = {
  GIT_AGENT_OPERATION_BAD_REQUEST: "The request body is not a valid repository operation.",
  GIT_AGENT_OPERATION_PAYLOAD_TOO_LARGE:
    "The repository operation request exceeds the maximum permitted size.",
  GIT_AGENT_OPERATION_FORBIDDEN_PAYLOAD:
    "The request contained a forbidden credential, header, URL, or unsafe text shape.",
  GIT_AGENT_OPERATION_UNSUPPORTED: "The repository operation is not supported.",
};

const errResult = (status: number, code: AgentErrorCode): RouteResult => ({
  status,
  body: { error: { code, message: SAFE_MESSAGES[code] } },
});

const routeGroups = [
  ...createGitDeliveryLocalMutationRouteGroup(),
  ...createGitDeliveryCommitRouteGroup(),
  ...createGitDeliveryPushRouteGroup(),
  ...createGitDeliveryPrRouteGroup(),
  ...createGitDeliveryMergeRouteGroup(),
  ...createGitDeliverySyncRouteGroup(),
] as const;

const idempotencyCache = new Map<
  string,
  { readonly fingerprint: string; readonly result: GitRepositoryAgentOperationResponse }
>();

function denied(
  request: Partial<GitRepositoryAgentOperationRequest>,
  denialReason: GitRepositoryAgentDenialReason,
  message: string,
): GitRepositoryAgentOperationResponse {
  return {
    schemaVersion: GIT_REPOSITORY_AGENT_SCHEMA_VERSION,
    ...(request.operation === undefined ? {} : { operation: request.operation }),
    ...(request.mode === undefined ? {} : { mode: request.mode }),
    status: "denied",
    denialReason,
    message,
  };
}

async function readParsed(req: IncomingMessage): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly result: RouteResult }
> {
  let raw: string;
  try {
    raw = await readGitDeliveryBody(req);
  } catch (error) {
    if (error instanceof GitDeliveryBodyTooLargeError) {
      return { ok: false, result: errResult(413, "GIT_AGENT_OPERATION_PAYLOAD_TOO_LARGE") };
    }
    return { ok: false, result: errResult(400, "GIT_AGENT_OPERATION_BAD_REQUEST") };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, result: errResult(400, "GIT_AGENT_OPERATION_BAD_REQUEST") };
  }
}

function makeRequest(body: unknown, base: IncomingMessage): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { ...base.headers, "content-type": "application/json" };
  return req;
}

function postContext(ctx: RouteContext, pattern: string, body: unknown): RouteContext {
  return {
    req: makeRequest(body, ctx.req),
    res: ctx.res,
    params: {},
    url: new URL(`http://127.0.0.1${pattern}`),
  };
}

function readContext(ctx: RouteContext, path: string): RouteContext {
  return {
    req: Readable.from([]) as IncomingMessage,
    res: ctx.res,
    params: {},
    url: new URL(`http://127.0.0.1${path}`),
  };
}

function queryFor(
  path: string,
  entries: readonly (readonly [string, string | undefined])[],
): string {
  const url = new URL(`http://127.0.0.1${path}`);
  for (const [key, value] of entries) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}`;
}

const READ_PAYLOAD_KEYS: Readonly<Record<"status" | "diff" | "branch-list", ReadonlySet<string>>> =
  {
    status: new Set(),
    diff: new Set(["path", "scope"]),
    "branch-list": new Set(),
  };

function payloadOrEmpty(
  request: GitRepositoryAgentOperationRequest,
): Readonly<Record<string, unknown>> {
  return request.payload ?? {};
}

function validatePayloadKeys(
  request: GitRepositoryAgentOperationRequest,
  allowed: ReadonlySet<string>,
): RouteResult | undefined {
  const payload = payloadOrEmpty(request);
  if (!hasOnlyAllowedKeys(payload, allowed)) {
    return errResult(400, "GIT_AGENT_OPERATION_BAD_REQUEST");
  }
  return undefined;
}

async function delegateRead(
  request: GitRepositoryAgentOperationRequest,
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<DelegatedResult> {
  if (
    request.operation !== "status" &&
    request.operation !== "diff" &&
    request.operation !== "branch-list"
  ) {
    return errResult(400, "GIT_AGENT_OPERATION_BAD_REQUEST");
  }
  const keyError = validatePayloadKeys(request, READ_PAYLOAD_KEYS[request.operation]);
  if (keyError !== undefined) return keyError;
  const payload = payloadOrEmpty(request);
  if (request.operation === "status") {
    return handleGitStatus(
      readContext(ctx, queryFor("/api/git/status", [["root", request.projectId]])),
      deps,
      deps.gitRouteOptions,
    );
  }
  if (request.operation === "branch-list") {
    return handleGitBranches(
      readContext(ctx, queryFor("/api/git/branches", [["root", request.projectId]])),
      deps,
      deps.gitRouteOptions,
    );
  }
  return handleGitDiff(
    readContext(
      ctx,
      queryFor("/api/git/diff", [
        ["root", request.projectId],
        ["path", typeof payload.path === "string" ? payload.path : undefined],
        ["scope", typeof payload.scope === "string" ? payload.scope : undefined],
      ]),
    ),
    deps,
    deps.gitRouteOptions,
  );
}

const WRITE_KEYS: Readonly<Record<GitRepositoryAgentOperationKind, ReadonlySet<string>>> = {
  status: new Set(),
  diff: new Set(),
  "branch-list": new Set(),
  "branch-create": new Set(["branchName", "baseBranchName", "startPointRefHash"]),
  "branch-switch": new Set(["branchName"]),
  stage: new Set(["pathspecs", "includeUntracked"]),
  unstage: new Set(["pathspecs"]),
  commit: new Set(["messageDraft", "message", "allowEmpty"]),
  fetch: new Set(["remote"]),
  pull: new Set(["remote"]),
  push: new Set([
    "remoteAlias",
    "remoteBranchName",
    "sourceBranchName",
    "forcePush",
    "setUpstreamTracking",
  ]),
  "pull-request": new Set([
    "kind",
    "ownerAndRepo",
    "headBranchName",
    "baseBranchName",
    "title",
    "description",
    "isDraft",
    "prExternalId",
    "convertToDraft",
    "convertFromDraft",
  ]),
  merge: new Set([
    "kind",
    "ownerAndRepo",
    "prExternalId",
    "baseBranchName",
    "headBranchName",
    "mergeStrategy",
    "deleteBranchAfterMerge",
    "expectedHeadRefHash",
  ]),
};

const STATIC_WRITE_PATTERNS: Readonly<Partial<Record<GitRepositoryAgentOperationKind, string>>> = {
  "branch-create": "/api/git-delivery/local-branch/create",
  "branch-switch": "/api/git-delivery/local-branch/switch",
  stage: "/api/git-delivery/staging/stage",
  unstage: "/api/git-delivery/staging/unstage",
};

const PHASED_WRITE_PATTERNS: Readonly<Partial<Record<GitRepositoryAgentOperationKind, string>>> = {
  commit: "/api/git-delivery/commit",
  fetch: "/api/git-delivery/fetch",
  pull: "/api/git-delivery/pull",
  push: "/api/git-delivery/push",
  "pull-request": "/api/git-delivery/pr",
  merge: "/api/git-delivery/merge",
};

function delegatedPattern(request: GitRepositoryAgentOperationRequest): string | undefined {
  const staticPattern = STATIC_WRITE_PATTERNS[request.operation];
  if (staticPattern !== undefined) return staticPattern;
  const phasedPrefix = PHASED_WRITE_PATTERNS[request.operation];
  return phasedPrefix === undefined ? undefined : `${phasedPrefix}/${request.mode}`;
}

function delegatedBody(request: GitRepositoryAgentOperationRequest): Record<string, unknown> {
  const payload = payloadOrEmpty(request);
  const body: Record<string, unknown> = {
    schemaVersion: "1",
    projectId: request.projectId,
    ...payload,
  };
  if (request.operation === "pull-request") {
    body.body = typeof payload.description === "string" ? payload.description : "";
    delete body.description;
  }
  if (request.operation === "merge") {
    body.kind = "merge";
  }
  return body;
}

async function delegateWrite(
  request: GitRepositoryAgentOperationRequest,
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<DelegatedResult> {
  const keyError = validatePayloadKeys(request, WRITE_KEYS[request.operation]);
  if (keyError !== undefined) return keyError;
  const pattern = delegatedPattern(request);
  if (pattern === undefined) return errResult(400, "GIT_AGENT_OPERATION_UNSUPPORTED");
  const route = routeGroups.find((candidate) => candidate.pattern === pattern);
  if (route === undefined) return errResult(400, "GIT_AGENT_OPERATION_UNSUPPORTED");
  const body = delegatedBody(request);
  const outcome = await route.handler(postContext(ctx, pattern, body), deps);
  return outcome === STREAMING ? errResult(400, "GIT_AGENT_OPERATION_UNSUPPORTED") : outcome;
}

function wrapDelegated(
  request: GitRepositoryAgentOperationRequest,
  result: RouteResult,
  replay = false,
): GitRepositoryAgentOperationResponse {
  return {
    schemaVersion: GIT_REPOSITORY_AGENT_SCHEMA_VERSION,
    operation: request.operation,
    mode: request.mode,
    status: "delegated",
    routeStatus: result.status,
    ...(replay ? { replay: true } : {}),
    response: result.body,
  };
}

function cacheKey(request: GitRepositoryAgentOperationRequest): string | undefined {
  if (request.mode !== "execute" || request.idempotencyKey === undefined) return undefined;
  return `${request.projectId}\0${request.idempotencyKey}`;
}

function deniedStatus(reason: GitRepositoryAgentDenialReason): number {
  return reason === "unsupported-direct-shell" ? 200 : 400;
}

async function parseAgentRequest(
  req: IncomingMessage,
): Promise<
  | {
      readonly ok: true;
      readonly request: GitRepositoryAgentOperationRequest;
      readonly fingerprint: string;
    }
  | { readonly ok: false; readonly result: RouteResult }
> {
  const read = await readParsed(req);
  if (!read.ok) return read;
  const parsed = parseGitRepositoryAgentOperationRequest(read.value);
  if (!parsed.ok) {
    return {
      ok: false,
      result: {
        status: deniedStatus(parsed.denialReason),
        body: denied({}, parsed.denialReason, parsed.message),
      },
    };
  }
  if (scanForbiddenStrings(read.value)) {
    return { ok: false, result: errResult(400, "GIT_AGENT_OPERATION_FORBIDDEN_PAYLOAD") };
  }
  if (scanUnsafeFormatChars(read.value) || !isPlainObject(read.value)) {
    return { ok: false, result: errResult(400, "GIT_AGENT_OPERATION_BAD_REQUEST") };
  }
  return { ok: true, request: parsed.value, fingerprint: JSON.stringify(read.value) };
}

function replayResult(
  request: GitRepositoryAgentOperationRequest,
  fingerprint: string,
): RouteResult | undefined {
  const key = cacheKey(request);
  if (key === undefined) return undefined;
  const cached = idempotencyCache.get(key);
  if (cached === undefined) return undefined;
  if (cached.fingerprint !== fingerprint) {
    return {
      status: 409,
      body: denied(
        request,
        "idempotency-conflict",
        "The idempotencyKey was already used for a different repository operation.",
      ),
    };
  }
  const body =
    cached.result.status === "delegated" ? { ...cached.result, replay: true } : cached.result;
  return {
    status: cached.result.status === "delegated" ? cached.result.routeStatus : 200,
    body,
  };
}

function rememberResult(
  request: GitRepositoryAgentOperationRequest,
  fingerprint: string,
  body: GitRepositoryAgentOperationResponse,
): void {
  const key = cacheKey(request);
  if (key !== undefined) idempotencyCache.set(key, { fingerprint, result: body });
}

async function delegateRequest(
  request: GitRepositoryAgentOperationRequest,
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return request.mode === "read"
    ? delegateRead(request, ctx, deps)
    : delegateWrite(request, ctx, deps);
}

export async function handleGitAgentOperation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const parsed = await parseAgentRequest(ctx.req);
  if (!parsed.ok) return parsed.result;
  const replay = replayResult(parsed.request, parsed.fingerprint);
  if (replay !== undefined) return replay;
  const result = await delegateRequest(parsed.request, ctx, deps);
  const body = wrapDelegated(parsed.request, result);
  rememberResult(parsed.request, parsed.fingerprint, body);
  return { status: result.status, body };
}

export const GIT_AGENT_OPERATION_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/git/agent/operations",
    handler: handleGitAgentOperation,
  },
];
