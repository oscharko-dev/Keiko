// Issue #212 — Conversation Center memory BFF.
//
// Two routes that let the Conversation Center compose enterprise memory WITHOUT importing
// any memory-domain package directly (ADR-0019 rule 8 keeps the browser/UI tier away from
// the domain). Both routes go through the existing redactor (D9) before serialisation.
//
//   POST /api/memory/context
//     Body: { scopes, queryText?, types?, budgetTokens? }
//     Returns the MemoryRetrievalResult envelope (contextBlock + included + omitted + budget).
//     Wraps `retrieveMemoryContext` from keiko-memory-retrieval.
//
//   POST /api/memory/capture-from-conversation
//     Body: { text, context: { userId, workspaceId?, projectId?, conversationId? } }
//     Returns { outcomes: CaptureOutcome[] }. Pure call to keiko-memory-capture's
//     `extractCandidatesFromUserText`. Persistence of accepted candidates stays on the
//     existing /api/memory/proposals/:id/accept route from #211 (see follow-up note in the
//     #212 PR for the candidate-persistence wiring).
//
// CSRF: enforced for POST methods by the server dispatch layer in server.ts. Handlers do
// NOT re-check.
//
// File budget: keep under 400 LOC per coordinator quality rules.

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  retrieveMemoryContext,
  type MemoryQueryPort,
  type MemoryRetrievalRequest,
} from "@oscharko-dev/keiko-memory-retrieval";
import {
  extractCandidatesFromUserText,
  type CaptureContext,
  type CaptureOutcome,
} from "@oscharko-dev/keiko-memory-capture";
import { MEMORY_SCOPE_KINDS, MEMORY_TYPES } from "@oscharko-dev/keiko-contracts";
import type {
  MemoryId,
  MemoryProposalId,
  MemoryRecord,
  MemoryScope,
  MemoryScopeKind,
  MemoryType,
  ProjectId,
  UserId,
  WorkspaceId,
  ConversationId,
  WorkflowDefinitionId,
} from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { createMemoryTargetResolver } from "./memory-target-resolver.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 64_000;

// ─── Body reading (mirrors memory-handlers.ts pattern) ────────────────────────

class BodyTooLargeError extends Error {
  public constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
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

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number";
}

function resolveVault(deps: UiHandlerDeps): MemoryVaultStore | RouteResult {
  if (deps.memoryVault === undefined) {
    return {
      status: 503,
      body: errorBody("MEMORY_UNAVAILABLE", "Memory vault is not configured."),
    };
  }
  return deps.memoryVault;
}

// ─── /api/memory/context — scope parsing ──────────────────────────────────────

function isScopeKind(value: unknown): value is MemoryScopeKind {
  return typeof value === "string" && (MEMORY_SCOPE_KINDS as readonly string[]).includes(value);
}

// Per-kind parsers keep `parseScope` under the complexity cap by isolating each kind's
// string-typed coordinate read. Each parser receives the already-narrowed record and returns
// either the typed scope or null when its coordinate is missing or non-string.
type ScopeParser = (raw: Record<string, unknown>) => MemoryScope | null;

function readString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const SCOPE_PARSERS: Readonly<Record<MemoryScopeKind, ScopeParser>> = {
  user: (raw) => {
    const id = readString(raw, "userId");
    return id === null ? null : { kind: "user", userId: id as UserId };
  },
  workspace: (raw) => {
    const id = readString(raw, "workspaceId");
    return id === null ? null : { kind: "workspace", workspaceId: id as WorkspaceId };
  },
  project: (raw) => {
    const id = readString(raw, "projectId");
    return id === null ? null : { kind: "project", projectId: id as ProjectId };
  },
  workflow: (raw) => {
    const id = readString(raw, "workflowDefinitionId");
    return id === null
      ? null
      : { kind: "workflow", workflowDefinitionId: id as WorkflowDefinitionId };
  },
  global: () => ({ kind: "global" }),
};

function parseScope(raw: unknown): MemoryScope | null {
  if (!isRecord(raw) || !isScopeKind(raw.kind)) return null;
  return SCOPE_PARSERS[raw.kind](raw);
}

function parseScopes(raw: unknown): readonly MemoryScope[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: MemoryScope[] = [];
  for (const r of raw) {
    const scope = parseScope(r);
    if (scope === null) return null;
    out.push(scope);
  }
  return out;
}

function parseTypes(raw: unknown): readonly MemoryType[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const out: MemoryType[] = [];
  for (const r of raw) {
    if (typeof r !== "string" || !(MEMORY_TYPES as readonly string[]).includes(r)) {
      return null;
    }
    out.push(r as MemoryType);
  }
  return out;
}

export function vaultAsQueryPort(vault: MemoryVaultStore): MemoryQueryPort {
  // Retrieval must see expired rows so it can omit them with a concrete suppression reason
  // instead of having storage silently drop them. Archived/forgotten rows already come back
  // from the vault by default and are suppressed later by the retrieval layer.
  return {
    listByScope: (scope, options): readonly MemoryRecord[] => {
      const limit = options?.maxResults;
      return vault.listMemoriesByScope(scope, {
        includeExpired: true,
        ...(limit === undefined ? {} : { limit }),
      });
    },
    listOutgoingEdges: (memoryId) => vault.listOutgoingEdges(memoryId),
    listIncomingEdges: (memoryId) => vault.listIncomingEdges(memoryId),
  };
}

interface ContextInput {
  readonly scopes: readonly MemoryScope[];
  readonly queryText: string | undefined;
  readonly types: readonly MemoryType[] | undefined;
  readonly budgetTokens: number | undefined;
}

function parseOptionalQueryText(raw: Record<string, unknown>): string | RouteResult | undefined {
  if (raw.queryText === undefined) return undefined;
  if (typeof raw.queryText !== "string") {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "queryText must be a string when provided."),
    };
  }
  return raw.queryText;
}

function parseOptionalBudgetTokens(raw: Record<string, unknown>): number | RouteResult | undefined {
  if (raw.budgetTokens === undefined) return undefined;
  if (
    typeof raw.budgetTokens !== "number" ||
    !Number.isFinite(raw.budgetTokens) ||
    !Number.isInteger(raw.budgetTokens) ||
    raw.budgetTokens < 0
  ) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "budgetTokens must be a non-negative integer."),
    };
  }
  return raw.budgetTokens;
}

function parseContextInput(raw: Record<string, unknown>): ContextInput | RouteResult {
  const scopes = parseScopes(raw.scopes);
  if (scopes === null) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "scopes must be a non-empty array of valid MemoryScope."),
    };
  }
  const types = parseTypes(raw.types);
  if (raw.types !== undefined && types === null) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", `types must be an array of: ${MEMORY_TYPES.join(", ")}.`),
    };
  }
  const queryText = parseOptionalQueryText(raw);
  if (isRouteResult(queryText)) return queryText;
  const budgetTokens = parseOptionalBudgetTokens(raw);
  if (isRouteResult(budgetTokens)) return budgetTokens;
  return {
    scopes,
    queryText: queryText ?? undefined,
    types: types ?? undefined,
    budgetTokens: budgetTokens ?? undefined,
  };
}

function buildRetrievalRequest(input: ContextInput): MemoryRetrievalRequest {
  // exactOptionalPropertyTypes: omit undefined fields instead of assigning them.
  const req: {
    scopes: readonly MemoryScope[];
    nowMs: number;
    queryText?: string;
    types?: readonly MemoryType[];
    budgetTokens?: number;
  } = {
    scopes: input.scopes,
    nowMs: Date.now(),
  };
  if (input.queryText !== undefined) req.queryText = input.queryText;
  if (input.types !== undefined) req.types = input.types;
  if (input.budgetTokens !== undefined) req.budgetTokens = input.budgetTokens;
  return req;
}

export async function handleMemoryRetrieveContext(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;
  const body = await readJsonBody(ctx.req);
  if (isRouteResult(body)) return body;
  const input = parseContextInput(body);
  if (isRouteResult(input)) return input;

  const port = vaultAsQueryPort(vault);
  const result = retrieveMemoryContext(buildRetrievalRequest(input), port);
  // Redact the entire envelope (contextBlock.text, memory excerpts, inclusion reasons).
  // We deliberately do NOT echo `result.request` back: it carries no fresh info beyond what
  // the caller posted and bloats the wire payload.
  return {
    status: 200,
    body: deps.redactor({
      contextBlock: result.contextBlock,
      included: result.included,
      omitted: result.omitted,
      budget: result.budget,
    }),
  };
}

// ─── /api/memory/capture-from-conversation ────────────────────────────────────

interface CaptureInputContext {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId | undefined;
  readonly projectId: ProjectId | undefined;
  readonly conversationId: ConversationId | undefined;
}

function optionalId(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseCaptureContext(raw: unknown): CaptureInputContext | RouteResult {
  if (!isRecord(raw)) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "context must be an object with a non-empty userId."),
    };
  }
  const userId = typeof raw.userId === "string" && raw.userId.length > 0 ? raw.userId : null;
  if (userId === null) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "context.userId must be a non-empty string."),
    };
  }
  return {
    userId: userId as UserId,
    workspaceId: optionalId(raw, "workspaceId") as WorkspaceId | undefined,
    projectId: optionalId(raw, "projectId") as ProjectId | undefined,
    conversationId: optionalId(raw, "conversationId") as ConversationId | undefined,
  };
}

interface CaptureInput {
  readonly text: string;
  readonly context: CaptureInputContext;
}

function parseCaptureInput(raw: Record<string, unknown>): CaptureInput | RouteResult {
  const text = typeof raw.text === "string" ? raw.text : "";
  if (text.trim().length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "text must be a non-empty string.") };
  }
  const context = parseCaptureContext(raw.context);
  if (isRouteResult(context)) return context;
  return {
    text,
    context,
  };
}

function buildCaptureContext(input: CaptureInputContext): CaptureContext {
  // exactOptionalPropertyTypes — only set fields when present.
  const base: {
    userId: UserId;
    nowMs: number;
    newMemoryId: () => MemoryId;
    newProposalId: () => MemoryProposalId;
    workspaceId?: WorkspaceId;
    projectId?: ProjectId;
    conversationId?: ConversationId;
  } = {
    userId: input.userId,
    nowMs: Date.now(),
    newMemoryId: () => randomUUID() as MemoryId,
    newProposalId: () => randomUUID() as MemoryProposalId,
  };
  if (input.workspaceId !== undefined) base.workspaceId = input.workspaceId;
  if (input.projectId !== undefined) base.projectId = input.projectId;
  if (input.conversationId !== undefined) base.conversationId = input.conversationId;
  return base;
}

export async function handleMemoryCaptureFromConversation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;
  const body = await readJsonBody(ctx.req);
  if (isRouteResult(body)) return body;
  const input = parseCaptureInput(body);
  if (isRouteResult(input)) return input;

  const captureContext = buildCaptureContext(input.context);
  const outcomes: readonly CaptureOutcome[] = extractCandidatesFromUserText(
    input.text,
    captureContext,
    { resolver: createMemoryTargetResolver(vault) },
  );
  // Redact every outcome (proposal bodies may carry user text that needs scrubbing).
  return { status: 200, body: deps.redactor({ outcomes }) };
}
