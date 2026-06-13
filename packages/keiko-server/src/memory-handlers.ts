// MemoriaViva BFF route handlers (Issue #211 / Epic #204).
//
// These handlers wire the /api/memory/* routes to the three memory packages:
//   - @oscharko-dev/keiko-memory-vault   → persistence (list / get / update / delete)
//   - @oscharko-dev/keiko-memory-governance → pure operation builders (pin, archive, forget, correct)
//   - @oscharko-dev/keiko-memory-retrieval → not called here (retrieval is for model context)
//
// ADR-0019 direction rule 6a: keiko-server may import memory-vault, memory-governance, and
// memory-retrieval. Rule 8: the browser tier (keiko-ui) imports only keiko-contracts types
// via the BFF wire — never the domain packages directly.
//
// CSRF is enforced for all state-changing methods (POST/PATCH/DELETE) by the server dispatch
// layer in server.ts — handlers do NOT need to re-check.
//
// Every response is redacted through `deps.redactor` before serialisation to honour D9.

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  createMemoryVault,
  MemoryStorageError,
  type MemoryBatchUpdate,
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import {
  GovernanceError,
  buildArchiveOperation,
  buildConflictTransitions,
  buildCorrection,
  buildForgetOperations,
  buildPinOperation,
  buildUnpinOperation,
  detectConflictPair,
  selectMemoriesForForget,
  type ForgetSelector,
} from "@oscharko-dev/keiko-memory-governance";
import {
  checkStatusTransition,
  MEMORY_SCOPE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  MEMORY_SENSITIVITIES,
  validateMemoryScope,
  type MemoryConversationId,
  type MemoryAuditEvent,
  type MemoryEdge,
  type MemoryEdgeId,
  type MemoryId,
  type MemoryProposal,
  type MemoryProposalId,
  type MemoryRecord,
  type MemoryReviewerId,
  type MemoryScope,
  type MemoryScopeKind,
  type MemorySensitivity,
  type MemoryStatus,
  type MemoryType,
  type MemorySupersession,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import type { ApiError, RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { auditRunIdFor, recordMemoryAudit } from "./memory-audit-handler.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MEMORY_BODY_BYTES = 64_000;
const DEFAULT_REVIEWER_ID = "memoriaviva-ui" as MemoryReviewerId;
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const REVIEW_QUEUE_STATUSES: readonly MemoryStatus[] = ["proposed", "conflicted", "expired"];

// ─── Type guards / helpers ─────────────────────────────────────────────────────

// Sanitise GovernanceError into a code-keyed safe response body. GovernanceError.message
// is composed as `GovernanceError(${code}): ${detail}` and can embed memory UUIDs from
// the inner detail string; the public surface should only expose the stable enum `code`.
function governanceErrorBody(err: GovernanceError): ApiError {
  return errorBody("GOVERNANCE_ERROR", `Governance constraint violated (${err.code}).`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryScopeKind(value: unknown): value is MemoryScopeKind {
  return typeof value === "string" && (MEMORY_SCOPE_KINDS as readonly string[]).includes(value);
}

function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === "string" && (MEMORY_STATUSES as readonly string[]).includes(value);
}

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

function isMemorySensitivity(value: unknown): value is MemorySensitivity {
  return typeof value === "string" && (MEMORY_SENSITIVITIES as readonly string[]).includes(value);
}

function isScopeKindArray(value: unknown): value is MemoryScopeKind[] {
  return Array.isArray(value) && value.every(isMemoryScopeKind);
}

function isStatusArray(value: unknown): value is MemoryStatus[] {
  return Array.isArray(value) && value.every(isMemoryStatus);
}

function isTypeArray(value: unknown): value is MemoryType[] {
  return Array.isArray(value) && value.every(isMemoryType);
}

function isSensitivityArray(value: unknown): value is MemorySensitivity[] {
  return Array.isArray(value) && value.every(isMemorySensitivity);
}

function parseIntQuery(raw: string | null, defaultValue: number, max: number): number {
  if (raw === null) return defaultValue;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return defaultValue;
  return Math.min(n, max);
}

function splitComma(raw: string | null): string[] {
  if (raw === null || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseScope(raw: unknown): MemoryScope | RouteResult {
  if (!isRecord(raw)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "selector.scope must be an object.") };
  }
  if (!validateMemoryScope(raw).ok) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "selector.scope must be a valid memory scope."),
    };
  }
  return raw as MemoryScope;
}

// ─── Body reading ──────────────────────────────────────────────────────────────

class BodyTooLargeError extends Error {
  public constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_MEMORY_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return { status: 413, body: errorBody("PAYLOAD_TOO_LARGE", "Request body too large.") };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body is not valid JSON.") };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body must be a JSON object.") };
  }
  return parsed;
}

function isRouteResult(v: unknown): v is RouteResult {
  return isRecord(v) && typeof v.status === "number";
}

// ─── Vault access ──────────────────────────────────────────────────────────────

// The memory vault is optional in UiHandlerDeps (tests that do not exercise memory routes
// do not need it). At runtime it is created lazily inside the BFF server process.
// Handlers resolve it here; if absent we return 503 so integration tests that run with a
// minimal deps fixture still get a predictable status code rather than a crash.

function resolveVault(deps: UiHandlerDeps): MemoryVaultStore | RouteResult {
  if (deps.memoryVault === undefined) {
    return {
      status: 503,
      body: errorBody("MEMORY_UNAVAILABLE", "Memory vault is not configured."),
    };
  }
  return deps.memoryVault;
}

// ─── Redaction helper ──────────────────────────────────────────────────────────

function redactMemory(deps: UiHandlerDeps, record: MemoryRecord): unknown {
  return deps.redactor(record);
}

function redactMemories(deps: UiHandlerDeps, records: readonly MemoryRecord[]): unknown {
  return deps.redactor(records);
}

// ─── Scope enumeration helper ──────────────────────────────────────────────────
interface ListAcrossScopesOptions {
  readonly scopeKinds?: readonly MemoryScopeKind[];
  readonly types?: readonly MemoryType[];
  readonly statuses?: readonly MemoryStatus[];
  readonly sensitivities?: readonly MemorySensitivity[];
}

function sortMemories(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
  return [...records].sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id.localeCompare(b.id);
  });
}

function listMemoriesAcrossScopes(
  vault: MemoryVaultStore,
  options: ListAcrossScopesOptions,
): readonly MemoryRecord[] {
  const records = vault.listMemories({
    ...(options.types !== undefined && options.types.length > 0 ? { type: options.types } : {}),
    ...(options.statuses !== undefined && options.statuses.length > 0
      ? { status: options.statuses }
      : {}),
    includeExpired: true,
  });
  const filtered = records.filter((record) => {
    if (
      options.scopeKinds !== undefined &&
      options.scopeKinds.length > 0 &&
      !options.scopeKinds.includes(record.scope.kind)
    ) {
      return false;
    }
    if (
      options.sensitivities !== undefined &&
      options.sensitivities.length > 0 &&
      !options.sensitivities.includes(record.provenance.sensitivity)
    ) {
      return false;
    }
    return true;
  });
  return sortMemories(filtered);
}

function isStaleReviewCandidate(record: MemoryRecord): boolean {
  return (
    record.staleReason !== undefined &&
    record.status !== "proposed" &&
    record.status !== "conflicted" &&
    record.status !== "expired" &&
    record.status !== "rejected" &&
    record.status !== "archived" &&
    record.status !== "forgotten"
  );
}

function listReviewQueueMemories(vault: MemoryVaultStore): readonly MemoryRecord[] {
  const byStatus = listMemoriesAcrossScopes(vault, {
    statuses: REVIEW_QUEUE_STATUSES,
  });
  const stale = listMemoriesAcrossScopes(vault, {}).filter(isStaleReviewCandidate);
  const byId = new Map<MemoryId, MemoryRecord>();
  for (const record of [...byStatus, ...stale]) {
    byId.set(record.id, record);
  }
  return sortMemories([...byId.values()]);
}

// ─── Handler: GET /api/memory ─────────────────────────────────────────────────

interface ListParams {
  readonly scopeKinds: string[];
  readonly types: string[];
  readonly statuses: string[];
  readonly sensitivities: string[];
  readonly limit: number;
  readonly offset: number;
}

function parseListParams(ctx: RouteContext): ListParams | RouteResult {
  const scopeKinds = splitComma(ctx.url.searchParams.get("scope"));
  const types = splitComma(ctx.url.searchParams.get("type"));
  const statuses = splitComma(ctx.url.searchParams.get("status"));
  const sensitivities = splitComma(ctx.url.searchParams.get("sensitivity"));

  if (scopeKinds.length > 0 && !isScopeKindArray(scopeKinds)) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", `scope must be a comma-separated list of valid scope kinds.`),
    };
  }
  if (types.length > 0 && !isTypeArray(types)) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", `type must be a comma-separated list of valid memory types.`),
    };
  }
  if (statuses.length > 0 && !isStatusArray(statuses)) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        `status must be a comma-separated list of valid memory statuses.`,
      ),
    };
  }
  if (sensitivities.length > 0 && !isSensitivityArray(sensitivities)) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        `sensitivity must be a comma-separated list of valid sensitivity values.`,
      ),
    };
  }

  return {
    scopeKinds,
    types,
    statuses,
    sensitivities,
    limit: parseIntQuery(ctx.url.searchParams.get("limit"), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    offset: parseIntQuery(ctx.url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER),
  };
}

export function handleListMemories(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const params = parseListParams(ctx);
  if (isRouteResult(params)) return params;

  const { scopeKinds, types, statuses, sensitivities, limit, offset } = params;

  try {
    const filtered = listMemoriesAcrossScopes(vault, {
      ...(scopeKinds.length > 0 ? { scopeKinds: scopeKinds as readonly MemoryScopeKind[] } : {}),
      ...(types.length > 0 ? { types: types as readonly MemoryType[] } : {}),
      ...(statuses.length > 0 ? { statuses: statuses as readonly MemoryStatus[] } : {}),
      ...(sensitivities.length > 0
        ? { sensitivities: sensitivities as readonly MemorySensitivity[] }
        : {}),
    });
    const page = filtered.slice(offset, offset + limit);

    return {
      status: 200,
      body: { memories: redactMemories(deps, page), total: filtered.length, limit, offset },
    };
  } catch (err) {
    if (err instanceof MemoryStorageError) {
      return { status: 500, body: errorBody("MEMORY_ERROR", "Failed to list memories.") };
    }
    throw err;
  }
}

// ─── Handler: GET /api/memory/review-queue ────────────────────────────────────

export function handleMemoryReviewQueue(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  try {
    const proposed = listReviewQueueMemories(vault);
    return {
      status: 200,
      body: {
        memories: redactMemories(deps, proposed),
        total: proposed.length,
      },
    };
  } catch (err) {
    if (err instanceof MemoryStorageError) {
      return { status: 500, body: errorBody("MEMORY_ERROR", "Failed to load review queue.") };
    }
    throw err;
  }
}

// ─── Handler: GET /api/memory/:id ─────────────────────────────────────────────

export function handleGetMemory(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  try {
    const record = vault.getMemory(id as MemoryId);
    if (record === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "Memory not found.") };
    }
    return { status: 200, body: { memory: redactMemory(deps, record) } };
  } catch (err) {
    if (err instanceof MemoryStorageError) {
      return { status: 500, body: errorBody("MEMORY_ERROR", "Failed to read memory.") };
    }
    throw err;
  }
}

// ─── Handler: PATCH /api/memory/:id ───────────────────────────────────────────

interface EditInput {
  readonly newBody: string | undefined;
  readonly tags: unknown;
  readonly sensitivity: unknown;
}

function parseEditInput(raw: Record<string, unknown>): EditInput | RouteResult {
  const { body: newBody, tags, sensitivity } = raw;

  if (newBody === undefined && tags === undefined && sensitivity === undefined) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        "At least one of body, tags, or sensitivity must be provided.",
      ),
    };
  }
  if (newBody !== undefined && (typeof newBody !== "string" || newBody.trim().length === 0)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "body must be a non-empty string.") };
  }
  if (sensitivity !== undefined && !isMemorySensitivity(sensitivity)) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        `sensitivity must be one of: ${MEMORY_SENSITIVITIES.join(", ")}.`,
      ),
    };
  }
  return {
    newBody: typeof newBody === "string" ? newBody : undefined,
    tags,
    sensitivity,
  };
}

function buildEditPatch(input: EditInput, existing: MemoryRecord): Record<string, unknown> {
  const { newBody, tags, sensitivity } = input;
  const patch: Record<string, unknown> = {};
  if (typeof newBody === "string" && newBody.trim().length > 0) {
    patch.body = newBody.trim();
  }
  if (Array.isArray(tags)) {
    patch.tags = tags.filter((t): t is string => typeof t === "string");
  }
  if (isMemorySensitivity(sensitivity)) {
    patch.provenance = { ...existing.provenance, sensitivity };
  }
  return patch;
}

export async function handleEditMemory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  const body = await readJsonBody(ctx.req);
  if (isRouteResult(body)) return body;

  const input = parseEditInput(body);
  if (isRouteResult(input)) return input;

  try {
    const existing = vault.getMemory(id as MemoryId);
    if (existing === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "Memory not found.") };
    }
    const updated = vault.updateMemory(id as MemoryId, buildEditPatch(input, existing), Date.now());
    return { status: 200, body: { memory: redactMemory(deps, updated) } };
  } catch (err) {
    if (err instanceof MemoryStorageError) {
      return {
        status: err.code === "not-found" ? 404 : 500,
        body: errorBody("MEMORY_ERROR", "Failed to update memory."),
      };
    }
    throw err;
  }
}

// ─── Handler: POST /api/memory/:id/pin ────────────────────────────────────────

export function handlePinMemory(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  try {
    const record = vault.getMemory(id as MemoryId);
    if (record === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "Memory not found.") };
    }
    void buildPinOperation(record, { reviewerId: DEFAULT_REVIEWER_ID, nowMs: Date.now() });
    const updated = vault.updateMemory(id as MemoryId, { pinned: true }, Date.now());
    return { status: 200, body: { memory: redactMemory(deps, updated) } };
  } catch (err) {
    if (err instanceof GovernanceError) {
      return {
        status: err.code === "idempotent-noop" ? 409 : 400,
        body: governanceErrorBody(err),
      };
    }
    if (err instanceof MemoryStorageError) {
      return { status: 500, body: errorBody("MEMORY_ERROR", "Failed to pin memory.") };
    }
    throw err;
  }
}

// ─── Handler: POST /api/memory/:id/unpin ──────────────────────────────────────

export function handleUnpinMemory(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  try {
    const record = vault.getMemory(id as MemoryId);
    if (record === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "Memory not found.") };
    }
    void buildUnpinOperation(record, { reviewerId: DEFAULT_REVIEWER_ID, nowMs: Date.now() });
    const updated = vault.updateMemory(id as MemoryId, { pinned: false }, Date.now());
    return { status: 200, body: { memory: redactMemory(deps, updated) } };
  } catch (err) {
    if (err instanceof GovernanceError) {
      return {
        status: err.code === "idempotent-noop" ? 409 : 400,
        body: governanceErrorBody(err),
      };
    }
    if (err instanceof MemoryStorageError) {
      return { status: 500, body: errorBody("MEMORY_ERROR", "Failed to unpin memory.") };
    }
    throw err;
  }
}

// ─── Handler: POST /api/memory/:id/archive ────────────────────────────────────

export async function handleArchiveMemory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  const body = await readJsonBody(ctx.req);
  if (isRouteResult(body)) return body;

  const reason = typeof body.reason === "string" ? body.reason.trim() : undefined;

  try {
    const record = vault.getMemory(id as MemoryId);
    if (record === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "Memory not found.") };
    }
    void buildArchiveOperation(
      record,
      { reviewerId: DEFAULT_REVIEWER_ID, nowMs: Date.now() },
      reason,
    );
    const updated = vault.updateMemory(id as MemoryId, { status: "archived" }, Date.now());
    return { status: 200, body: { memory: redactMemory(deps, updated) } };
  } catch (err) {
    if (err instanceof GovernanceError) {
      return {
        status: 400,
        body: governanceErrorBody(err),
      };
    }
    if (err instanceof MemoryStorageError) {
      return { status: 500, body: errorBody("MEMORY_ERROR", "Failed to archive memory.") };
    }
    throw err;
  }
}

// ─── Handler: POST /api/memory/:id/forget + POST /api/memory/forget ───────────
// The public destructive surfaces all use the same governed path:
//   1. require explicit acknowledgement,
//   2. let the governance selector protect pinned/forgotten records,
//   3. delete with an audit tombstone.

interface DestructiveInput {
  readonly reason: string;
}

interface ForgetSelectionInput extends DestructiveInput {
  readonly selector: ForgetSelector;
}

function parseDestructiveInput(
  raw: Record<string, unknown>,
  defaultReason: string,
): DestructiveInput | RouteResult {
  if (raw.acknowledged !== true) {
    return {
      status: 400,
      body: errorBody(
        "BAD_REQUEST",
        "acknowledged must be true to confirm the destructive operation.",
      ),
    };
  }
  const reason =
    typeof raw.reason === "string" && raw.reason.trim().length > 0
      ? raw.reason.trim()
      : defaultReason;
  return { reason };
}

function parseByIdForgetSelector(raw: Record<string, unknown>): ForgetSelector | RouteResult {
  if (typeof raw.memoryId !== "string" || raw.memoryId.trim().length === 0) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "selector.memoryId must be a non-empty string."),
    };
  }
  return { kind: "by-id", memoryId: raw.memoryId as MemoryId };
}

function parseByScopeForgetSelector(raw: Record<string, unknown>): ForgetSelector | RouteResult {
  const scope = parseScope(raw.scope);
  if (isRouteResult(scope)) return scope;
  return { kind: "by-scope", scope };
}

function parseByTypeForgetSelector(raw: Record<string, unknown>): ForgetSelector | RouteResult {
  const scope = parseScope(raw.scope);
  if (isRouteResult(scope)) return scope;
  if (!isMemoryType(raw.type)) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "selector.type must be a valid memory type."),
    };
  }
  return { kind: "by-type", scope, type: raw.type };
}

function parseBySourceConversationForgetSelector(
  raw: Record<string, unknown>,
): ForgetSelector | RouteResult {
  const scope = parseScope(raw.scope);
  if (isRouteResult(scope)) return scope;
  if (
    typeof raw.sourceConversationId !== "string" ||
    raw.sourceConversationId.trim().length === 0
  ) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "selector.sourceConversationId must be a non-empty string."),
    };
  }
  return {
    kind: "by-source-conversation",
    scope,
    sourceConversationId: raw.sourceConversationId as MemoryConversationId,
  };
}

function parseByTimeWindowForgetSelector(
  raw: Record<string, unknown>,
): ForgetSelector | RouteResult {
  const scope = parseScope(raw.scope);
  if (isRouteResult(scope)) return scope;
  if (
    typeof raw.olderThanMs !== "number" ||
    !Number.isFinite(raw.olderThanMs) ||
    raw.olderThanMs < 0
  ) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "selector.olderThanMs must be a finite non-negative number."),
    };
  }
  return { kind: "by-time-window", scope, olderThanMs: raw.olderThanMs };
}

function parseForgetSelector(raw: unknown): ForgetSelector | RouteResult {
  if (!isRecord(raw)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "selector must be an object.") };
  }
  switch (raw.kind) {
    case "by-id":
      return parseByIdForgetSelector(raw);
    case "by-scope":
      return parseByScopeForgetSelector(raw);
    case "by-type":
      return parseByTypeForgetSelector(raw);
    case "by-source-conversation":
      return parseBySourceConversationForgetSelector(raw);
    case "by-time-window":
      return parseByTimeWindowForgetSelector(raw);
    default:
      return {
        status: 400,
        body: errorBody("BAD_REQUEST", "selector.kind is not supported."),
      };
  }
}

function parseForgetSelectionInput(
  raw: Record<string, unknown>,
): ForgetSelectionInput | RouteResult {
  const destructive = parseDestructiveInput(
    raw,
    "user-initiated selective forget from MemoriaViva",
  );
  if (isRouteResult(destructive)) return destructive;
  const selector = parseForgetSelector(raw.selector);
  if (isRouteResult(selector)) return selector;
  return { ...destructive, selector };
}

function listForgetCandidates(
  vault: MemoryVaultStore,
  selector: ForgetSelector,
): readonly MemoryRecord[] | RouteResult {
  if (selector.kind === "by-id") {
    const record = vault.getMemory(selector.memoryId);
    if (record === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "Memory not found.") };
    }
    return [record];
  }
  return sortMemories(vault.listMemoriesByScope(selector.scope, { includeExpired: true }));
}

function executeForgetSelection(
  vault: MemoryVaultStore,
  selector: ForgetSelector,
  reason: string,
): { readonly memoryIds: readonly MemoryId[] } | RouteResult {
  const nowMs = Date.now();
  const records = listForgetCandidates(vault, selector);
  if (isRouteResult(records)) return records;
  const candidates = selectMemoriesForForget(records, selector, { nowMs });
  if (candidates.length === 0) {
    return {
      status: 409,
      body: errorBody("GOVERNANCE_ERROR", "No matching memories can be forgotten."),
    };
  }
  const operations = buildForgetOperations(
    candidates,
    { reviewerId: DEFAULT_REVIEWER_ID, nowMs },
    { reason, writeTombstone: true },
  );
  vault.deleteMemories(
    operations.map((operation) => ({
      id: operation.memoryId,
      options: {
        tombstone: true,
        reviewerId: operation.reviewerId,
        reason: operation.reason,
        forgetterSurface: "memory-center",
        nowMs: operation.forgottenAt,
      },
    })),
  );
  return { memoryIds: operations.map((operation) => operation.memoryId) };
}

function formatForgetBody(memoryIds: readonly MemoryId[]): Record<string, unknown> {
  return {
    forgotten: true,
    memoryIds,
    count: memoryIds.length,
    ...(memoryIds.length === 1 ? { memoryId: memoryIds[0] } : {}),
  };
}

function memoryMutationErrorBody(err: unknown, fallbackMessage: string): RouteResult {
  if (err instanceof GovernanceError) {
    return { status: 400, body: governanceErrorBody(err) };
  }
  if (err instanceof MemoryStorageError) {
    return {
      status: err.code === "not-found" ? 404 : 500,
      body: errorBody("MEMORY_ERROR", fallbackMessage),
    };
  }
  throw err;
}

export async function handleForgetMemory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  const body = await readJsonBody(ctx.req);
  if (isRouteResult(body)) return body;

  const input = parseDestructiveInput(body, "user-initiated forget from MemoriaViva");
  if (isRouteResult(input)) return input;

  try {
    const result = executeForgetSelection(
      vault,
      { kind: "by-id", memoryId: id as MemoryId },
      input.reason,
    );
    if (isRouteResult(result)) return result;
    return { status: 200, body: formatForgetBody(result.memoryIds) };
  } catch (err) {
    return memoryMutationErrorBody(err, "Failed to forget memory.");
  }
}

export async function handleForgetMemories(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const body = await readJsonBody(ctx.req);
  if (isRouteResult(body)) return body;

  const input = parseForgetSelectionInput(body);
  if (isRouteResult(input)) return input;

  try {
    const result = executeForgetSelection(vault, input.selector, input.reason);
    if (isRouteResult(result)) return result;
    return { status: 200, body: formatForgetBody(result.memoryIds) };
  } catch (err) {
    return memoryMutationErrorBody(err, "Failed to forget memories.");
  }
}

// ─── Handler: DELETE /api/memory/:id ──────────────────────────────────────────
// DELETE is a convenience alias for governed, tombstoned deletion. It does not expose hard delete.

export async function handleDeleteMemory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  const body = await readJsonBody(ctx.req);
  if (isRouteResult(body)) return body;

  const input = parseDestructiveInput(body, "user-initiated delete from MemoriaViva");
  if (isRouteResult(input)) return input;

  try {
    const result = executeForgetSelection(
      vault,
      { kind: "by-id", memoryId: id as MemoryId },
      input.reason,
    );
    if (isRouteResult(result)) return result;
    return {
      status: 200,
      body: {
        deleted: true,
        memoryId: id,
        memoryIds: result.memoryIds,
        count: result.memoryIds.length,
      },
    };
  } catch (err) {
    return memoryMutationErrorBody(err, "Failed to delete memory.");
  }
}

// ─── Handler: POST /api/memory/conflicts/resolve ──────────────────────────────

interface ConflictResolutionInput {
  readonly winner: MemoryId;
  readonly losers: readonly MemoryId[];
  readonly reason: string;
}

function uniqueIds(ids: readonly MemoryId[]): readonly MemoryId[] {
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

function parseConflictResolutionInput(
  raw: Record<string, unknown>,
): ConflictResolutionInput | RouteResult {
  if (typeof raw.winner !== "string" || raw.winner.trim().length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "winner must be a non-empty string.") };
  }
  if (
    !Array.isArray(raw.losers) ||
    raw.losers.length === 0 ||
    !raw.losers.every((id): id is string => typeof id === "string" && id.trim().length > 0)
  ) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "losers must be a non-empty string array."),
    };
  }
  const reason =
    typeof raw.reason === "string" && raw.reason.trim().length > 0
      ? raw.reason.trim()
      : "conflict resolved from MemoriaViva";
  const winner = raw.winner as MemoryId;
  const losers = raw.losers.map((id) => id as MemoryId);
  if (uniqueIds([winner, ...losers]).length !== 1 + losers.length) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "winner and losers must be unique memory ids."),
    };
  }
  return {
    winner,
    losers,
    reason,
  };
}

function loadConflictMemories(
  vault: MemoryVaultStore,
  input: ConflictResolutionInput,
): readonly MemoryRecord[] | RouteResult {
  const records: MemoryRecord[] = [];
  for (const id of uniqueIds([input.winner, ...input.losers])) {
    const record = vault.getMemory(id);
    if (record === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "Memory not found.") };
    }
    records.push(record);
  }
  return records;
}

function scopeKey(scope: MemoryScope): string {
  switch (scope.kind) {
    case "user":
      return `user:${scope.userId}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
    case "project":
      return `project:${scope.projectId}`;
    case "workflow":
      return `workflow:${scope.workflowDefinitionId}`;
    case "global":
      return "global";
  }
}

function validateConflictPairForResolution(winner: MemoryRecord, loser: MemoryRecord): void {
  if (winner.type !== loser.type || scopeKey(winner.scope) !== scopeKey(loser.scope)) {
    throw new GovernanceError(
      "invalid-resolution",
      "conflict resolution requires memories with the same scope and type",
    );
  }
  const conflict = detectConflictPair(winner, loser);
  if (!conflict.hasConflict) {
    throw new GovernanceError(
      "invalid-resolution",
      "conflict resolution requires an actual detected conflict",
    );
  }
}

function validateConflictResolutionMemories(
  memories: readonly MemoryRecord[],
  input: ConflictResolutionInput,
): void {
  const winner = findMemoryById(memories, input.winner);
  if (winner === undefined) {
    throw new GovernanceError("invalid-resolution", "winner is not loaded");
  }
  for (const loserId of input.losers) {
    const loser = findMemoryById(memories, loserId);
    if (loser === undefined) {
      throw new GovernanceError("invalid-resolution", "loser is not loaded");
    }
    validateConflictPairForResolution(winner, loser);
  }
}

function buildEdgeFromSupersession(supersession: MemorySupersession): MemoryEdge {
  return {
    id: randomUUID() as MemoryEdgeId,
    schemaVersion: "1",
    fromMemoryId: supersession.oldMemoryId,
    toMemoryId: supersession.newMemoryId,
    kind: supersession.edgeKind,
    createdAt: supersession.supersededAt,
    provenanceSummary: supersession.reason,
  };
}

function findMemoryById(memories: readonly MemoryRecord[], id: MemoryId): MemoryRecord | undefined {
  return memories.find((memory) => memory.id === id);
}

function persistConflictTransitions(
  vault: MemoryVaultStore,
  resolution: ReturnType<typeof buildConflictTransitions>,
  reason: string,
): void {
  for (const transition of resolution.statusTransitions) {
    vault.updateMemory(
      transition.memoryId,
      { status: transition.to, staleReason: reason },
      transition.transitionedAt,
    );
  }
}

function persistConflictSupersessions(
  vault: MemoryVaultStore,
  deps: UiHandlerDeps,
  memories: readonly MemoryRecord[],
  supersessions: readonly MemorySupersession[],
  nowMs: number,
): readonly MemoryEdgeId[] {
  const edgeIds: MemoryEdgeId[] = [];
  for (const supersession of supersessions) {
    const edge = vault.insertEdge(buildEdgeFromSupersession(supersession));
    edgeIds.push(edge.id);
    const loser = findMemoryById(memories, supersession.oldMemoryId);
    const winner = findMemoryById(memories, supersession.newMemoryId);
    if (loser === undefined || winner === undefined) continue;
    recordSupersessionAudit(
      deps,
      loser,
      winner,
      nowMs,
      "Conflict resolution linked losing memory to the selected winner.",
    );
  }
  return edgeIds;
}

function executeConflictResolution(
  vault: MemoryVaultStore,
  deps: UiHandlerDeps,
  input: ConflictResolutionInput,
): Record<string, unknown> | RouteResult {
  const memories = loadConflictMemories(vault, input);
  if (isRouteResult(memories)) return memories;
  validateConflictResolutionMemories(memories, input);
  const nowMs = Date.now();
  const resolution = buildConflictTransitions(
    memories,
    { winner: input.winner, losers: input.losers },
    { reviewerId: DEFAULT_REVIEWER_ID, nowMs },
  );
  persistConflictTransitions(vault, resolution, input.reason);
  const edgeIds = persistConflictSupersessions(
    vault,
    deps,
    memories,
    resolution.supersessions,
    nowMs,
  );
  return {
    resolved: true,
    winner: input.winner,
    losers: input.losers,
    supersessionEdgeIds: edgeIds,
    transitions: resolution.statusTransitions,
  };
}

export async function handleResolveMemoryConflict(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const body = await readJsonBody(ctx.req);
  if (isRouteResult(body)) return body;

  const input = parseConflictResolutionInput(body);
  if (isRouteResult(input)) return input;

  try {
    const result = executeConflictResolution(vault, deps, input);
    if (isRouteResult(result)) return result;
    return { status: 200, body: result };
  } catch (err) {
    return memoryMutationErrorBody(err, "Failed to resolve conflict.");
  }
}

// ─── Handler: POST /api/memory/:id/correct ────────────────────────────────────
// A correction creates a new "proposed" correction-type memory and links it to the old one.

function parseCorrectInput(raw: Record<string, unknown>): { correctedBody: string } | RouteResult {
  const correctedBody = typeof raw.body === "string" ? raw.body.trim() : "";
  if (correctedBody.length === 0) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "body must be a non-empty string for the corrected memory."),
    };
  }
  return { correctedBody };
}

function buildCorrectionRecord(
  proposal: MemoryProposal,
  id: MemoryId,
  nowMs: number,
): MemoryRecord {
  // Note: exactOptionalPropertyTypes is on — omit staleReason rather than assigning undefined.
  const base = {
    id,
    schemaVersion: "1",
    scope: proposal.scope,
    type: proposal.type,
    body: proposal.body,
    provenance: proposal.provenance,
    validity: proposal.validity,
    status: proposal.initialStatus,
    pinned: false,
    tags: proposal.tags,
    createdAt: nowMs,
    updatedAt: nowMs,
  } satisfies Omit<MemoryRecord, "payload" | "retentionHint" | "staleReason">;
  return {
    ...base,
    ...(proposal.payload === undefined ? {} : { payload: proposal.payload }),
    ...(proposal.retentionHint === undefined ? {} : { retentionHint: proposal.retentionHint }),
  };
}

function redactString(deps: UiHandlerDeps, value: string): string {
  const redacted = deps.redactor(value);
  return typeof redacted === "string" ? redacted : value;
}

function recordSupersessionAudit(
  deps: UiHandlerDeps,
  oldMemory: MemoryRecord,
  newMemory: MemoryRecord,
  nowMs: number,
  summary: string,
): void {
  const event: MemoryAuditEvent = {
    schemaVersion: "1",
    kind: "memory:superseded",
    eventId: randomUUID(),
    occurredAt: nowMs,
    initiatorSurface: "memory-center",
    summary,
    oldMemoryId: oldMemory.id,
    newMemoryId: newMemory.id,
    scope: oldMemory.scope,
  };
  recordMemoryAudit(
    { evidenceStore: deps.evidenceStore, redactString: (value) => redactString(deps, value) },
    event,
  );
}

function auditEventCountForDay(deps: UiHandlerDeps, nowMs: number): number {
  const json = deps.evidenceStore.get(auditRunIdFor(nowMs));
  if (json === undefined) {
    return 0;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function recordCorrectionProposalAuditIfNeeded(
  deps: UiHandlerDeps,
  inserted: MemoryRecord,
  nowMs: number,
  countBeforeInsert: number,
): void {
  if (auditEventCountForDay(deps, nowMs) > countBeforeInsert) {
    return;
  }
  const event: MemoryAuditEvent = {
    schemaVersion: "1",
    kind: "memory:proposed",
    eventId: randomUUID(),
    occurredAt: nowMs,
    initiatorSurface: "memory-center",
    summary: `memory ${inserted.id} correction proposed`,
    memoryId: inserted.id,
    scope: inserted.scope,
  };
  recordMemoryAudit(
    { evidenceStore: deps.evidenceStore, redactString: (value) => redactString(deps, value) },
    event,
  );
}

export async function handleCorrectMemory(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  const body = await readJsonBody(ctx.req);
  if (isRouteResult(body)) return body;

  const input = parseCorrectInput(body);
  if (isRouteResult(input)) return input;

  try {
    const existing = vault.getMemory(id as MemoryId);
    if (existing === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "Memory not found.") };
    }
    const nowMs = Date.now();
    const correctionId = randomUUID() as MemoryId;
    const { proposal, supersession } = buildCorrection({
      olderMemory: existing,
      correctedBody: input.correctedBody,
      context: { reviewerId: DEFAULT_REVIEWER_ID, nowMs },
      newProposalId: randomUUID() as MemoryProposalId,
      newMemoryId: correctionId,
    });
    const auditCountBeforeInsert = auditEventCountForDay(deps, nowMs);
    const inserted = vault.insertMemory(buildCorrectionRecord(proposal, correctionId, nowMs));
    recordCorrectionProposalAuditIfNeeded(deps, inserted, nowMs, auditCountBeforeInsert);
    vault.insertEdge(buildEdgeFromSupersession(supersession));
    return {
      status: 201,
      body: { correction: redactMemory(deps, inserted), originalMemoryId: id },
    };
  } catch (err) {
    if (err instanceof GovernanceError) {
      return { status: 400, body: governanceErrorBody(err) };
    }
    if (err instanceof MemoryStorageError) {
      return { status: 500, body: errorBody("MEMORY_ERROR", "Failed to create correction.") };
    }
    throw err;
  }
}

// ─── Handler: POST /api/memory/proposals/:id/accept ───────────────────────────

function assertSupersedable(memory: MemoryRecord): void {
  const check = checkStatusTransition(memory.status, "superseded");
  if (!check.ok) {
    throw new GovernanceError(
      "illegal-status-transition",
      check.reason ?? `illegal transition: ${memory.status} -> superseded`,
    );
  }
}

interface CorrectionSupersessionOrigin {
  readonly edge: MemoryEdge;
  readonly original: MemoryRecord;
}

function loadCorrectionSupersessionOrigins(
  vault: MemoryVaultStore,
  proposal: MemoryRecord,
): readonly CorrectionSupersessionOrigin[] {
  if (proposal.type !== "correction") return [];
  const incomingSupersessions = vault
    .listIncomingEdges(proposal.id)
    .filter((edge) => edge.kind === "supersedes");
  if (incomingSupersessions.length === 0) {
    throw new GovernanceError(
      "invalid-resolution",
      "correction proposal requires a supersession origin",
    );
  }
  return incomingSupersessions.map((edge) => {
    const original = vault.getMemory(edge.fromMemoryId);
    if (original === undefined) {
      throw new GovernanceError("invalid-resolution", "correction origin memory is missing");
    }
    return { edge, original };
  });
}

function acceptedCorrectionType(
  origins: readonly CorrectionSupersessionOrigin[],
): MemoryType | undefined {
  if (origins.length === 0) return undefined;
  const first = origins[0]?.original.type;
  if (first === undefined) return undefined;
  for (const origin of origins) {
    if (origin.original.type !== first) {
      throw new GovernanceError(
        "invalid-resolution",
        "correction origins must have the same memory type",
      );
    }
    assertSupersedable(origin.original);
  }
  return first;
}

function buildAcceptProposalPatch(origins: readonly CorrectionSupersessionOrigin[]): {
  readonly status: "accepted";
  readonly type?: MemoryType;
} {
  const correctionType = acceptedCorrectionType(origins);
  return correctionType === undefined
    ? { status: "accepted" }
    : { status: "accepted", type: correctionType };
}

function buildCorrectionAcceptanceUpdates(
  proposalId: MemoryId,
  acceptPatch: MemoryBatchUpdate["patch"],
  origins: readonly CorrectionSupersessionOrigin[],
  nowMs: number,
): readonly MemoryBatchUpdate[] {
  return [
    { id: proposalId, patch: acceptPatch, nowMs },
    ...origins.map(({ edge, original }) => ({
      id: original.id,
      patch: {
        status: "superseded" as const,
        staleReason: edge.provenanceSummary ?? "accepted correction",
      },
      nowMs,
    })),
  ];
}

function recordCorrectionSupersessionAudits(
  deps: UiHandlerDeps,
  acceptedCorrection: MemoryRecord,
  origins: readonly CorrectionSupersessionOrigin[],
  nowMs: number,
): void {
  for (const { original } of origins) {
    recordSupersessionAudit(
      deps,
      original,
      acceptedCorrection,
      nowMs,
      "Accepted correction superseded the original memory.",
    );
  }
}

function ensureProposedMemory(existing: MemoryRecord | undefined): MemoryRecord | RouteResult {
  if (existing === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Memory proposal not found.") };
  }
  if (existing.status !== "proposed") {
    return {
      status: 409,
      body: errorBody("CONFLICT", "Memory is not in proposed status."),
    };
  }
  return existing;
}

function acceptMemoryProposal(
  vault: MemoryVaultStore,
  deps: UiHandlerDeps,
  id: MemoryId,
): RouteResult {
  const existing = ensureProposedMemory(vault.getMemory(id));
  if (isRouteResult(existing)) return existing;
  const nowMs = Date.now();
  const origins = loadCorrectionSupersessionOrigins(vault, existing);
  const acceptPatch = buildAcceptProposalPatch(origins);
  const updates = buildCorrectionAcceptanceUpdates(id, acceptPatch, origins, nowMs);
  const [updated] = vault.updateMemories(updates);
  if (updated === undefined) {
    throw new GovernanceError("invalid-resolution", "acceptance update produced no records");
  }
  recordCorrectionSupersessionAudits(deps, updated, origins, nowMs);
  return { status: 200, body: { memory: redactMemory(deps, updated) } };
}

export function handleAcceptMemoryProposal(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  try {
    return acceptMemoryProposal(vault, deps, id as MemoryId);
  } catch (err) {
    return memoryMutationErrorBody(err, "Failed to accept proposal.");
  }
}

// ─── Handler: POST /api/memory/proposals/:id/reject ───────────────────────────

function parseRejectInput(raw: Record<string, unknown>): { reason: string } {
  const reason =
    typeof raw.reason === "string" && raw.reason.trim().length > 0
      ? raw.reason.trim()
      : "rejected by user";
  return { reason };
}

function ensureRejectableMemory(existing: MemoryRecord | undefined): RouteResult | MemoryRecord {
  if (existing === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Memory proposal not found.") };
  }
  if (existing.status !== "proposed" && existing.status !== "conflicted") {
    return {
      status: 409,
      body: errorBody("CONFLICT", "Memory is not in proposed or conflicted status."),
    };
  }
  return existing;
}

export async function handleRejectMemoryProposal(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  const body = await readJsonBody(ctx.req);
  if (isRouteResult(body)) return body;

  const { reason } = parseRejectInput(body);

  try {
    const existing = ensureRejectableMemory(vault.getMemory(id as MemoryId));
    if (isRouteResult(existing)) return existing;
    const updated = vault.updateMemory(
      id as MemoryId,
      { status: "rejected", staleReason: reason },
      Date.now(),
    );
    return { status: 200, body: { memory: redactMemory(deps, updated) } };
  } catch (err) {
    if (err instanceof MemoryStorageError) {
      return {
        status: err.code === "not-found" ? 404 : 500,
        body: errorBody("MEMORY_ERROR", "Failed to reject proposal."),
      };
    }
    throw err;
  }
}

// ─── Vault factory helper (called by buildUiHandlerDeps) ──────────────────────
// Exported so deps.ts can wire it without importing the vault directly. The `redactString`
// is the same closure used by the audit redactor; re-using it here keeps redaction in one
// place (D9).

export function createBffMemoryVault(
  redactString: (s: string) => string,
  onMemoryEvent?: (event: import("@oscharko-dev/keiko-memory-vault").MemoryEvent) => void,
  env?: Readonly<Record<string, string | undefined>>,
): MemoryVaultStore {
  // Optional onMemoryEvent (#214) wires every successful vault mutation into the audit
  // ledger. When undefined, the vault still fires its internal NOOP sink, so the absence
  // of an audit hook is fully backward-compatible with the pre-#214 BFF wiring.
  return createMemoryVault({
    redactString,
    ...(onMemoryEvent === undefined ? {} : { onMemoryEvent }),
    ...(env === undefined ? {} : { env }),
  });
}
