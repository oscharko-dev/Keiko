// Issue #212 — Conversation Center memory BFF.
//
// Two routes that let the Conversation Center compose enterprise memory WITHOUT importing
// any memory-domain package directly (ADR-0019 rule 8 keeps the browser/UI tier away from
// the domain). Both routes go through the existing redactor (D9) before serialisation.
//
//   POST /api/memory/context
//     Body: { projectPath, chatId, queryText?, types?, budgetTokens? }
//     Returns the MemoryRetrievalResult envelope (contextBlock + included + omitted + budget).
//     Wraps `retrieveMemoryContext` from keiko-memory-retrieval.
//
//   POST /api/memory/capture-from-conversation
//     Body: { text, context: { projectPath, chatId } }
//     Returns { outcomes: CaptureOutcome[] }. Calls keiko-memory-capture's
//     `extractCandidatesFromUserText` and persists each `candidate` outcome as a `proposed`
//     memory record via the shared `buildMemoryRecordFromProposal` builder so the existing
//     /api/memory/proposals/:id/accept route from #211 can transition the proposal to accepted
//     (issue #642).
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
import { MEMORY_TYPES } from "@oscharko-dev/keiko-contracts";
import type {
  MemoryAuditEvent,
  MemoryId,
  MemoryProposalId,
  MemoryRecord,
  MemoryScope,
  MemoryType,
} from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { createMemoryTargetResolver } from "./memory-target-resolver.js";
import {
  conversationMemoryScopes,
  resolveConversationMemoryContext,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { recordMemoryAudit } from "./memory-audit-handler.js";
import { buildMemoryRecordFromProposal } from "./memory-record-builders.js";
import {
  enforcePersistableMemoryOutcome,
  isPersistableMemoryCandidate,
  memoryCapturePolicyForDeps,
} from "./memory-capture-policy.js";

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

// ─── /api/memory/context — request parsing ───────────────────────────────────

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
  readonly projectPath: string;
  readonly chatId: string;
  readonly queryText: string | undefined;
  readonly types: readonly MemoryType[] | undefined;
  readonly budgetTokens: number | undefined;
}

function parseRequiredString(
  raw: Record<string, unknown>,
  key: string,
): string | RouteResult {
  const value = raw[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", `${key} must be a non-empty string.`),
  };
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
  const projectPath = parseRequiredString(raw, "projectPath");
  if (isRouteResult(projectPath)) return projectPath;
  const chatId = parseRequiredString(raw, "chatId");
  if (isRouteResult(chatId)) return chatId;
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
    projectPath,
    chatId,
    queryText: queryText ?? undefined,
    types: types ?? undefined,
    budgetTokens: budgetTokens ?? undefined,
  };
}

function buildRetrievalRequest(
  scopes: readonly MemoryScope[],
  input: ContextInput,
): MemoryRetrievalRequest {
  // exactOptionalPropertyTypes: omit undefined fields instead of assigning them.
  const req: {
    scopes: readonly MemoryScope[];
    nowMs: number;
    queryText?: string;
    types?: readonly MemoryType[];
    budgetTokens?: number;
  } = {
    scopes,
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

  const context = resolveConversationMemoryContext(deps, input.projectPath, input.chatId);
  if (isRouteResult(context)) return context;
  const scopes = conversationMemoryScopes(context);
  const port = vaultAsQueryPort(vault);
  const result = retrieveMemoryContext(buildRetrievalRequest(scopes, input), port);
  if (result.included.length > 0) {
    const event: MemoryAuditEvent = {
      schemaVersion: "1",
      kind: "memory:retrieved",
      eventId: randomUUID(),
      occurredAt: Date.now(),
      initiatorSurface: "conversation-center",
      summary:
        result.included.length === 1
          ? "Retrieved 1 memory for the conversation memory API."
          : `Retrieved ${String(result.included.length)} memories for the conversation memory API.`,
      scopes,
      matchedMemoryIds: result.included.map((item) => item.memoryId),
    };
    recordMemoryAudit({ evidenceStore: deps.evidenceStore }, event);
  }
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
  readonly projectPath: string;
  readonly chatId: string;
}

function optionalId(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseCaptureContext(raw: unknown): CaptureInputContext | RouteResult {
  if (!isRecord(raw)) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "context must be an object with projectPath and chatId."),
    };
  }
  const projectPath = optionalId(raw, "projectPath");
  const chatId = optionalId(raw, "chatId");
  if (projectPath === undefined || chatId === undefined) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "context.projectPath and context.chatId are required."),
    };
  }
  return {
    projectPath,
    chatId,
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

function buildCaptureContext(input: ConversationMemoryRuntimeContext): CaptureContext {
  // exactOptionalPropertyTypes — only set fields when present.
  return {
    userId: input.userId,
    nowMs: Date.now(),
    newMemoryId: () => randomUUID() as MemoryId,
    newProposalId: () => randomUUID() as MemoryProposalId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    conversationId: input.conversationId,
  };
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
  const runtimeContext = resolveConversationMemoryContext(
    deps,
    input.context.projectPath,
    input.context.chatId,
  );
  if (isRouteResult(runtimeContext)) return runtimeContext;
  const captureContext = buildCaptureContext(runtimeContext);
  const outcomes: readonly CaptureOutcome[] = extractCandidatesFromUserText(
    input.text,
    captureContext,
    memoryCapturePolicyForDeps(deps, { resolver: createMemoryTargetResolver(vault) }),
  );
  // Issue #642: persist every candidate outcome as a `proposed` memory record so the
  // /api/memory/proposals/:id/accept route can find it by the returned proposalId. Uses the
  // shared `buildMemoryRecordFromProposal` builder for parity with chat-handlers.ts.
  const persistableOutcomes = outcomes.map(enforcePersistableMemoryOutcome);
  persistCandidateOutcomes(vault, persistableOutcomes);
  // Redact every outcome (proposal bodies may carry user text that needs scrubbing).
  return { status: 200, body: deps.redactor({ outcomes: persistableOutcomes }) };
}

function persistCandidateOutcomes(
  vault: MemoryVaultStore,
  outcomes: readonly CaptureOutcome[],
): void {
  for (const outcome of outcomes) {
    if (!isPersistableMemoryCandidate(outcome)) continue;
    const proposalId = outcome.proposal.proposalId as unknown as MemoryId;
    const record = buildMemoryRecordFromProposal(proposalId, outcome);
    if (record !== null) {
      vault.insertMemory(record);
    }
  }
}
