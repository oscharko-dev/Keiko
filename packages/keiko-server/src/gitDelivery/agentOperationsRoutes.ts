// Typed repository-operation facade for agents (Issue #1577, Epic #1571).
//
// This is an admission and dispatch layer only. It accepts a closed semantic operation envelope,
// rejects shell/provider-shaped input before delegation, and forwards to existing Git read /
// git-delivery route handlers. It does not import or create any new Git, gh, terminal, or provider
// adapter authority.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type {
  CodingWorkbenchMode,
  GitRepositoryAgentDenialReason,
  GitRepositoryAgentOperationKind,
  GitRepositoryAgentOperationRequest,
  GitRepositoryAgentOperationResponse,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_REPOSITORY_AGENT_SCHEMA_VERSION,
  parseGitRepositoryAgentOperationRequest,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository-agent";
import { resolveEffectiveCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import { STREAMING } from "../route-outcome.js";
import { handleGitBranches, handleGitDiff, handleGitStatus } from "../gitRoutes.js";
import type { UiHandlerDeps } from "../deps.js";
import { createGitDeliveryCommitRouteGroup } from "./commitRoutes.js";
import { createGitDeliveryLocalMutationRouteGroup } from "./localMutationRoutes.js";
import { createGitDeliveryMergeRouteGroup } from "./mergeRoutes.js";
import { createGitDeliveryPrRouteGroup } from "./prRoutes.js";
import { createGitDeliveryPushRouteGroup } from "./pushRoutes.js";
import { createGitDeliverySyncRouteGroup } from "./syncRoutes.js";
import { resolveProjectWorkspace } from "./execution.js";
import { gitDeliveryAuthorityDenial, logGitDeliveryAuthorityDenial } from "./requestPreparation.js";
import {
  hasOnlyAllowedKeys,
  isPlainObject,
  readParsedGitDeliveryBody,
  scanForbiddenStrings,
  scanUnsafeFormatChars,
  type GitDeliveryParsedBody,
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

interface IdempotencyEntry {
  readonly fingerprint: string;
  readonly pending?: Promise<GitRepositoryAgentOperationResponse>;
  readonly result?: GitRepositoryAgentOperationResponse;
}

// Defaults for the process-memory idempotency cache. The cap bounds worst-case memory against a client
// that streams many distinct idempotency keys; the TTL lets settled replay entries self-evict so the
// map self-cleans even for keys that are never queried again.
export const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 1024;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

export interface IdempotencyCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

interface StoredEntry {
  readonly entry: IdempotencyEntry;
  // Wall-clock expiry, enforced only once the entry holds a settled result. A pending reservation is a
  // short-lived guard for an in-flight delegation; it is never TTL-pruned or LRU-evicted so a duplicate
  // request can never re-trigger an operation that is still running (idempotency is preserved exactly).
  readonly expiresAt: number;
}

// Bounded LRU + TTL store for the agent-facade idempotency replay window. Exposes the Map subset the
// handler relies on (get / set / delete) plus `size` for tests. Overflow eviction targets the
// least-recently-used *settled* entry only; in-flight reservations are exempt.
export class IdempotencyCache {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  public constructor(options: IdempotencyCacheOptions = {}) {
    this.maxEntries = Math.max(
      1,
      Math.floor(options.maxEntries ?? DEFAULT_IDEMPOTENCY_MAX_ENTRIES),
    );
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS));
    this.now = options.now ?? Date.now;
  }

  public get size(): number {
    return this.entries.size;
  }

  public get(key: string): IdempotencyEntry | undefined {
    const stored = this.entries.get(key);
    if (stored === undefined) return undefined;
    if (stored.entry.result !== undefined && this.now() >= stored.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh LRU recency on a hit by reinserting at the tail; the TTL window is unchanged.
    this.entries.delete(key);
    this.entries.set(key, stored);
    return stored.entry;
  }

  public set(key: string, entry: IdempotencyEntry): void {
    this.entries.delete(key);
    this.pruneExpired();
    this.entries.set(key, { entry, expiresAt: this.now() + this.ttlMs });
    this.evictOverflow();
  }

  public delete(key: string): void {
    this.entries.delete(key);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, stored] of this.entries) {
      if (stored.entry.result !== undefined && now >= stored.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      let victim: string | undefined;
      for (const [key, stored] of this.entries) {
        if (stored.entry.pending === undefined) {
          victim = key;
          break;
        }
      }
      if (victim === undefined) break; // every entry is an in-flight reservation — cannot safely evict
      this.entries.delete(victim);
    }
  }
}

const idempotencyCache = new IdempotencyCache();

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

const readParsed = (req: IncomingMessage): Promise<GitDeliveryParsedBody<RouteResult>> =>
  readParsedGitDeliveryBody(
    req,
    () => errResult(413, "GIT_AGENT_OPERATION_PAYLOAD_TOO_LARGE"),
    () => errResult(400, "GIT_AGENT_OPERATION_BAD_REQUEST"),
  );

function makeRequest(body: unknown, base: IncomingMessage): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { ...base.headers, "content-type": "application/json" };
  return req;
}

// Both context builders below synthesize a fresh RouteContext for an internally-delegated route
// handler (F2: the agent facade continues the SAME request into commit/push/pr/merge/local-mutation
// or the plain git read routes — it is not spawning background work, it AWAITS and wraps the result
// before this request's own response is produced). The delegated handler reads `ctx.correlationId` as
// its first line, so dropping it here silently downgrades every line the delegated operation logs to
// UNKNOWN_CORRELATION_ID even though the real id is sitting in the enclosing `ctx` the whole time
// (AGENTS.md §8). Threading it keeps the delegated evidence joinable to the originating request.
function postContext(ctx: RouteContext, pattern: string, body: unknown): RouteContext {
  return {
    req: makeRequest(body, ctx.req),
    res: ctx.res,
    params: {},
    url: new URL(`http://127.0.0.1${pattern}`),
    correlationId: ctx.correlationId,
  };
}

function readContext(ctx: RouteContext, path: string): RouteContext {
  return {
    req: Readable.from([]) as IncomingMessage,
    res: ctx.res,
    params: {},
    url: new URL(`http://127.0.0.1${path}`),
    correlationId: ctx.correlationId,
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
  // "approval" (final-audit F1+F2/#3390): forwarded verbatim to the delegated route, which is the
  // ONLY place that ever parses/consumes it (`delegatedBody` spreads `...payload` unchanged) — this
  // facade never reads it. Allows a caller holding a claim minted directly through the delegated
  // route's own `/approve` endpoint to redeem it via this facade too, exactly as if it had called
  // the delegated route directly. Omitted for `commit` (redirected to the verified runtime commit
  // service above) and `fetch`/`pull` (no mint route exists for either yet).
  "branch-create": new Set(["branchName", "baseBranchName", "startPointRefHash", "approval"]),
  "branch-switch": new Set(["branchName", "approval"]),
  stage: new Set(["pathspecs", "includeUntracked", "approval"]),
  unstage: new Set(["pathspecs", "approval"]),
  commit: new Set(["messageDraft", "message", "allowEmpty"]),
  fetch: new Set(["remote"]),
  pull: new Set(["remote"]),
  push: new Set([
    "remoteAlias",
    "remoteBranchName",
    "sourceBranchName",
    "forcePush",
    "setUpstreamTracking",
    "approval",
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
    "approval",
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
    "approval",
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

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizedForDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedForDigest);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => [key, normalizedForDigest(value[key])]),
  );
}

function fingerprintRequest(request: GitRepositoryAgentOperationRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedForDigest(request)))
    .digest("hex");
}

function deniedStatus(reason: GitRepositoryAgentDenialReason): number {
  if (reason === "unsupported-direct-shell") return 200;
  return reason === "autonomy-mode-denied" ? 403 : 400;
}

// The server-owned product-wide autonomy ceiling (ADR-0129). Undefined fails closed to the narrowest
// posture: an operator who has configured nothing has accepted nothing, so an agent gets reads only.
// This is the same resolution the coding-runtime, coding-context, editor-agent and Atlassian action
// surfaces use — one ceiling for the product, not a second one for Git.
export function gitAgentEffectiveMode(
  deps: Pick<UiHandlerDeps, "codingRuntimeDeploymentCeiling">,
): CodingWorkbenchMode {
  const ceiling = deps.codingRuntimeDeploymentCeiling ?? "governed-assist";
  return resolveEffectiveCodingWorkbenchMode(ceiling, ceiling);
}

async function parseAgentRequest(req: IncomingMessage): Promise<
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
  return { ok: true, request: parsed.value, fingerprint: fingerprintRequest(parsed.value) };
}

function idempotencyConflict(request: GitRepositoryAgentOperationRequest): RouteResult {
  return {
    status: 409,
    body: denied(
      request,
      "idempotency-conflict",
      "The idempotencyKey was already used for a different repository operation.",
    ),
  };
}

function responseResult(body: GitRepositoryAgentOperationResponse, replay = false): RouteResult {
  const response = body.status === "delegated" && replay ? { ...body, replay: true } : body;
  return {
    status: body.status === "delegated" ? body.routeStatus : 200,
    body: response,
  };
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

export async function handleGitAgentOperationWithDelegate(
  request: GitRepositoryAgentOperationRequest,
  fingerprint: string,
  delegate: () => Promise<RouteResult>,
  cache: IdempotencyCache = idempotencyCache,
): Promise<RouteResult> {
  const key = cacheKey(request);
  if (key === undefined) {
    const result = await delegate();
    return { status: result.status, body: wrapDelegated(request, result) };
  }
  const cached = cache.get(key);
  if (cached !== undefined) {
    if (cached.fingerprint !== fingerprint) return idempotencyConflict(request);
    if (cached.result !== undefined) return responseResult(cached.result, true);
    if (cached.pending !== undefined) return responseResult(await cached.pending, true);
  }
  const pending = delegate().then((result) => wrapDelegated(request, result));
  cache.set(key, { fingerprint, pending });
  try {
    const body = await pending;
    cache.set(key, { fingerprint, result: body });
    return responseResult(body);
  } catch (error) {
    const current = cache.get(key);
    if (current?.pending === pending) cache.delete(key);
    throw error;
  }
}

function verifiedCommitRequired(
  ctx: RouteContext,
  request: GitRepositoryAgentOperationRequest,
): RouteResult {
  logGitDeliveryAuthorityDenial(ctx, "commit", "verified-commit-required");
  return {
    status: 403,
    body: denied(
      request,
      "autonomy-mode-denied",
      "Agent commits require the verified runtime commit proposal and its one-use approval.",
    ),
  };
}

export async function handleGitAgentOperation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const parsed = await parseAgentRequest(ctx.req);
  if (!parsed.ok) return parsed.result;
  // This server-owned route identifies delegated agent work. A run id or client payload cannot
  // turn the manual Git client into the exact-tree, one-use approved runtime commit service.
  if (parsed.request.operation === "commit" && parsed.request.mode === "execute") {
    return verifiedCommitRequired(ctx, parsed.request);
  }
  if (parsed.request.mode === "execute") {
    const workspace = resolveProjectWorkspace(deps, parsed.request.projectId);
    if (workspace === undefined) {
      logGitDeliveryAuthorityDenial(ctx, parsed.request.operation, "workspace-unresolvable");
      return {
        status: 403,
        body: denied(
          parsed.request,
          "autonomy-mode-denied",
          "The accepted runtime authority does not admit this repository operation.",
        ),
      };
    }
    // Final-audit F1+F2/#3390 (ADR-0138 D2): this is a pre-check ahead of delegation, not the final
    // authority — every op below delegates to the SAME route handler that independently re-runs
    // `gitDeliveryAuthorityGate`/`gitDeliveryAuthorityDenial` with the correct per-operation
    // redemption (deferred for delivery ops, peeked against the forwarded `approval` for local
    // mutations). Deferring uniformly here is therefore safe: it never widens what the delegated
    // handler itself admits, and avoids re-deriving that same per-operation distinction twice.
    const gate = gitDeliveryAuthorityDenial(
      ctx,
      deps,
      parsed.request.projectId,
      workspace,
      parsed.request.operation,
      {},
      { deliveryApprovalDeferred: true },
    );
    if (gate !== undefined) {
      return {
        status: gate.status,
        body: denied(
          parsed.request,
          "autonomy-mode-denied",
          "The accepted runtime authority does not admit this repository operation.",
        ),
      };
    }
  }
  return handleGitAgentOperationWithDelegate(parsed.request, parsed.fingerprint, () =>
    delegateRequest(parsed.request, ctx, deps),
  );
}

export const GIT_AGENT_OPERATION_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/git/agent/operations",
    handler: handleGitAgentOperation,
  },
];
