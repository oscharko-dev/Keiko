// Memory Center BFF route handlers (Issue #211 / Epic #204).
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
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import {
  GovernanceError,
  buildArchiveOperation,
  buildForgetOperations,
  buildPinOperation,
  buildUnpinOperation,
  selectMemoriesForForget,
} from "@oscharko-dev/keiko-memory-governance";
import {
  MEMORY_SCOPE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  MEMORY_SENSITIVITIES,
  type MemoryId,
  type MemoryRecord,
  type MemoryReviewerId,
  type MemoryScopeKind,
  type MemorySensitivity,
  type MemoryStatus,
  type MemoryType,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MEMORY_BODY_BYTES = 64_000;
const DEFAULT_REVIEWER_ID = "memory-center-ui" as MemoryReviewerId;
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const REVIEW_QUEUE_STATUSES: readonly MemoryStatus[] = ["proposed", "conflicted"];

// ─── Type guards / helpers ─────────────────────────────────────────────────────

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
    const proposed = listMemoriesAcrossScopes(vault, {
      statuses: REVIEW_QUEUE_STATUSES,
    });
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
        body: errorBody("GOVERNANCE_ERROR", err.message),
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
        body: errorBody("GOVERNANCE_ERROR", err.message),
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
        body: errorBody("GOVERNANCE_ERROR", err.message),
      };
    }
    if (err instanceof MemoryStorageError) {
      return { status: 500, body: errorBody("MEMORY_ERROR", "Failed to archive memory.") };
    }
    throw err;
  }
}

// ─── Handler: POST /api/memory/:id/forget ─────────────────────────────────────
// "forget" transitions the record to status "forgotten" — the storage layer then tombstones it.
// The user must supply `{ acknowledged: true }` in the request body.

interface ForgetInput {
  readonly reason: string;
}

function parseForgetInput(raw: Record<string, unknown>): ForgetInput | RouteResult {
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
      : "user-initiated forget from Memory Center";
  return { reason };
}

function executeForget(vault: MemoryVaultStore, id: string, reason: string): RouteResult {
  const record = vault.getMemory(id as MemoryId);
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Memory not found.") };
  }
  const nowMs = Date.now();
  const candidates = selectMemoriesForForget(
    [record],
    { kind: "by-id", memoryId: id as MemoryId },
    { nowMs },
  );
  if (candidates.length === 0) {
    return {
      status: 409,
      body: errorBody("GOVERNANCE_ERROR", "Memory cannot be forgotten (it may be pinned)."),
    };
  }
  buildForgetOperations(
    candidates,
    { reviewerId: DEFAULT_REVIEWER_ID, nowMs },
    { reason, writeTombstone: true },
  );
  vault.deleteMemory(id as MemoryId, {
    tombstone: true,
    reason,
    forgetterSurface: "memory-center",
    nowMs,
  });
  return { status: 200, body: { forgotten: true, memoryId: id } };
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

  const input = parseForgetInput(body);
  if (isRouteResult(input)) return input;

  try {
    return executeForget(vault, id, input.reason);
  } catch (err) {
    if (err instanceof GovernanceError) {
      return { status: 400, body: errorBody("GOVERNANCE_ERROR", err.message) };
    }
    if (err instanceof MemoryStorageError) {
      return {
        status: err.code === "not-found" ? 404 : 500,
        body: errorBody("MEMORY_ERROR", "Failed to forget memory."),
      };
    }
    throw err;
  }
}

// ─── Handler: DELETE /api/memory/:id ──────────────────────────────────────────
// Hard delete without a tombstone. Intended for admin / data cleanup.

export function handleDeleteMemory(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  try {
    const existing = vault.getMemory(id as MemoryId);
    if (existing === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "Memory not found.") };
    }
    vault.deleteMemory(id as MemoryId, {
      tombstone: false,
      forgetterSurface: "memory-center",
      nowMs: Date.now(),
    });
    return { status: 200, body: { deleted: true, memoryId: id } };
  } catch (err) {
    if (err instanceof MemoryStorageError) {
      return {
        status: err.code === "not-found" ? 404 : 500,
        body: errorBody("MEMORY_ERROR", "Failed to delete memory."),
      };
    }
    throw err;
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
  existing: MemoryRecord,
  correctedBody: string,
  nowMs: number,
): MemoryRecord {
  // Note: exactOptionalPropertyTypes is on — omit staleReason rather than assigning undefined.
  return {
    id: randomUUID() as MemoryId,
    schemaVersion: "1",
    scope: existing.scope,
    type: "correction",
    body: correctedBody,
    provenance: {
      ...existing.provenance,
      sourceKind: "accepted-correction",
      capturedAt: nowMs,
    },
    validity: existing.validity,
    status: "proposed",
    pinned: false,
    tags: existing.tags,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
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
    const inserted = vault.insertMemory(
      buildCorrectionRecord(existing, input.correctedBody, Date.now()),
    );
    return {
      status: 201,
      body: { correction: redactMemory(deps, inserted), originalMemoryId: id },
    };
  } catch (err) {
    if (err instanceof MemoryStorageError) {
      return { status: 500, body: errorBody("MEMORY_ERROR", "Failed to create correction.") };
    }
    throw err;
  }
}

// ─── Handler: POST /api/memory/proposals/:id/accept ───────────────────────────

export function handleAcceptMemoryProposal(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;

  const { id } = ctx.params;
  if (id === undefined || id.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Memory id is required.") };
  }

  try {
    const existing = vault.getMemory(id as MemoryId);
    if (existing === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "Memory proposal not found.") };
    }
    if (existing.status !== "proposed") {
      return {
        status: 409,
        body: errorBody("CONFLICT", "Memory is not in proposed status."),
      };
    }
    const updated = vault.updateMemory(id as MemoryId, { status: "accepted" }, Date.now());
    return { status: 200, body: { memory: redactMemory(deps, updated) } };
  } catch (err) {
    if (err instanceof MemoryStorageError) {
      return {
        status: err.code === "not-found" ? 404 : 500,
        body: errorBody("MEMORY_ERROR", "Failed to accept proposal."),
      };
    }
    throw err;
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
): MemoryVaultStore {
  // Optional onMemoryEvent (#214) wires every successful vault mutation into the audit
  // ledger. When undefined, the vault still fires its internal NOOP sink, so the absence
  // of an audit hook is fully backward-compatible with the pre-#214 BFF wiring.
  if (onMemoryEvent === undefined) {
    return createMemoryVault({ redactString });
  }
  return createMemoryVault({ redactString, onMemoryEvent });
}
