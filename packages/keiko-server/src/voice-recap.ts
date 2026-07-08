// Voice session recap server handler (Epic #491, Issue #504, ADR-0109). Artifact B.
//
// A recap is the capture-side sibling of the live realtime memory recall: it turns the COMMITTED
// spoken transcript of a full-realtime (or dictation) voice session into governed, reviewable memory
// candidates. Full-realtime speech never enters `request.content` (it rides the WebRTC audio plane),
// so per-turn chat capture cannot see it — this route closes that gap (ADR-0109 §Context).
//
// It reuses the EXISTING governed capture entry point (`extractCandidatesFromUserText`) unchanged —
// same secret scanner, scope inference, sensitivity classification, and `buildProposal` as typed
// chat — and the EXISTING persistence + review surface: candidates land as `status: "proposed"` and
// are reviewed through the existing MemoriaViva review-queue endpoints. No new extractor, no new
// mutation surface, no new governance (ADR-0109 D3/D4).
//
// Invariants preserved:
//  - Capability is checked against the DEPLOYMENT profile, never a client-claimed one (the #503
//    lesson). Dormant (503) when `voiceRecapAllowed(profile)` is false.
//  - Empty committed spans → dormant, no side effect (AC1).
//  - Only the user's committed spoken text is an extraction input; assistant response text is never
//    submitted (ADR-0109 D5). The response and audit are content-free: counts + ids, never text.

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  resolveVoiceCapability,
  type VoiceCapabilityResolution,
} from "@oscharko-dev/keiko-model-gateway";
import {
  validateVoiceSessionRecapAuditRecord,
  voiceRecapAllowed,
  type MemoryAuditEvent,
  type MemoryId,
  type MemoryProposalId,
  type MemoryScope,
  type VoiceProfile,
  type VoiceSessionRecapAuditRecord,
} from "@oscharko-dev/keiko-contracts";
import {
  extractCandidatesFromUserText,
  type CaptureContext,
  type CaptureOutcome,
} from "@oscharko-dev/keiko-memory-capture";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { validateProjectPath } from "./store/validation.js";
import { currentGatewayConfig, type UiHandlerDeps } from "./deps.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";
import { isVoiceDisabledByPolicy } from "./read-handlers.js";
import { desktopChatErrorResult } from "./chat-handlers.js";
import { resolveConversationMemoryContext } from "./memory-conversation-context.js";
import type { ConversationMemoryRuntimeContext } from "./memory-conversation-context.js";
import { memoryCapturePolicyForDeps } from "./memory-capture-policy.js";
import { isPersistableMemoryCandidate } from "./memory-capture-policy.js";
import { createMemoryTargetResolver } from "./memory-target-resolver.js";
import { buildMemoryRecordFromProposal } from "./memory-record-builders.js";
import { isSuppressedByForgetTombstone } from "./memory-suppression.js";
import { embedAndStoreMemory } from "./memory-embedding.js";
import { recordMemoryAudits } from "./memory-audit-handler.js";

const MAX_BODY_BYTES = 16_000;
const MAX_SPANS = 200;
const MAX_SPAN_CHARS = 8_000;
const MAX_ID_CHARS = 200;

class BodyTooLargeError extends Error {
  public constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

interface RecapRequest {
  readonly chatId: string;
  readonly projectPath: string;
  readonly committedSpans: readonly string[];
}

interface RecapOutcome {
  readonly candidatesExtracted: number;
  readonly candidatesRejected: number;
  readonly candidatesProposed: number;
  readonly proposalIds: readonly string[];
}

export interface RecapResponseBody extends RecapOutcome {
  readonly status: "ok";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

async function readJsonObject(
  req: IncomingMessage,
): Promise<Record<string, unknown> | RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    throw error;
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

function readRequiredString(
  body: Record<string, unknown>,
  key: string,
  maxChars: number,
): string | RouteResult {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (value.length === 0 || value.length > maxChars) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", `${key} must be a non-empty bounded string.`),
    };
  }
  return value;
}

// Committed spans are the per-utterance committed transcript text. Empty entries are dropped (they
// carry nothing to extract); an oversize span is rejected outright rather than silently truncated.
function readCommittedSpans(body: Record<string, unknown>): readonly string[] | RouteResult {
  const raw = body.committedSpans;
  if (!Array.isArray(raw)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "committedSpans must be an array.") };
  }
  if (raw.length > MAX_SPANS) {
    return { status: 400, body: errorBody("BAD_REQUEST", "committedSpans exceeds the limit.") };
  }
  const spans: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return {
        status: 400,
        body: errorBody("BAD_REQUEST", "committedSpans entries must be strings."),
      };
    }
    if (entry.length > MAX_SPAN_CHARS) {
      return {
        status: 400,
        body: errorBody("BAD_REQUEST", "a committed span exceeds the character limit."),
      };
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0) spans.push(trimmed);
  }
  return spans;
}

function parseRequest(body: Record<string, unknown>): RecapRequest | RouteResult {
  const chatId = readRequiredString(body, "chatId", MAX_ID_CHARS);
  if (isRouteResult(chatId)) return chatId;
  const projectPath = readRequiredString(body, "projectPath", MAX_SPAN_CHARS);
  if (isRouteResult(projectPath)) return projectPath;
  const committedSpans = readCommittedSpans(body);
  if (isRouteResult(committedSpans)) return committedSpans;
  return { chatId, projectPath, committedSpans };
}

// Effective deployment voice profile, resolved from the gateway config — never a client claim.
function serverVoiceProfile(deps: UiHandlerDeps): VoiceProfile {
  const resolution: VoiceCapabilityResolution = resolveVoiceCapability(
    currentGatewayConfig(deps) ?? { providers: [] },
    { policyDisabled: isVoiceDisabledByPolicy(deps.env) },
  );
  return resolution.available ? resolution.profile : "none";
}

function buildCaptureContext(runtime: ConversationMemoryRuntimeContext): CaptureContext {
  return {
    userId: runtime.userId,
    nowMs: Date.now(),
    newMemoryId: () => randomUUID() as MemoryId,
    newProposalId: () => randomUUID() as MemoryProposalId,
    workspaceId: runtime.workspaceId,
    projectId: runtime.projectId,
    conversationId: runtime.conversationId,
  };
}

function proposedAuditEvent(memoryId: MemoryId, scope: MemoryScope): MemoryAuditEvent {
  return {
    schemaVersion: "1",
    kind: "memory:proposed",
    eventId: randomUUID(),
    occurredAt: Date.now(),
    // User-triggered capture from a live conversation → the conversation-center surface (the recap
    // reuses the same provenance surface as per-turn capture; ADR-0109 D3 adds no new surface tag).
    initiatorSurface: "conversation-center",
    summary: "Proposed a memory from a reviewed voice session recap.",
    memoryId,
    scope,
  };
}

interface RecapPersistResult {
  readonly proposed: readonly { readonly id: MemoryId; readonly scope: MemoryScope }[];
  readonly extracted: number;
  readonly rejected: number;
}

// Persist only the persistable candidate outcomes as `proposed`, mirroring the chat capture path:
// forget-tombstone suppression, `buildMemoryRecordFromProposal`, best-effort embed-on-capture.
// Everything else (rejected, sensitive/approval-gated candidates, governance-action kinds) is
// COUNTED but never written — surfaced as `candidatesRejected` in the content-free response.
async function persistRecapOutcomes(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  outcomes: readonly CaptureOutcome[],
): Promise<RecapPersistResult> {
  const proposed: { id: MemoryId; scope: MemoryScope }[] = [];
  let rejected = 0;
  for (const outcome of outcomes) {
    if (!isPersistableMemoryCandidate(outcome)) {
      rejected += 1;
      continue;
    }
    const proposalId = outcome.proposal.proposalId as unknown as MemoryId;
    const record = buildMemoryRecordFromProposal(proposalId, outcome);
    if (record === null || isSuppressedByForgetTombstone(vault, record)) {
      rejected += 1;
      continue;
    }
    const inserted = vault.insertMemory(record);
    await embedAndStoreMemory(deps, vault, inserted.id, inserted.body);
    proposed.push({ id: inserted.id, scope: inserted.scope });
  }
  return { proposed, extracted: outcomes.length, rejected };
}

function recordRecapAudits(
  deps: UiHandlerDeps,
  profile: VoiceProfile,
  request: RecapRequest,
  persisted: RecapPersistResult,
  startedAtMs: number,
): void {
  const events = persisted.proposed.map(({ id, scope }) => proposedAuditEvent(id, scope));
  if (events.length > 0) {
    recordMemoryAudits({ evidenceStore: deps.evidenceStore }, events);
  }
  // Content-free recap roll-up (ADR-0109 D1). Validated so a malformed record (e.g. an accidental
  // non-user-triggered flag) fails loud instead of persisting a spec-violating audit artifact.
  const committedChars = request.committedSpans.reduce((sum, span) => sum + span.length, 0);
  const auditRecord: VoiceSessionRecapAuditRecord = {
    schemaVersion: "1",
    profile,
    committedSegmentCount: request.committedSpans.length,
    committedChars,
    candidatesExtracted: persisted.extracted,
    candidatesRejected: persisted.rejected,
    candidatesProposed: persisted.proposed.length,
    triggeredByUser: true,
    durationMs: Math.max(0, Date.now() - startedAtMs),
  };
  const validation = validateVoiceSessionRecapAuditRecord(auditRecord);
  if (validation.ok) {
    deps.evidenceStore.put(`voice-recap-${randomUUID()}`, JSON.stringify(auditRecord));
  }
}

async function buildRecapResponse(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  profile: VoiceProfile,
  request: RecapRequest,
  runtime: ConversationMemoryRuntimeContext,
): Promise<RecapResponseBody> {
  const startedAtMs = Date.now();
  const captureContext = buildCaptureContext(runtime);
  const policy = memoryCapturePolicyForDeps(deps, {
    resolver: createMemoryTargetResolver(vault),
  });
  const outcomes: CaptureOutcome[] = [];
  for (const span of request.committedSpans) {
    outcomes.push(...extractCandidatesFromUserText(span, captureContext, policy));
  }
  const persisted = await persistRecapOutcomes(deps, vault, outcomes);
  recordRecapAudits(deps, profile, request, persisted, startedAtMs);
  return {
    status: "ok",
    candidatesExtracted: persisted.extracted,
    candidatesRejected: persisted.rejected,
    candidatesProposed: persisted.proposed.length,
    proposalIds: persisted.proposed.map(({ id }) => String(id)),
  };
}

function dormantResponse(): RouteResult {
  // Empty committed spans → no extraction, no side effect (AC1). Returned as a well-formed
  // zero-result body so the client renders "nothing to review" without a special error path.
  return {
    status: 200,
    body: {
      status: "ok",
      candidatesExtracted: 0,
      candidatesRejected: 0,
      candidatesProposed: 0,
      proposalIds: [],
    } satisfies RecapResponseBody,
  };
}

export async function handleBuildVoiceRecap(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req);
  if (isRouteResult(body)) return body;
  const request = parseRequest(body);
  if (isRouteResult(request)) return request;

  const profile = serverVoiceProfile(deps);
  if (!voiceRecapAllowed(profile)) {
    return {
      status: 503,
      body: errorBody(
        "VOICE_UNAVAILABLE",
        "Voice session recap is not available for this deployment.",
      ),
    };
  }
  const vault = deps.memoryVault;
  if (vault === undefined) {
    return {
      status: 409,
      body: errorBody("MEMORY_UNAVAILABLE", "MemoriaViva is not available for this deployment."),
    };
  }
  if (request.committedSpans.length === 0) {
    return dormantResponse();
  }

  let projectPath: string;
  try {
    projectPath = validateProjectPath(request.projectPath, { mustExist: false });
  } catch (error) {
    return desktopChatErrorResult(error, deps);
  }
  const runtime = resolveConversationMemoryContext(deps, projectPath, request.chatId);
  if (isRouteResult(runtime)) return runtime;

  try {
    const response = await buildRecapResponse(
      deps,
      vault,
      profile,
      { ...request, projectPath },
      runtime,
    );
    return { status: 200, body: response };
  } catch (error) {
    return desktopChatErrorResult(error, deps);
  }
}
