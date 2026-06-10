// Issue #539 (Epic #532) — relationship engine HTTP handlers for the BFF.
//
// 11 routes per docs/relationship-engine/api-contract.md §2:
//
//   1.  POST   /api/relationships/validate
//   2.  POST   /api/relationships
//   3.  GET    /api/relationships
//   4.  GET    /api/relationships/:id
//   5.  PATCH  /api/relationships/:id
//   6.  DELETE /api/relationships/:id
//   7.  GET    /api/relationships/:id/dependencies
//   8.  GET    /api/relationships/impact
//   9.  GET    /api/relationships/:id/explain
//   10. GET    /api/relationships/health
//   11. GET    /api/relationships/events  (SSE stub; #541 wires per-kind delivery)
//
// Composition rules (security-checklist.md, audit-events.md, storage.md):
//   • workspace scope is resolved by `deps.relationship.scopeResolver(req)` and applied to
//     every read and write. The store layer also enforces the scope at the SQL barrier
//     (storage.md §3.3). No unscoped path exists.
//   • the pure validator from @oscharko-dev/keiko-contracts runs BEFORE persistence on
//     every mutation route (storage.md §4).
//   • every response payload is run through the live redactor at the SINGLE call site
//     `respond()` below (api-contract.md §8 / audit-events.md §7).
//   • idempotency replay store is process-local LRU `Map<string, IdempotencyRecord>`
//     bounded to 1024 entries with TTL 10 min; oldest-key eviction. The single Map lives
//     in module scope so test fixtures can spy via the public seam if needed in #543.
//
// This file deliberately avoids new abstractions: no router, no DI container, no parser
// framework — just `node:http` IncomingMessage + the existing readJsonObject pattern from
// store-handlers.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  Relationship,
  RelationshipCardinalityCounts,
  RelationshipLifecycleState,
  RelationshipObjectKind,
  RelationshipType,
  RelationshipValidationError,
  RelationshipValidationContext,
} from "@oscharko-dev/keiko-contracts";
import {
  RELATIONSHIP_TYPE_DEFINITIONS,
  RELATIONSHIP_LIFECYCLE_STATES,
  RELATIONSHIP_OBJECT_KINDS,
  RELATIONSHIP_SCHEMA_VERSION,
  RELATIONSHIP_TYPES,
  validateRelationship,
} from "@oscharko-dev/keiko-contracts";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody, STREAMING } from "./routes.js";
import type { UiHandlerDeps, Redactor } from "./deps.js";
import type { RunRecord } from "./runs.js";
import {
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_IMPACT_DEPTH,
  DEFAULT_IMPACT_DEPTH,
  MAX_IMPACT_NODES,
  DEFAULT_IMPACT_NODES,
  MAX_IMPACT_RELATIONSHIPS,
  DEFAULT_IMPACT_RELATIONSHIPS,
  type DependencyWalkResult,
  type RelationshipHealthFindings,
  type RelationshipScope,
  type StoredRelationship,
} from "./store/relationships.js";
import type {
  RelationshipAuditEntryRow,
  RelationshipAuditKind,
} from "./store/relationship-audit.js";
import { UiStoreError } from "./store/errors.js";
import { SSE_HEADERS } from "./sse.js";

// ─── Port shapes (#540-#542 will reuse these) ─────────────────────────────────
export type RelationshipScopeResolver = (
  req: IncomingMessage,
) => { readonly workspaceId: string } | undefined;

// A workspace-scoped facade over the store + audit modules. The BFF wiring composes the
// real SQLite DB into this interface inside `deps.ts`; tests inject a fake. We use a port
// rather than passing `DatabaseSync` so the handlers stay decoupled from node:sqlite.
export interface RelationshipStore {
  createRelationship(input: CreateRelationshipInput): {
    readonly relationship: StoredRelationship;
    readonly etag: string;
  };
  getRelationship(workspaceId: string, id: string): StoredRelationship | undefined;
  getEtag(workspaceId: string, id: string): string | undefined;
  listRelationships(query: ListQuery): ListResult;
  updateLifecycle(args: UpdateLifecycleInput): {
    readonly relationship: StoredRelationship;
    readonly etag: string;
  };
  reconnect(args: ReconnectInput): {
    readonly relationship: StoredRelationship;
    readonly etag: string;
  };
  walkDependencies(args: WalkArgs): DependencyWalkResult;
  computeImpact(args: ImpactArgs): DependencyWalkResult;
  graphHealth(workspaceId: string): GraphHealth;
  lifecycleHistory(workspaceId: string, id: string): readonly LifecycleHistoryRow[];
  recordAuditEntry(input: AuditEntryInput): RelationshipAuditEntryRow;
}

export interface CreateRelationshipInput {
  readonly workspaceId: string;
  readonly scope: RelationshipScope;
  readonly type: RelationshipType;
  readonly source: {
    readonly kind: RelationshipObjectKind;
    readonly id: string;
  };
  readonly target: {
    readonly kind: RelationshipObjectKind;
    readonly id: string;
  };
  readonly lifecycleState: RelationshipLifecycleState;
  readonly confidence?: number | undefined;
  readonly summary?: string | undefined;
}

export interface ListQuery {
  readonly workspaceId: string;
  readonly sourceKind?: RelationshipObjectKind | undefined;
  readonly sourceId?: string | undefined;
  readonly targetKind?: RelationshipObjectKind | undefined;
  readonly targetId?: string | undefined;
  readonly type?: RelationshipType | undefined;
  readonly lifecycle?: RelationshipLifecycleState | undefined;
  readonly limit: number;
}

export interface ListResult {
  readonly entries: readonly StoredRelationship[];
  readonly truncated: boolean;
  readonly nextCursor: string | undefined;
}

export interface UpdateLifecycleInput {
  readonly workspaceId: string;
  readonly id: string;
  readonly currentEtag: string;
  readonly to: RelationshipLifecycleState;
  readonly summary?: string | undefined;
}

export interface ReconnectInput {
  readonly workspaceId: string;
  readonly id: string;
  readonly currentEtag: string;
  readonly target: { readonly kind: RelationshipObjectKind; readonly id: string };
  readonly summary?: string | undefined;
}

export interface WalkArgs {
  readonly workspaceId: string;
  readonly originId: string;
  readonly direction: "outgoing" | "incoming" | "both";
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxRelationships: number;
}

export interface ImpactArgs {
  readonly workspaceId: string;
  readonly endpoint: { readonly kind: RelationshipObjectKind; readonly id: string };
  readonly direction: "outgoing" | "incoming" | "both";
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxRelationships: number;
}

export interface GraphHealth {
  readonly checkedAt: number;
  readonly totals: Readonly<Record<RelationshipLifecycleState, number>>;
  readonly truncated: boolean;
  readonly findings: RelationshipHealthFindings;
}

export interface LifecycleHistoryRow {
  readonly fromState: RelationshipLifecycleState;
  readonly toState: RelationshipLifecycleState;
  readonly occurredAt: number;
  readonly summary?: string | undefined;
}

export interface AuditEntryInput {
  readonly workspaceId: string;
  readonly kind: RelationshipAuditKind;
  readonly relationshipId?: string | undefined;
  readonly actor: {
    readonly surface: "system" | "inspector" | "chat";
    readonly redactedActorId: string;
  };
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RelationshipHandlerDeps {
  readonly scopeResolver: RelationshipScopeResolver;
  readonly store: RelationshipStore;
}

interface RelationshipActivitySnapshot {
  readonly kind: "relationship:activity";
  readonly id: string;
  readonly state:
    | "inactive"
    | "queued"
    | "active"
    | "processing"
    | "completed"
    | "failed"
    | "blocked"
    | "degraded"
    | "high-throughput";
  readonly timestamp: number;
  readonly count?: number | undefined;
}

// ─── Idempotency LRU (api-contract.md §5) ─────────────────────────────────────
interface IdempotencyRecord {
  readonly bodyHash: string;
  readonly status: number;
  readonly response: unknown;
  readonly expiresAt: number;
}

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 1024;
const idempotencyStore = new Map<string, IdempotencyRecord>();

function idempotencyKey(workspaceId: string, route: string, key: string): string {
  return `${workspaceId} ${route} ${key}`;
}

function pruneExpiredIdempotency(now: number): void {
  for (const [k, v] of idempotencyStore) {
    if (v.expiresAt <= now) idempotencyStore.delete(k);
  }
}

function recordIdempotency(key: string, record: IdempotencyRecord): void {
  idempotencyStore.set(key, record);
  while (idempotencyStore.size > IDEMPOTENCY_MAX_ENTRIES) {
    const first = idempotencyStore.keys().next();
    if (first.done) break;
    idempotencyStore.delete(first.value);
  }
}

// Test seam: not exported via index.ts; called from the handler test fixture.
export function _resetIdempotencyStoreForTests(): void {
  idempotencyStore.clear();
}

function hashBody(raw: string): string {
  // Cheap, deterministic, non-cryptographic content hash for the LRU key. Cryptographic
  // strength is not required (key collisions only affect replay detection; the cache miss
  // path executes the mutation normally). Using djb2 over a fixed-length raw string.
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = (h * 33 + raw.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

// ─── Body + header helpers ────────────────────────────────────────────────────
const MAX_BODY_BYTES = 16 * 1024;
const ACTIVITY_WINDOW_MS = 60_000;
const ACTIVITY_HIGH_THROUGHPUT_THRESHOLD = 50;
const ACTIVITY_SSE_REFRESH_MS = 5_000;
// EventSource reconnect backoff advertised in the initial `retry:` directive (SSE spec). Matches
// the refresh cadence so a dropped stream re-establishes on roughly the same beat.
const ACTIVITY_SSE_RETRY_MS = 5_000;
const ACTIVITY_MAX_RUNS = 64;

const RUN_PROCESSING_EVENT_TYPES = new Set([
  "tool:call:started",
  "command:executed",
  "patch:applied",
]);
const RUN_ACTIVE_EVENT_TYPES = new Set(["model:call:started", "workflow:model:call:started"]);

class HandlerError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HandlerError";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          rejectBody(
            new HandlerError(413, "relationship/payload-too-large", "Body exceeds 16 KiB."),
          );
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", rejectBody);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<{
  readonly raw: string;
  readonly value: Record<string, unknown>;
}> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HandlerError(400, "relationship/bad-request", "Body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerError(400, "relationship/bad-request", "Body must be a JSON object.");
  }
  return { raw, value: parsed as Record<string, unknown> };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return undefined;
}

const IDEMPOTENCY_HEADER_RE = /^[A-Za-z0-9._-]{8,64}$/;

// api-contract.md §3.2 and security-checklist.md §10.2 — RelationshipId on the wire is bounded
// to `[A-Za-z0-9._-]{8,128}`. Issue #539 audit caught that the shipped `/:id` routes bound the
// URL parameter directly into SQL and the audit ledger without enforcing the regex, so a
// pathological caller could push a 50 KB string through the prepared-statement path. Every
// route that reads `ctx.params.id` MUST call this helper before the store query and before any
// audit payload that records the id.
const RELATIONSHIP_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

function requireRelationshipId(raw: string | undefined): string {
  if (raw === undefined || !RELATIONSHIP_ID_RE.test(raw)) {
    throw new HandlerError(
      400,
      "relationship/bad-request",
      "Relationship id must match the wire schema.",
    );
  }
  return raw;
}

function requireIdempotencyKey(req: IncomingMessage): string {
  const value = header(req, "idempotency-key");
  if (value === undefined || !IDEMPOTENCY_HEADER_RE.test(value)) {
    throw new HandlerError(
      400,
      "relationship/idempotency-key-required",
      "Idempotency-Key header is required.",
    );
  }
  return value;
}

function requireIfMatch(req: IncomingMessage): string {
  const value = header(req, "if-match");
  if (value === undefined || value.length === 0) {
    throw new HandlerError(
      428,
      "relationship/optimistic-concurrency-required",
      "If-Match header is required.",
    );
  }
  return value.replace(/^"(.*)"$/, "$1");
}

function scope(req: IncomingMessage, deps: RelationshipHandlerDeps): string {
  const resolved = deps.scopeResolver(req);
  if (resolved === undefined || resolved.workspaceId.length === 0) {
    throw new HandlerError(
      403,
      "relationship/scope-not-permitted",
      "Workspace scope unavailable for this caller.",
    );
  }
  return resolved.workspaceId;
}

function scopeFromEventsRequest(
  req: IncomingMessage,
  url: URL,
  deps: RelationshipHandlerDeps,
): string {
  const workspaceId = scope(req, deps);
  const requestedWorkspaceId = url.searchParams.get("workspaceId");
  if (requestedWorkspaceId !== null && requestedWorkspaceId !== workspaceId) {
    throw new HandlerError(
      403,
      "relationship/sse-not-permitted",
      "Workspace scope unavailable for this caller.",
    );
  }
  return workspaceId;
}

// ─── Response builder (the single redactor call site) ─────────────────────────
function respond(redactor: Redactor, status: number, body: unknown, etag?: string): RouteResult {
  // api-contract.md §8: every response body crosses the redactor at one site. Etag is
  // emitted via the JSON envelope; the server layer copies headers from a small `_headers`
  // marker if present. We keep the contract simple here and surface the etag inside the
  // body (clients read `body.relationship.etag` and `body.etag`).
  const redacted = redactor(body) ?? body;
  if (etag !== undefined && typeof redacted === "object" && redacted !== null) {
    return { status, body: { ...(redacted as Record<string, unknown>), etag } };
  }
  return { status, body: redacted };
}

function errorResult(redactor: Redactor, err: HandlerError): RouteResult {
  return respond(redactor, err.status, errorBody(err.code, err.message));
}

function handlerErrorFromStore(error: UiStoreError): HandlerError {
  if (error.status === 404) {
    return new HandlerError(404, "relationship/not-found", "Relationship not found.");
  }
  if (error.status === 409) {
    return new HandlerError(
      422,
      "relationship/policy-denied",
      "Cardinality or uniqueness constraint denied the write.",
    );
  }
  return new HandlerError(400, "relationship/bad-request", error.message);
}

// ─── Parsers ──────────────────────────────────────────────────────────────────
function parseRelationshipType(raw: unknown): RelationshipType {
  if (typeof raw !== "string" || !(RELATIONSHIP_TYPES as readonly string[]).includes(raw)) {
    throw new HandlerError(400, "relationship/bad-request", "Unknown relationship type.");
  }
  return raw as RelationshipType;
}

function parseEndpointKind(raw: unknown): RelationshipObjectKind {
  if (typeof raw !== "string" || !(RELATIONSHIP_OBJECT_KINDS as readonly string[]).includes(raw)) {
    throw new HandlerError(400, "relationship/bad-request", "Unknown endpoint kind.");
  }
  return raw as RelationshipObjectKind;
}

function parseLifecycleState(raw: unknown): RelationshipLifecycleState {
  if (
    typeof raw !== "string" ||
    !(RELATIONSHIP_LIFECYCLE_STATES as readonly string[]).includes(raw)
  ) {
    throw new HandlerError(400, "relationship/bad-request", "Unknown lifecycle state.");
  }
  return raw as RelationshipLifecycleState;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HandlerError(400, "relationship/bad-request", `Field "${field}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const v = record[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new HandlerError(400, "relationship/bad-request", `Field "${field}" is required.`);
  }
  return v;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const v = record[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new HandlerError(400, "relationship/bad-request", `Field "${field}" must be a string.`);
  }
  return v;
}

function clampBoundedInt(
  raw: string | null,
  defaultValue: number,
  max: number,
  fieldName: string,
): number {
  if (raw === null) return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HandlerError(400, "relationship/bad-request", `Query "${fieldName}" must be > 0.`);
  }
  if (n > max) {
    throw new HandlerError(
      400,
      "relationship/bounded-query-exceeded",
      `Query "${fieldName}" exceeds the hard cap.`,
    );
  }
  return n;
}

function parseDirection(raw: string | null): "outgoing" | "incoming" | "both" {
  if (raw === null) return "both";
  if (raw !== "outgoing" && raw !== "incoming" && raw !== "both") {
    throw new HandlerError(400, "relationship/bad-request", "Unknown direction.");
  }
  return raw;
}

interface ProposalInput {
  readonly type: RelationshipType;
  readonly source: { readonly kind: RelationshipObjectKind; readonly id: string };
  readonly target: { readonly kind: RelationshipObjectKind; readonly id: string };
  readonly scope: RelationshipScope;
  readonly summary?: string | undefined;
}

function assertOnlyKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  fieldName: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) {
      throw new HandlerError(
        400,
        "relationship/bad-request",
        `${fieldName} contains an unknown field: ${key}.`,
      );
    }
  }
}

function parseScope(
  workspaceId: string,
  raw: Record<string, unknown> | undefined,
): RelationshipScope {
  if (raw === undefined) return { kind: "workspace", workspaceId };
  const kind = requireString(raw, "kind");
  if (kind === "workspace") return { kind: "workspace", workspaceId };
  if (kind === "global") return { kind: "global", workspaceId };
  if (kind === "user") {
    return { kind: "user", userId: requireString(raw, "userId"), workspaceId };
  }
  if (kind === "project") {
    return { kind: "project", projectId: requireString(raw, "projectId"), workspaceId };
  }
  if (kind === "workflow") {
    return {
      kind: "workflow",
      workflowDefinitionId: requireString(raw, "workflowDefinitionId"),
      workspaceId,
    };
  }
  throw new HandlerError(400, "relationship/bad-request", "Unknown scope kind.");
}

function parseProposal(body: Record<string, unknown>, workspaceId: string): ProposalInput {
  const proposal = asRecord(body.proposal, "proposal");
  assertOnlyKeys(proposal, ["type", "source", "target", "scope", "summary"], "proposal");
  const source = asRecord(proposal.source, "proposal.source");
  assertOnlyKeys(source, ["kind", "id"], "proposal.source");
  const target = asRecord(proposal.target, "proposal.target");
  assertOnlyKeys(target, ["kind", "id"], "proposal.target");
  const rawScope =
    proposal.scope === undefined ? undefined : asRecord(proposal.scope, "proposal.scope");
  if (rawScope !== undefined) {
    assertOnlyKeys(
      rawScope,
      ["kind", "workspaceId", "userId", "projectId", "workflowDefinitionId"],
      "proposal.scope",
    );
  }
  const summary = optionalString(proposal, "summary");
  if (summary !== undefined && summary.length > 240) {
    throw new HandlerError(400, "relationship/bad-request", "summary may not exceed 240 chars.");
  }
  return {
    type: parseRelationshipType(proposal.type),
    source: {
      kind: parseEndpointKind(source.kind),
      id: requireString(source, "id"),
    },
    target: {
      kind: parseEndpointKind(target.kind),
      id: requireString(target, "id"),
    },
    scope: parseScope(workspaceId, rawScope),
    ...(summary === undefined ? {} : { summary }),
  };
}

function assertSchemaVersion(body: Record<string, unknown>): void {
  if (body.schemaVersion !== RELATIONSHIP_SCHEMA_VERSION) {
    throw new HandlerError(
      422,
      "relationship/schema-version-unsupported",
      `schemaVersion must be "${RELATIONSHIP_SCHEMA_VERSION}".`,
    );
  }
}

// Synthesizes a candidate `Relationship` record (the shape the validator expects) from a
// proposal + optional context. The id/createdAt/updatedAt/etag fields are placeholders
// because we only need a structurally valid Relationship to run the pure validator. The
// real persisted record reuses the proposal data with server-supplied identity.
function relationshipCandidate(
  proposal: ProposalInput,
  workspaceId: string,
  initialLifecycle: RelationshipLifecycleState,
): Relationship & { readonly metadata?: Readonly<Record<string, unknown>> } {
  const now = new Date().toISOString();
  return {
    id: "candidate",
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    workspaceId,
    source: { ...proposal.source, workspaceId },
    target: { ...proposal.target, workspaceId },
    type: proposal.type,
    lifecycleState: initialLifecycle,
    createdAt: now,
    updatedAt: now,
    etag: 0,
  };
}

function denialBody(errors: readonly RelationshipValidationError[]): {
  readonly error: { readonly code: string; readonly message: string };
  readonly reasons: readonly RelationshipValidationError[];
} {
  return {
    error: {
      code: "relationship/policy-denied",
      message: "Validator denied the proposal.",
    },
    reasons: errors,
  };
}

function denialReason(
  code: RelationshipValidationError["code"],
  message: string,
  field?: string,
): RelationshipValidationError {
  return field === undefined ? { code, message } : { code, message, field };
}

function redactString(redactor: Redactor, value: string): string {
  const redacted = redactor(value);
  return typeof redacted === "string" ? redacted : value;
}

function sanitizeSummary(redactor: Redactor, summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const sanitized = redactString(redactor, summary);
  if (sanitized.length > 240) {
    throw new HandlerError(400, "relationship/bad-request", "summary may not exceed 240 chars.");
  }
  return sanitized;
}

function activityStateFromLifecycle(
  lifecycle: StoredRelationship["lifecycleState"],
): RelationshipActivitySnapshot["state"] {
  if (lifecycle === "blocked") return "blocked";
  if (lifecycle === "stale") return "degraded";
  return "inactive";
}

function activityPriority(state: RelationshipActivitySnapshot["state"]): number {
  switch (state) {
    case "high-throughput":
      return 8;
    case "processing":
      return 7;
    case "active":
      return 6;
    case "queued":
      return 5;
    case "failed":
      return 4;
    case "completed":
      return 3;
    case "blocked":
      return 2;
    case "degraded":
      return 1;
    case "inactive":
    default:
      return 0;
  }
}

function activityEventLine(redactor: Redactor, snapshot: RelationshipActivitySnapshot): string {
  const payload = redactor(snapshot) ?? snapshot;
  return `event: relationship:activity\ndata: ${JSON.stringify(payload)}\n\n`;
}

function activityNdjsonLine(redactor: Redactor, snapshot: RelationshipActivitySnapshot): string {
  const payload = redactor(snapshot) ?? snapshot;
  return `${JSON.stringify(payload)}\n`;
}

function mergeActivitySnapshot(
  map: Map<string, RelationshipActivitySnapshot>,
  candidate: RelationshipActivitySnapshot,
): void {
  const current = map.get(candidate.id);
  if (current === undefined) {
    map.set(candidate.id, candidate);
    return;
  }
  const candidatePriority = activityPriority(candidate.state);
  const currentPriority = activityPriority(current.state);
  if (candidatePriority > currentPriority) {
    map.set(candidate.id, candidate);
    return;
  }
  if (candidatePriority === currentPriority && candidate.timestamp >= current.timestamp) {
    map.set(candidate.id, candidate);
  }
}

function relevantRunEvents(
  record: RunRecord,
  now: number,
): readonly { readonly ts: number; readonly type: string }[] {
  const cutoff = now - ACTIVITY_WINDOW_MS;
  return record.sink
    .buffered()
    .filter(
      (event) =>
        typeof event.ts === "number" && event.ts >= cutoff && typeof event.type === "string",
    )
    .map((event) => ({ ts: event.ts, type: event.type }));
}

function activitySnapshot(
  state: RelationshipActivitySnapshot["state"],
  timestamp: number,
  count?: number,
): RelationshipActivitySnapshot {
  return {
    kind: "relationship:activity",
    id: "",
    state,
    timestamp,
    ...(count !== undefined ? { count } : {}),
  };
}

function runningActivity(
  events: readonly { readonly ts: number; readonly type: string }[],
): RelationshipActivitySnapshot["state"] {
  if (events.some((event) => RUN_PROCESSING_EVENT_TYPES.has(event.type))) {
    return "processing";
  }
  if (events.some((event) => RUN_ACTIVE_EVENT_TYPES.has(event.type))) {
    return "active";
  }
  return "queued";
}

function activityFromRun(record: RunRecord, now: number): RelationshipActivitySnapshot | undefined {
  const events = relevantRunEvents(record, now);
  const latestTimestamp =
    events.length > 0 ? events[events.length - 1]?.ts : (record.terminatedAt ?? undefined);
  if (latestTimestamp === undefined || latestTimestamp < now - ACTIVITY_WINDOW_MS) {
    return undefined;
  }
  if (events.length > ACTIVITY_HIGH_THROUGHPUT_THRESHOLD) {
    return activitySnapshot("high-throughput", latestTimestamp, events.length);
  }
  if (record.status === "running") {
    return activitySnapshot(runningActivity(events), latestTimestamp);
  }
  if (record.status === "failed") {
    return activitySnapshot("failed", latestTimestamp);
  }
  if (record.status === "completed") {
    return activitySnapshot("completed", latestTimestamp);
  }
  return undefined;
}

function listRelationshipsForRunId(
  store: RelationshipStore,
  workspaceId: string,
  runId: string,
): readonly StoredRelationship[] {
  const dedup = new Map<string, StoredRelationship>();
  const queries: readonly ListQuery[] = [
    {
      workspaceId,
      sourceKind: "workflow-run",
      sourceId: runId,
      limit: MAX_LIST_LIMIT,
    },
    {
      workspaceId,
      targetKind: "workflow-run",
      targetId: runId,
      limit: MAX_LIST_LIMIT,
    },
    {
      workspaceId,
      sourceKind: "evidence-run",
      sourceId: runId,
      limit: MAX_LIST_LIMIT,
    },
    {
      workspaceId,
      targetKind: "evidence-run",
      targetId: runId,
      limit: MAX_LIST_LIMIT,
    },
  ];
  for (const query of queries) {
    const result = store.listRelationships(query);
    for (const entry of result.entries) {
      dedup.set(entry.id, entry);
    }
  }
  return Array.from(dedup.values());
}

function registryRecords(deps: UiHandlerDeps): readonly RunRecord[] {
  const records = deps.registry.snapshot?.(ACTIVITY_MAX_RUNS) ?? [];
  return [...records].sort((left, right) => {
    const leftTs = left.sink.buffered().at(-1)?.ts ?? left.terminatedAt ?? 0;
    const rightTs = right.sink.buffered().at(-1)?.ts ?? right.terminatedAt ?? 0;
    return rightTs - leftTs;
  });
}

function collectActivitySnapshots(
  deps: UiHandlerDeps,
  relationship: RelationshipHandlerDeps,
  workspaceId: string,
  now = Date.now(),
): readonly RelationshipActivitySnapshot[] {
  const snapshots = new Map<string, RelationshipActivitySnapshot>();
  const staleOrBlocked = [
    relationship.store.listRelationships({
      workspaceId,
      lifecycle: "blocked",
      limit: MAX_LIST_LIMIT,
    }),
    relationship.store.listRelationships({
      workspaceId,
      lifecycle: "stale",
      limit: MAX_LIST_LIMIT,
    }),
  ];
  for (const result of staleOrBlocked) {
    for (const entry of result.entries) {
      mergeActivitySnapshot(snapshots, {
        kind: "relationship:activity",
        id: entry.id,
        state: activityStateFromLifecycle(entry.lifecycleState),
        timestamp: Date.parse(entry.updatedAt),
      });
    }
  }
  for (const record of registryRecords(deps)) {
    const derived = activityFromRun(record, now);
    if (derived === undefined) {
      continue;
    }
    for (const relationshipEntry of listRelationshipsForRunId(
      relationship.store,
      workspaceId,
      record.runId,
    )) {
      mergeActivitySnapshot(snapshots, {
        ...derived,
        id: relationshipEntry.id,
      });
    }
  }
  return Array.from(snapshots.values()).sort((left, right) => right.timestamp - left.timestamp);
}

function exposeRelationship(r: StoredRelationship): Record<string, unknown> {
  return {
    id: r.id,
    schemaVersion: r.schemaVersion,
    workspaceId: r.workspaceId,
    type: r.type,
    source: r.source,
    target: r.target,
    lifecycle: r.lifecycleState,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    etag: r.etag,
    ...(r.confidence === undefined ? {} : { confidence: r.confidence }),
    ...(r.summary === undefined ? {} : { summary: r.summary }),
  };
}

const CARDINALITY_LIFECYCLES: readonly RelationshipLifecycleState[] = [
  "draft",
  "active",
  "archived",
] as const;

function hasRelationshipInCardinalitySet(
  store: RelationshipStore,
  query: Omit<ListQuery, "workspaceId" | "lifecycle" | "limit"> & {
    readonly workspaceId: string;
  },
  excludeRelationshipId?: string,
): boolean {
  for (const lifecycle of CARDINALITY_LIFECYCLES) {
    const result = store.listRelationships({
      ...query,
      lifecycle,
      limit: 1,
    });
    if (
      result.entries.length > 0 &&
      (excludeRelationshipId === undefined || result.entries[0]?.id !== excludeRelationshipId)
    ) {
      return true;
    }
  }
  return false;
}

function cardinalitySnapshotForProposal(
  store: RelationshipStore,
  workspaceId: string,
  proposal: ProposalInput,
  excludeRelationshipId?: string,
): RelationshipCardinalityCounts | undefined {
  if (proposal.type === "produces-evidence") {
    return {
      producesEvidenceForSource: hasRelationshipInCardinalitySet(
        store,
        {
          workspaceId,
          type: proposal.type,
          sourceKind: proposal.source.kind,
          sourceId: proposal.source.id,
        },
        excludeRelationshipId,
      )
        ? 1
        : 0,
    };
  }
  if (proposal.type === "starts-workflow") {
    return {
      startsWorkflowForTarget: hasRelationshipInCardinalitySet(
        store,
        {
          workspaceId,
          type: proposal.type,
          targetKind: proposal.target.kind,
          targetId: proposal.target.id,
        },
        excludeRelationshipId,
      )
        ? 1
        : 0,
    };
  }
  return undefined;
}

function reverseDependsOnExists(
  store: RelationshipStore,
  workspaceId: string,
  proposal: ProposalInput,
  excludeRelationshipId?: string,
): boolean {
  if (proposal.type !== "depends-on") return false;
  return hasRelationshipInCardinalitySet(
    store,
    {
      workspaceId,
      type: "depends-on",
      sourceKind: proposal.target.kind,
      sourceId: proposal.target.id,
      targetKind: proposal.source.kind,
      targetId: proposal.source.id,
    },
    excludeRelationshipId,
  );
}

function validationContextForProposal(
  store: RelationshipStore,
  workspaceId: string,
  proposal: ProposalInput,
  opts?: {
    readonly excludeRelationshipId?: string;
    readonly previousLifecycleState?: RelationshipLifecycleState;
  },
): RelationshipValidationContext | undefined {
  const cardinalityCounts = cardinalitySnapshotForProposal(
    store,
    workspaceId,
    proposal,
    opts?.excludeRelationshipId,
  );
  const dependsOnReverseEdgeExists = reverseDependsOnExists(
    store,
    workspaceId,
    proposal,
    opts?.excludeRelationshipId,
  );
  const hasPreviousLifecycleState = opts?.previousLifecycleState !== undefined;
  const hasReverseEdge = dependsOnReverseEdgeExists;
  if (cardinalityCounts === undefined && !hasReverseEdge && !hasPreviousLifecycleState) {
    return undefined;
  }
  return {
    ...(cardinalityCounts === undefined ? {} : { cardinalityCounts }),
    ...(!hasReverseEdge ? {} : { dependsOnReverseEdgeExists }),
    ...(!hasPreviousLifecycleState ? {} : { previousLifecycleState: opts.previousLifecycleState }),
  };
}

function proposalFromStoredRelationship(
  relationship: StoredRelationship,
  target: ProposalInput["target"] = {
    kind: relationship.target.kind,
    id: relationship.target.id,
  },
): ProposalInput {
  return {
    type: relationship.type,
    source: {
      kind: relationship.source.kind,
      id: relationship.source.id,
    },
    target,
    scope: relationship.scope,
  };
}

function validateTransitionCandidate(
  store: RelationshipStore,
  workspaceId: string,
  existing: StoredRelationship,
  to: RelationshipLifecycleState,
): ReturnType<typeof validateRelationship> {
  const proposal = proposalFromStoredRelationship(existing);
  const candidate = relationshipCandidate(proposal, workspaceId, to);
  const validationCtx = validationContextForProposal(store, workspaceId, proposal, {
    excludeRelationshipId: existing.id,
    previousLifecycleState: existing.lifecycleState,
  }) ?? { previousLifecycleState: existing.lifecycleState };
  return validateRelationship(candidate, validationCtx);
}

function validateReconnectCandidate(
  store: RelationshipStore,
  workspaceId: string,
  existing: StoredRelationship,
  target: ProposalInput["target"],
): ReturnType<typeof validateRelationship> {
  const proposal = proposalFromStoredRelationship(existing, target);
  const candidate = relationshipCandidate(proposal, workspaceId, existing.lifecycleState);
  const validationCtx = validationContextForProposal(store, workspaceId, proposal, {
    excludeRelationshipId: existing.id,
  });
  return validationCtx === undefined
    ? validateRelationship(candidate)
    : validateRelationship(candidate, validationCtx);
}

// ─── Handler factory ──────────────────────────────────────────────────────────
export interface RelationshipHandlerSet {
  readonly handleValidate: (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>;
  readonly handleCreate: (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>;
  readonly handleList: (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>;
  readonly handleGet: (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>;
  readonly handlePatch: (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>;
  readonly handleDelete: (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>;
  readonly handleDependencies: (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>;
  readonly handleImpact: (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>;
  readonly handleExplain: (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>;
  readonly handleHealth: (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult>;
  readonly handleEvents: (ctx: RouteContext, deps: UiHandlerDeps) => RouteResult | typeof STREAMING;
}

function readRelationshipDeps(deps: UiHandlerDeps): RelationshipHandlerDeps {
  const r = (deps as UiHandlerDeps & { relationship?: RelationshipHandlerDeps }).relationship;
  if (r === undefined) {
    throw new HandlerError(
      500,
      "relationship/internal-error",
      "Relationship handler dependency is not wired.",
    );
  }
  return r;
}

async function runHandler<T>(
  redactor: Redactor,
  worker: () => Promise<T> | T,
  toResult: (value: T) => RouteResult,
): Promise<RouteResult> {
  try {
    return toResult(await worker());
  } catch (error) {
    if (error instanceof HandlerError) return errorResult(redactor, error);
    if (error instanceof UiStoreError) return errorResult(redactor, handlerErrorFromStore(error));
    throw error;
  }
}

// ─── Route 1: POST /api/relationships/validate ────────────────────────────────
async function handleValidateImpl(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  return runHandler(
    deps.redactor,
    async () => {
      const relationship = readRelationshipDeps(deps);
      const workspaceId = scope(ctx.req, relationship);
      const { value: body } = await readJsonBody(ctx.req);
      assertOnlyKeys(body, ["schemaVersion", "proposal"], "body");
      assertSchemaVersion(body);
      const proposal = parseProposal(body, workspaceId);
      const candidate = relationshipCandidate(proposal, workspaceId, "active");
      const validationCtx = validationContextForProposal(relationship.store, workspaceId, proposal);
      const result =
        validationCtx === undefined
          ? validateRelationship(candidate)
          : validateRelationship(candidate, validationCtx);
      return { result, etag: undefined as string | undefined };
    },
    ({ result }) => {
      const decision = result.ok
        ? { allowed: true as const, reasons: [] as readonly RelationshipValidationError[] }
        : { allowed: false as const, reasons: result.errors };
      return respond(deps.redactor, 200, { schemaVersion: "1", decision, hints: [] });
    },
  );
}

interface CreateOutcome {
  readonly replay: boolean;
  readonly status: number;
  readonly response: Record<string, unknown>;
}

// Performs validation, persistence, audit, and idempotency caching for POST /api/relationships.
// Called only when no cached replay exists. (api-contract.md §5, storage.md §4, audit-events.md §5.2)
function performCreateDenial(
  store: RelationshipStore,
  workspaceId: string,
  proposal: ProposalInput,
  cacheKey: string,
  hash: string,
  now: number,
  errors: readonly RelationshipValidationError[],
): CreateOutcome {
  store.recordAuditEntry({
    workspaceId,
    kind: "relationship.validation-denied",
    actor: { surface: "system", redactedActorId: "bff" },
    summary: "validation-denied",
    payload: {
      proposedType: proposal.type,
      proposedSourceKind: proposal.source.kind,
      proposedTargetKind: proposal.target.kind,
      reasonCount: errors.length,
    },
  });
  const denied = denialBody(errors);
  recordIdempotency(cacheKey, {
    bodyHash: hash,
    status: 422,
    response: denied,
    expiresAt: now + IDEMPOTENCY_TTL_MS,
  });
  return { replay: false, status: 422, response: denied };
}

function emitCreatedAuditEntry(
  store: RelationshipStore,
  workspaceId: string,
  stored: StoredRelationship,
  etag: string,
): void {
  store.recordAuditEntry({
    workspaceId,
    kind: "relationship.created",
    relationshipId: stored.id,
    actor: { surface: "system", redactedActorId: "bff" },
    summary: "relationship created",
    payload: {
      relationshipType: stored.type,
      sourceKind: stored.source.kind,
      targetKind: stored.target.kind,
      lifecycle: stored.lifecycleState,
      etag,
    },
  });
}

function performCreate(
  redactor: Redactor,
  store: RelationshipStore,
  workspaceId: string,
  proposal: ProposalInput,
  cacheKey: string,
  hash: string,
  now: number,
): CreateOutcome {
  const candidate = relationshipCandidate(proposal, workspaceId, "active");
  const validationCtx = validationContextForProposal(store, workspaceId, proposal);
  const validation =
    validationCtx === undefined
      ? validateRelationship(candidate)
      : validateRelationship(candidate, validationCtx);
  if (!validation.ok) {
    return performCreateDenial(
      store,
      workspaceId,
      proposal,
      cacheKey,
      hash,
      now,
      validation.errors,
    );
  }
  const summary = sanitizeSummary(redactor, proposal.summary);
  const { relationship: stored, etag } = store.createRelationship({
    workspaceId,
    scope: proposal.scope,
    type: proposal.type,
    source: proposal.source,
    target: proposal.target,
    lifecycleState: "active",
    ...(summary === undefined ? {} : { summary }),
  });
  emitCreatedAuditEntry(store, workspaceId, stored, etag);
  const response = { schemaVersion: "1", relationship: exposeRelationship(stored), etag };
  recordIdempotency(cacheKey, {
    bodyHash: hash,
    status: 201,
    response,
    expiresAt: now + IDEMPOTENCY_TTL_MS,
  });
  return { replay: false, status: 201, response };
}

// ─── Route 2: POST /api/relationships ─────────────────────────────────────────
async function handleCreateImpl(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  return runHandler(
    deps.redactor,
    async () => {
      const relationship = readRelationshipDeps(deps);
      const workspaceId = scope(ctx.req, relationship);
      const idempotencyHeader = requireIdempotencyKey(ctx.req);
      const { raw, value: body } = await readJsonBody(ctx.req);
      assertOnlyKeys(body, ["schemaVersion", "proposal"], "body");
      assertSchemaVersion(body);
      const proposal = parseProposal(body, workspaceId);
      // Idempotency replay (api-contract.md §5).
      const now = Date.now();
      pruneExpiredIdempotency(now);
      const cacheKey = idempotencyKey(workspaceId, "POST /api/relationships", idempotencyHeader);
      const cached = idempotencyStore.get(cacheKey);
      const hash = hashBody(raw);
      if (cached !== undefined) {
        if (cached.bodyHash !== hash) {
          throw new HandlerError(
            409,
            "relationship/idempotency-replay-mismatch",
            "Idempotency-Key replay with divergent body.",
          );
        }
        return {
          replay: true as const,
          status: cached.status,
          response: cached.response as Record<string, unknown>,
        };
      }
      return performCreate(
        deps.redactor,
        relationship.store,
        workspaceId,
        proposal,
        cacheKey,
        hash,
        now,
      );
    },
    (out) => respond(deps.redactor, out.status, out.response),
  );
}

// Returns true when at least one selective filter is present (api-contract.md §4.3).
function hasSelectiveFilter(url: URL): boolean {
  return (
    url.searchParams.has("sourceKind") ||
    url.searchParams.has("sourceId") ||
    url.searchParams.has("targetKind") ||
    url.searchParams.has("targetId") ||
    url.searchParams.has("type") ||
    url.searchParams.has("lifecycle")
  );
}

// Builds the ListQuery from URL search params; enforces bare-list prohibition
// (api-contract.md §4.3).
function parseListQuery(workspaceId: string, url: URL): ListQuery {
  const sourceKind = url.searchParams.get("sourceKind");
  const sourceId = url.searchParams.get("sourceId");
  const targetKind = url.searchParams.get("targetKind");
  const targetId = url.searchParams.get("targetId");
  const type = url.searchParams.get("type");
  const lifecycle = url.searchParams.get("lifecycle");
  if (!hasSelectiveFilter(url)) {
    throw new HandlerError(
      400,
      "relationship/bounded-query-required",
      "At least one selective filter is required.",
    );
  }
  const limit = clampBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
    "limit",
  );
  return {
    workspaceId,
    ...(sourceKind === null ? {} : { sourceKind: parseEndpointKind(sourceKind) }),
    ...(sourceId === null ? {} : { sourceId }),
    ...(targetKind === null ? {} : { targetKind: parseEndpointKind(targetKind) }),
    ...(targetId === null ? {} : { targetId }),
    ...(type === null ? {} : { type: parseRelationshipType(type) }),
    ...(lifecycle === null ? {} : { lifecycle: parseLifecycleState(lifecycle) }),
    limit,
  };
}

// ─── Route 3: GET /api/relationships ──────────────────────────────────────────
async function handleListImpl(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  return runHandler(
    deps.redactor,
    () => {
      const relationship = readRelationshipDeps(deps);
      const workspaceId = scope(ctx.req, relationship);
      // Parse here so the response can echo the requested cap (api-contract.md §4.3 specifies
      // `"limit": 64` — the applied cap, not the returned count). Echoing `entries.length` would
      // make clients miscount truncation for partial pages; `truncated` is the truncation signal.
      const query = parseListQuery(workspaceId, ctx.url);
      const result = relationship.store.listRelationships(query);
      return { result, requestedLimit: query.limit };
    },
    ({ result, requestedLimit }) =>
      respond(deps.redactor, 200, {
        schemaVersion: "1",
        entries: result.entries.map(exposeRelationship),
        limit: requestedLimit,
        truncated: result.truncated,
        nextCursor: result.nextCursor ?? null,
      }),
  );
}

// ─── Route 4: GET /api/relationships/:id ──────────────────────────────────────
async function handleGetImpl(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  return runHandler(
    deps.redactor,
    () => {
      const relationship = readRelationshipDeps(deps);
      const workspaceId = scope(ctx.req, relationship);
      const id = requireRelationshipId(ctx.params.id);
      const found = relationship.store.getRelationship(workspaceId, id);
      if (found === undefined) {
        throw new HandlerError(404, "relationship/not-found", "Relationship not found.");
      }
      const etag = relationship.store.getEtag(workspaceId, id) ?? "";
      return { found, etag };
    },
    ({ found, etag }) =>
      respond(
        deps.redactor,
        200,
        { schemaVersion: "1", relationship: exposeRelationship(found) },
        etag,
      ),
  );
}

interface PatchOutcome {
  readonly status: 200 | 422;
  readonly body: Record<string, unknown>;
  readonly etag: string | undefined;
}

function illegalLifecycleTransition(message: string, field: string): PatchOutcome {
  return {
    status: 422,
    body: denialBody([denialReason("denied/lifecycle-illegal-transition", message, field)]),
    etag: undefined,
  };
}

function validateTransitionRequest(
  existing: StoredRelationship,
  to: RelationshipLifecycleState,
): PatchOutcome | undefined {
  if (to === "stale") {
    return illegalLifecycleTransition(
      "client-initiated transitions to stale are reserved for health checks",
      "transition.to",
    );
  }
  if (existing.lifecycleState === "stale" && to === "active") {
    return illegalLifecycleTransition(
      "client-initiated stale reactivation is reserved for health checks",
      "transition.to",
    );
  }
  return undefined;
}

function validateReconnectRequest(existing: StoredRelationship): PatchOutcome | undefined {
  if (RELATIONSHIP_TYPE_DEFINITIONS[existing.type].lifecycle.reconnectable) {
    return undefined;
  }
  return illegalLifecycleTransition(
    `relationship type "${existing.type}" does not permit reconnect`,
    "reconnect.target",
  );
}

// Transition branch of PATCH: validates and applies a lifecycle state change.
function applyTransition(
  redactor: Redactor,
  store: RelationshipStore,
  workspaceId: string,
  id: string,
  currentEtag: string,
  existing: StoredRelationship,
  transition: Record<string, unknown>,
): PatchOutcome {
  const to = parseLifecycleState(transition.to);
  const summary = sanitizeSummary(redactor, optionalString(transition, "summary"));
  const transitionError = validateTransitionRequest(existing, to);
  if (transitionError) return transitionError;
  const validation = validateTransitionCandidate(store, workspaceId, existing, to);
  if (!validation.ok) {
    return { status: 422, body: denialBody(validation.errors), etag: undefined };
  }
  const { relationship: updated, etag } = store.updateLifecycle({
    workspaceId,
    id,
    currentEtag,
    to,
    ...(summary === undefined ? {} : { summary }),
  });
  store.recordAuditEntry({
    workspaceId,
    kind: "relationship.activity-transitioned",
    relationshipId: id,
    actor: { surface: "system", redactedActorId: "bff" },
    summary: "lifecycle transitioned",
    payload: { from: existing.lifecycleState, to, previousEtag: currentEtag, newEtag: etag },
  });
  return {
    status: 200,
    body: { schemaVersion: "1", relationship: exposeRelationship(updated) },
    etag,
  };
}

// audit-events.md §4.2: `relationship.updated` payloads carry a `changedFields` closed-set
// array (`confidence | summary | lifecycle`). Reconnect changes the target endpoint, which sits
// outside the closed set; emitting `[]` keeps the persisted row schema-conformant while
// signalling "metadata-only change" until the contract grows a `target` member.
function recordReconnectAudit(
  store: RelationshipStore,
  workspaceId: string,
  id: string,
  currentEtag: string,
  etag: string,
): void {
  store.recordAuditEntry({
    workspaceId,
    kind: "relationship.updated",
    relationshipId: id,
    actor: { surface: "system", redactedActorId: "bff" },
    summary: "reconnected",
    payload: {
      changedFields: [] as readonly ("confidence" | "summary" | "lifecycle")[],
      previousEtag: currentEtag,
      newEtag: etag,
    },
  });
}

// Reconnect branch of PATCH: validates and retargets an existing relationship.
function applyReconnect(
  redactor: Redactor,
  store: RelationshipStore,
  workspaceId: string,
  id: string,
  currentEtag: string,
  existing: StoredRelationship,
  reconnect: Record<string, unknown>,
): PatchOutcome {
  const rawTarget = asRecord(reconnect.target, "reconnect.target");
  const newTarget = { kind: parseEndpointKind(rawTarget.kind), id: requireString(rawTarget, "id") };
  const summary = sanitizeSummary(redactor, optionalString(reconnect, "summary"));
  const reconnectError = validateReconnectRequest(existing);
  if (reconnectError) return reconnectError;
  const validation = validateReconnectCandidate(store, workspaceId, existing, newTarget);
  if (!validation.ok) {
    return { status: 422, body: denialBody(validation.errors), etag: undefined };
  }
  const { relationship: updated, etag } = store.reconnect({
    workspaceId,
    id,
    currentEtag,
    target: newTarget,
    ...(summary === undefined ? {} : { summary }),
  });
  recordReconnectAudit(store, workspaceId, id, currentEtag, etag);
  return {
    status: 200,
    body: { schemaVersion: "1", relationship: exposeRelationship(updated) },
    etag,
  };
}

interface PatchPreflight {
  readonly workspaceId: string;
  readonly id: string;
  readonly currentEtag: string;
  readonly existing: StoredRelationship;
  readonly transition: unknown;
  readonly reconnect: unknown;
}

async function performPatchPreflight(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<{ readonly store: RelationshipStore; readonly preflight: PatchPreflight }> {
  const relationship = readRelationshipDeps(deps);
  const workspaceId = scope(ctx.req, relationship);
  const id = requireRelationshipId(ctx.params.id);
  const ifMatch = requireIfMatch(ctx.req);
  requireIdempotencyKey(ctx.req);
  const { value: body } = await readJsonBody(ctx.req);
  assertOnlyKeys(body, ["schemaVersion", "transition", "reconnect"], "body");
  assertSchemaVersion(body);
  const transition = body.transition;
  const reconnect = body.reconnect;
  if ((transition === undefined) === (reconnect === undefined)) {
    throw new HandlerError(
      400,
      "relationship/bad-request",
      "Exactly one of `transition` or `reconnect` is required.",
    );
  }
  // Optimistic concurrency check happens at the store layer's UPDATE — we pre-check
  // by reading the current etag so we can return 412 cleanly.
  const currentEtag = relationship.store.getEtag(workspaceId, id);
  if (currentEtag === undefined) {
    throw new HandlerError(404, "relationship/not-found", "Relationship not found.");
  }
  if (currentEtag !== ifMatch) {
    throw new HandlerError(
      412,
      "relationship/optimistic-concurrency-conflict",
      "Relationship was modified by another writer.",
    );
  }
  // Validate the proposed state BEFORE persistence (storage.md §4).
  const existing = relationship.store.getRelationship(workspaceId, id);
  if (existing === undefined) {
    throw new HandlerError(404, "relationship/not-found", "Relationship not found.");
  }
  return {
    store: relationship.store,
    preflight: { workspaceId, id, currentEtag, existing, transition, reconnect },
  };
}

// ─── Route 5: PATCH /api/relationships/:id ────────────────────────────────────
async function handlePatchImpl(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  return runHandler(
    deps.redactor,
    async () => {
      const { store, preflight } = await performPatchPreflight(ctx, deps);
      if (preflight.transition !== undefined) {
        return applyTransition(
          deps.redactor,
          store,
          preflight.workspaceId,
          preflight.id,
          preflight.currentEtag,
          preflight.existing,
          asRecord(preflight.transition, "transition"),
        );
      }
      return applyReconnect(
        deps.redactor,
        store,
        preflight.workspaceId,
        preflight.id,
        preflight.currentEtag,
        preflight.existing,
        asRecord(preflight.reconnect, "reconnect"),
      );
    },
    (out) => respond(deps.redactor, out.status, out.body, out.etag),
  );
}

// ─── Route 6: DELETE /api/relationships/:id ───────────────────────────────────
async function handleDeleteImpl(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  return runHandler(
    deps.redactor,
    () => {
      const relationship = readRelationshipDeps(deps);
      const workspaceId = scope(ctx.req, relationship);
      const id = requireRelationshipId(ctx.params.id);
      const ifMatch = requireIfMatch(ctx.req);
      requireIdempotencyKey(ctx.req);
      const currentEtag = relationship.store.getEtag(workspaceId, id);
      if (currentEtag === undefined) {
        throw new HandlerError(404, "relationship/not-found", "Relationship not found.");
      }
      if (currentEtag !== ifMatch) {
        throw new HandlerError(
          412,
          "relationship/optimistic-concurrency-conflict",
          "Relationship was modified by another writer.",
        );
      }
      const existing = relationship.store.getRelationship(workspaceId, id);
      if (existing === undefined) {
        throw new HandlerError(404, "relationship/not-found", "Relationship not found.");
      }
      const { relationship: updated, etag } = relationship.store.updateLifecycle({
        workspaceId,
        id,
        currentEtag,
        to: "revoked",
      });
      relationship.store.recordAuditEntry({
        workspaceId,
        kind: "relationship.deleted",
        relationshipId: id,
        actor: { surface: "system", redactedActorId: "bff" },
        summary: "relationship revoked",
        payload: { reasonCode: "operator-revoked", previousEtag: currentEtag, newEtag: etag },
      });
      return { updated, etag };
    },
    ({ updated, etag }) =>
      respond(
        deps.redactor,
        200,
        { schemaVersion: "1", relationship: exposeRelationship(updated) },
        etag,
      ),
  );
}

// ─── Route 7: GET /api/relationships/:id/dependencies ─────────────────────────
async function handleDependenciesImpl(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(
    deps.redactor,
    () => {
      const relationship = readRelationshipDeps(deps);
      const workspaceId = scope(ctx.req, relationship);
      const id = requireRelationshipId(ctx.params.id);
      const url = ctx.url;
      const args: WalkArgs = {
        workspaceId,
        originId: id,
        direction: parseDirection(url.searchParams.get("direction")),
        maxDepth: clampBoundedInt(
          url.searchParams.get("maxDepth"),
          DEFAULT_IMPACT_DEPTH,
          MAX_IMPACT_DEPTH,
          "maxDepth",
        ),
        maxNodes: clampBoundedInt(
          url.searchParams.get("maxNodes"),
          DEFAULT_IMPACT_NODES,
          MAX_IMPACT_NODES,
          "maxNodes",
        ),
        maxRelationships: clampBoundedInt(
          url.searchParams.get("maxRelationships"),
          DEFAULT_IMPACT_RELATIONSHIPS,
          MAX_IMPACT_RELATIONSHIPS,
          "maxRelationships",
        ),
      };
      return { rootId: id, walk: relationship.store.walkDependencies(args) };
    },
    ({ rootId, walk }) => respond(deps.redactor, 200, dependencyWalkReport(rootId, walk)),
  );
}

function dependencyWalkReport(
  rootId: string,
  report: DependencyWalkResult,
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    report: {
      rootRelationshipId: rootId,
      depthReached: report.depthReached,
      truncated: report.truncated,
      truncationReason: report.truncationReason,
      relationships: report.relationships.map(exposeRelationship),
      endpoints: report.nodes,
    },
  };
}

// Parses bounded impact query params from the URL (api-contract.md §4.4).
function parseImpactArgs(workspaceId: string, url: URL): ImpactArgs {
  const endpointKindRaw = url.searchParams.get("endpointKind");
  const endpointId = url.searchParams.get("endpointId");
  if (endpointKindRaw === null || endpointId === null) {
    throw new HandlerError(
      400,
      "relationship/bad-request",
      "endpointKind and endpointId are required.",
    );
  }
  return {
    workspaceId,
    endpoint: { kind: parseEndpointKind(endpointKindRaw), id: endpointId },
    direction: parseDirection(url.searchParams.get("direction")),
    maxDepth: clampBoundedInt(
      url.searchParams.get("maxDepth"),
      DEFAULT_IMPACT_DEPTH,
      MAX_IMPACT_DEPTH,
      "maxDepth",
    ),
    maxNodes: clampBoundedInt(
      url.searchParams.get("maxNodes"),
      DEFAULT_IMPACT_NODES,
      MAX_IMPACT_NODES,
      "maxNodes",
    ),
    maxRelationships: clampBoundedInt(
      url.searchParams.get("maxRelationships"),
      DEFAULT_IMPACT_RELATIONSHIPS,
      MAX_IMPACT_RELATIONSHIPS,
      "maxRelationships",
    ),
  };
}

// ─── Route 8: GET /api/relationships/impact ───────────────────────────────────
async function handleImpactImpl(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  return runHandler(
    deps.redactor,
    () => {
      const relationship = readRelationshipDeps(deps);
      const workspaceId = scope(ctx.req, relationship);
      const args = parseImpactArgs(workspaceId, ctx.url);
      const report = relationship.store.computeImpact(args);
      // Emit a bounded-fan-out audit row when we hit a cap (audit-events.md §4.8). The audit
      // schema requires `originRelationshipId`; for impact (which starts from an endpoint, not a
      // relationship) we encode the focal endpoint as `<kind>:<id>` so the row keeps the
      // identity of the analysis origin without inventing a relationship id.
      if (report.truncated) {
        relationship.store.recordAuditEntry({
          workspaceId,
          kind: "relationship.impact-analysis-bounded",
          actor: { surface: "system", redactedActorId: "bff" },
          summary: "impact analysis truncated",
          payload: {
            originRelationshipId: `${args.endpoint.kind}:${args.endpoint.id}`,
            requestedMaxDepth: args.maxDepth,
            requestedMaxNodes: args.maxNodes,
            observedDepth: report.depthReached,
            observedNodes: report.nodes.length,
            truncatedAt: report.truncationReason ?? "max-depth",
          },
        });
      }
      return { args, report };
    },
    ({ args, report }) => respond(deps.redactor, 200, impactReport(args, report)),
  );
}

// api-contract.md §4.8 returns an ImpactReport from a focal endpoint, NOT a focal relationship —
// echo the requested origin (endpoint kind + opaque id) so clients can correlate the row, and
// drop the dependency-walk-only `rootRelationshipId` placeholder that was emitted as `""` before.
function impactReport(args: ImpactArgs, report: DependencyWalkResult): Record<string, unknown> {
  return {
    schemaVersion: "1",
    report: {
      origin: { kind: args.endpoint.kind, id: args.endpoint.id },
      depthReached: report.depthReached,
      truncated: report.truncated,
      truncationReason: report.truncationReason,
      relationships: report.relationships.map(exposeRelationship),
      endpoints: report.nodes,
    },
  };
}

// ─── Route 9: GET /api/relationships/:id/explain ──────────────────────────────
async function handleExplainImpl(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  return runHandler(
    deps.redactor,
    () => {
      const relationship = readRelationshipDeps(deps);
      const workspaceId = scope(ctx.req, relationship);
      const id = requireRelationshipId(ctx.params.id);
      const existing = relationship.store.getRelationship(workspaceId, id);
      if (existing === undefined) {
        throw new HandlerError(404, "relationship/not-found", "Relationship not found.");
      }
      const history = relationship.store.lifecycleHistory(workspaceId, id);
      return { existing, history };
    },
    ({ existing, history }) =>
      respond(deps.redactor, 200, {
        schemaVersion: "1",
        decision: {
          allowed: existing.lifecycleState !== "blocked" && existing.lifecycleState !== "revoked",
          reasons: [],
        },
        lifecycle: history.map((h) => ({
          from: h.fromState,
          to: h.toState,
          occurredAt: h.occurredAt,
        })),
      }),
  );
}

// ─── Route 10: GET /api/relationships/health ──────────────────────────────────
async function handleHealthImpl(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  return runHandler(
    deps.redactor,
    () => {
      const relationship = readRelationshipDeps(deps);
      const workspaceId = scope(ctx.req, relationship);
      return relationship.store.graphHealth(workspaceId);
    },
    (health) =>
      respond(deps.redactor, 200, {
        schemaVersion: "1",
        checkedAt: health.checkedAt,
        totals: health.totals,
        findings: health.findings,
        // Back-compat fields: previous wire shape was `{ entries, truncated, nextCursor }`.
        // We retain them so existing #540/#541 clients keep working until #543 migrates
        // them to the categorized `findings` surface.
        entries: [],
        truncated: health.truncated || anyHealthFindingTruncated(health.findings),
        nextCursor: null,
      }),
  );
}

function anyHealthFindingTruncated(findings: RelationshipHealthFindings): boolean {
  return (
    findings.orphanedEndpointsTruncated ||
    findings.staleRelationshipsTruncated ||
    findings.blockedRelationshipsTruncated ||
    findings.failedRelationshipsTruncated ||
    findings.invalidReferencesTruncated ||
    findings.cycleScanTruncated
  );
}

// ─── Route 11: GET /api/relationships/events (SSE) ────────────────────────────
function handleEventsImpl(ctx: RouteContext, deps: UiHandlerDeps): RouteResult | typeof STREAMING {
  let relationship: RelationshipHandlerDeps;
  let workspaceId: string;
  try {
    relationship = readRelationshipDeps(deps);
    workspaceId = scopeFromEventsRequest(ctx.req, ctx.url, relationship);
  } catch (error) {
    if (error instanceof HandlerError) return errorResult(deps.redactor, error);
    throw error;
  }
  const res: ServerResponse = ctx.res;
  const emitPoll = ctx.url.searchParams.get("poll") === "1";
  if (emitPoll) {
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    for (const snapshot of collectActivitySnapshots(deps, relationship, workspaceId)) {
      res.write(activityNdjsonLine(deps.redactor, snapshot));
    }
    res.end();
    return STREAMING;
  }
  res.writeHead(200, SSE_HEADERS);
  // Flush headers + emit an initial liveness frame so the EventSource client fires `onopen`
  // immediately, even on an idle workspace with no activity snapshots. Without this, the stream
  // sends 0 bytes until the first activity transition or the 30s ping, leaving the client stuck in
  // "connecting" and unable to distinguish a live-but-quiet stream from a dead one. The frame is a
  // `retry:` reconnect directive plus an SSE comment (`:` lines are ignored by EventSource), so it
  // carries no relationship payload and never trips the activity allowlist.
  res.flushHeaders();
  res.write(`retry: ${String(ACTIVITY_SSE_RETRY_MS)}\n: connected\n\n`);
  let lastEmitted = new Map<string, string>();
  const emitSnapshots = (): void => {
    const next = new Map<string, string>();
    for (const snapshot of collectActivitySnapshots(deps, relationship, workspaceId)) {
      const key = JSON.stringify(snapshot);
      next.set(snapshot.id, key);
      if (lastEmitted.get(snapshot.id) !== key) {
        res.write(activityEventLine(deps.redactor, snapshot));
      }
    }
    lastEmitted = next;
  };
  emitSnapshots();
  const ping = setInterval(() => res.write(`: ping\n\n`), 30_000);
  const refresh = setInterval(emitSnapshots, ACTIVITY_SSE_REFRESH_MS);
  ctx.req.on("close", () => {
    clearInterval(ping);
    clearInterval(refresh);
    res.end();
  });
  return STREAMING;
}

// ─── Exposed handler bindings ─────────────────────────────────────────────────
export const handleRelationshipValidate = handleValidateImpl;
export const handleRelationshipCreate = handleCreateImpl;
export const handleRelationshipList = handleListImpl;
export const handleRelationshipGet = handleGetImpl;
export const handleRelationshipPatch = handlePatchImpl;
export const handleRelationshipDelete = handleDeleteImpl;
export const handleRelationshipDependencies = handleDependenciesImpl;
export const handleRelationshipImpact = handleImpactImpl;
export const handleRelationshipExplain = handleExplainImpl;
export const handleRelationshipHealth = handleHealthImpl;
export const handleRelationshipEvents = handleEventsImpl;

// Test-only helper: build a candidate to keep parsers exercised from outside.
export const _testing = {
  parseProposal,
  hashBody,
} as const;

// ─── Production factory: build a RelationshipStore over a DatabaseSync ────────
// The factory composes the store CRUD + the audit ledger writer into the
// `RelationshipStore` port shape the handlers consume. Lives here (not in store/) so the
// handler is the one place that knows about the audit writer signature; the store/ files
// stay free of redactor wiring (#539 ADR-0031 D5: composition at the API edge).
import type { DatabaseSync } from "node:sqlite";
import {
  insertRelationship as sqlInsertRelationship,
  getRelationship as sqlGetRelationship,
  getRelationshipEtag as sqlGetEtag,
  listRelationships as sqlListRelationships,
  updateRelationshipLifecycle as sqlUpdateLifecycle,
  reconnectRelationship as sqlReconnect,
  walkDependencies as sqlWalkDependencies,
  computeImpact as sqlComputeImpact,
  graphHealth as sqlGraphHealth,
  listRelationshipLifecycleHistory as sqlLifecycleHistory,
  relationshipCardinalitySnapshot as sqlCardinalitySnapshot,
} from "./store/relationships.js";
import { insertRelationshipAuditEntry } from "./store/relationship-audit.js";

export interface CreateRelationshipStorePortOptions {
  readonly db: DatabaseSync;
  readonly redactString: (value: string) => string;
  // Clock + id seam so tests can pin determinism.
  readonly now?: (() => number) | undefined;
  readonly newId?: (() => string) | undefined;
}

function defaultEtag(updatedAt: number): string {
  const hex = updatedAt.toString(16).padStart(16, "0");
  const tail = randomUUID().replace(/-/g, "").slice(0, 6);
  return `${hex}-${tail}`;
}

type TxnFn = (fn: () => void) => void;
type NowFn = () => number;
type NewIdFn = () => string;

function portCreateRelationship(
  db: DatabaseSync,
  txn: TxnFn,
  now: NowFn,
  newId: NewIdFn,
  input: CreateRelationshipInput,
): { readonly relationship: StoredRelationship; readonly etag: string } {
  const id = newId();
  const at = now();
  const etag = defaultEtag(at);
  let inserted: StoredRelationship | undefined;
  txn(() => {
    inserted = sqlInsertRelationship(db, {
      id,
      workspaceId: input.workspaceId,
      scope: input.scope,
      type: input.type,
      source: { ...input.source, workspaceId: input.workspaceId },
      target: { ...input.target, workspaceId: input.workspaceId },
      lifecycleState: input.lifecycleState,
      createdAt: at,
      updatedAt: at,
      etag,
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    });
  });
  if (inserted === undefined) throw new Error("Insert did not produce a row.");
  return { relationship: inserted, etag };
}

function portUpdateLifecycle(
  db: DatabaseSync,
  txn: TxnFn,
  now: NowFn,
  args: UpdateLifecycleInput,
): { readonly relationship: StoredRelationship; readonly etag: string } {
  // Optimistic concurrency was checked by the handler; we still re-read here to keep
  // the previous-state value honest for the validator + history row.
  const current = sqlGetRelationship(db, args.id, args.workspaceId);
  if (current === undefined) {
    throw new UiStoreError("not_found", "Relationship not found.", 404);
  }
  const at = now();
  const etag = defaultEtag(at);
  let updated: StoredRelationship | undefined;
  txn(() => {
    updated = sqlUpdateLifecycle(db, {
      id: args.id,
      workspaceId: args.workspaceId,
      to: args.to,
      previous: current.lifecycleState,
      newEtag: etag,
      updatedAt: at,
      ...(args.summary === undefined ? {} : { summary: args.summary }),
    });
  });
  if (updated === undefined) throw new Error("Update did not produce a row.");
  return { relationship: updated, etag };
}

function portReconnect(
  db: DatabaseSync,
  txn: TxnFn,
  now: NowFn,
  args: ReconnectInput,
): { readonly relationship: StoredRelationship; readonly etag: string } {
  const at = now();
  const etag = defaultEtag(at);
  let updated: StoredRelationship | undefined;
  txn(() => {
    updated = sqlReconnect(db, {
      id: args.id,
      workspaceId: args.workspaceId,
      target: args.target,
      newEtag: etag,
      updatedAt: at,
      ...(args.summary === undefined ? {} : { summary: args.summary }),
    });
  });
  if (updated === undefined) throw new Error("Reconnect did not produce a row.");
  return { relationship: updated, etag };
}

function makeTxn(db: DatabaseSync): TxnFn {
  return (fn) => {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
}

function portRecordAuditEntry(
  db: DatabaseSync,
  now: () => number,
  redactString: (text: string) => string,
  input: AuditEntryInput,
): RelationshipAuditEntryRow {
  const eventId = `evt-${randomUUID()}`;
  return insertRelationshipAuditEntry(
    db,
    {
      eventId,
      workspaceId: input.workspaceId,
      occurredAt: now(),
      kind: input.kind,
      ...(input.relationshipId === undefined ? {} : { relationshipId: input.relationshipId }),
      actor: input.actor,
      summary: input.summary,
      payload: input.payload,
    },
    redactString,
  );
}

function portListRelationships(db: DatabaseSync, query: ListQuery): ListResult {
  return sqlListRelationships(db, {
    workspaceId: query.workspaceId,
    ...(query.sourceKind === undefined ? {} : { sourceKind: query.sourceKind }),
    ...(query.sourceId === undefined ? {} : { sourceId: query.sourceId }),
    ...(query.targetKind === undefined ? {} : { targetKind: query.targetKind }),
    ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
    ...(query.type === undefined ? {} : { type: query.type }),
    ...(query.lifecycle === undefined ? {} : { lifecycle: query.lifecycle }),
    limit: query.limit,
  });
}

function portLifecycleHistory(
  db: DatabaseSync,
  workspaceId: string,
  id: string,
): readonly LifecycleHistoryRow[] {
  // The validator scope-checks via getRelationship; if missing return [].
  const existing = sqlGetRelationship(db, id, workspaceId);
  if (existing === undefined) return [];
  return sqlLifecycleHistory(db, id);
}

export function createRelationshipStorePort(
  options: CreateRelationshipStorePortOptions,
): RelationshipStore {
  const now = options.now ?? ((): number => Date.now());
  const newId = options.newId ?? ((): string => `rel-${randomUUID()}`);
  const txn = makeTxn(options.db);
  return {
    createRelationship: (input) => portCreateRelationship(options.db, txn, now, newId, input),
    getRelationship: (workspaceId, id) => sqlGetRelationship(options.db, id, workspaceId),
    getEtag: (workspaceId, id) => sqlGetEtag(options.db, id, workspaceId),
    listRelationships: (query) => portListRelationships(options.db, query),
    updateLifecycle: (args) => portUpdateLifecycle(options.db, txn, now, args),
    reconnect: (args) => portReconnect(options.db, txn, now, args),
    walkDependencies: (args) => sqlWalkDependencies(options.db, args),
    computeImpact: (args) => sqlComputeImpact(options.db, args),
    graphHealth: (workspaceId): GraphHealth => {
      const summary = sqlGraphHealth(options.db, workspaceId);
      return {
        checkedAt: summary.checkedAt,
        totals: summary.totals,
        truncated: summary.truncated,
        findings: summary.findings,
      };
    },
    lifecycleHistory: (workspaceId, id) => portLifecycleHistory(options.db, workspaceId, id),
    recordAuditEntry: (input) => portRecordAuditEntry(options.db, now, options.redactString, input),
  };
}

// `sqlCardinalitySnapshot` is exported by the store; reserved for #538 follow-up where the
// API layer passes counts into the validator context. Kept imported here so the surface is
// in one place even if the handler chooses not to read it yet.
void sqlCardinalitySnapshot;
