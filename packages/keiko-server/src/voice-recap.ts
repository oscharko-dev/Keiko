// BFF voice-session-recap route (Issue #504, Epic #491, ADR-0067). `POST /api/voice/recap/build` is a
// USER-TRIGGERED, capability-gated, additive route that derives memory candidates from the committed
// transcript of a voice session. It REUSES the existing governed capture path
// (`extractCandidatesFromUserText`, keiko-memory-capture) — the same `scanForSecrets` redaction, scope
// inference, sensitivity classification, and `buildProposal(initialStatus:"proposed")` the per-turn chat
// path uses — and surfaces resulting candidates in the EXISTING review queue. It adds no new governance,
// no new memory status, and no new mutation endpoint.
//
// AC1 (dormancy): the route is gated against the DEPLOYMENT voice capability via the
// `serverTrustedVoiceProfile` pattern (#503), NOT the client-claimed profile. A no-voice / playback-only
// deployment answers a deterministic `VOICE_UNAVAILABLE` and does zero memory work. The route is also
// dormant when the committed transcript is empty: it short-circuits before any extraction or vault write.
//
// AC4 / content-free: the request carries ONLY the per-utterance committed transcript spans (each a local
// BFF boundary for extraction) plus a content-free transcript counts roll-up; the text is never persisted
// by the server. No assistant response text is ever part of the request, so it can never reach extraction
// (AC5). The route's response and the persisted `VoiceSessionRecapAuditRecord` carry only counts, enums,
// booleans, and durations — never transcript text, audio, or assistant response text.
//
// AC5 (text path untouched): this is a SEPARATE additive route. It does not touch `collectMemoryActions`,
// `captureMemoryActions`, or `CONVERSATION_SYSTEM_PROMPT`; the per-turn chat capture path is byte-identical.

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import {
  buildVoiceSessionRecapAuditRecord,
  voiceRecapAllowed,
  type VoiceProfile,
  type VoiceSessionRecapAuditRecord,
  type VoiceTranscriptEvidenceSummary,
} from "@oscharko-dev/keiko-contracts";
import {
  extractCandidatesFromUserText,
  type CaptureContext,
  type CaptureOutcome,
} from "@oscharko-dev/keiko-memory-capture";
import type {
  MemoryId,
  MemoryProposalId,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { isVoiceDictationCapable, isVoiceRealtimeCapable } from "./read-handlers.js";
import { LOCAL_CONVERSATION_MEMORY_USER_ID } from "./memory-conversation-context.js";
import {
  memoryCapturePolicyForDeps,
  isPersistableMemoryCandidate,
} from "./memory-capture-policy.js";
import { buildMemoryRecordFromProposal } from "./memory-record-builders.js";

// The committed transcript ceiling for one recap (ADR-0067 Consequences: recommended 16 KB). A longer
// session body is rejected with 413 before any extraction or vault work, mirroring the dictation route.
const MAX_BODY_BYTES = 16_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
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

// Deterministic, secret-free disabled response (AC1, ADR-0058 D1 posture). Returned when the DEPLOYMENT
// is not voice-recap-capable so the browser sees a stable shape and Keiko stays fully usable.
function unavailable(deps: UiHandlerDeps): RouteResult {
  return {
    status: 503,
    body: deps.redactor(errorBody("VOICE_UNAVAILABLE", "Voice session recap is not available.")),
  };
}

// AC1 enforced against deployment reality, not the client claim (#503 lesson, ADR-0067 D5). Realtime and
// dictation-capable deployments resolve to a recap-allowed profile; everything else resolves to `none`,
// for which `voiceRecapAllowed` is false and the route is dormant.
function serverTrustedVoiceProfile(deps: UiHandlerDeps): VoiceProfile {
  if (isVoiceRealtimeCapable(deps)) {
    return "full-realtime";
  }
  if (isVoiceDictationCapable(deps)) {
    return "speech-to-text";
  }
  return "none";
}

function nonNegativeIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

// Parses the per-utterance committed spans: keeps only string entries, trims each, and drops empties.
// These spans are the ONLY transcript input — each is fed to `extractCandidatesFromUserText` individually
// so a session yields per-utterance candidates. An absent or all-empty list makes the route dormant.
function parseCommittedSpans(body: Record<string, unknown>): readonly string[] {
  const raw = Array.isArray(body.committedSpans) ? body.committedSpans : [];
  const spans: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) spans.push(trimmed);
  }
  return spans;
}

// Sanitizes the client-supplied transcript counts into a content-free `VoiceTranscriptEvidenceSummary`.
// `segmentCount` and `committedChars` are SERVER-AUTHORITATIVE (derived from the parsed spans the server
// actually extracted), so the client cannot inflate them. The remaining descriptive counts come from the
// client's committed-transcript projection — they are evidence metadata (corrected/discarded/redacted/…),
// not a governance control, and are clamped to non-negative integers.
function sanitizeTranscriptSummary(
  body: Record<string, unknown>,
  committedSpans: readonly string[],
): VoiceTranscriptEvidenceSummary {
  const client = isRecord(body.transcript) ? body.transcript : {};
  const committedChars = committedSpans.reduce((sum, span) => sum + span.length, 0);
  return {
    schemaVersion: "1",
    segmentCount: committedSpans.length,
    committedCount: nonNegativeIntOr(client.committedCount, 0),
    correctedCount: nonNegativeIntOr(client.correctedCount, 0),
    discardedCount: nonNegativeIntOr(client.discardedCount, 0),
    redactedCount: nonNegativeIntOr(client.redactedCount, 0),
    providerErrorCount: nonNegativeIntOr(client.providerErrorCount, 0),
    committedChars,
    highestSeq: nonNegativeIntOr(client.highestSeq, 0),
  };
}

interface RecapMemoryContext {
  readonly userId: UserId;
  readonly workspaceId?: WorkspaceId;
  readonly projectId?: ProjectId;
}

// The recap is workspace/project agnostic at the route boundary: a voice session is not bound to a chat,
// so scope inference falls back to the local operator unless the client supplies coordinates. Optional
// coordinates are forwarded so scope inference can place a candidate in the most specific scope available.
function resolveRecapMemoryContext(body: Record<string, unknown>): RecapMemoryContext {
  const workspaceId =
    typeof body.workspaceId === "string" && body.workspaceId.length > 0
      ? (body.workspaceId as WorkspaceId)
      : undefined;
  const projectId =
    typeof body.projectId === "string" && body.projectId.length > 0
      ? (body.projectId as ProjectId)
      : undefined;
  return {
    userId: LOCAL_CONVERSATION_MEMORY_USER_ID,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

function buildCaptureContext(context: RecapMemoryContext): CaptureContext {
  return {
    userId: context.userId,
    nowMs: Date.now(),
    newMemoryId: () => randomUUID() as MemoryId,
    newProposalId: () => randomUUID() as MemoryProposalId,
    ...(context.workspaceId !== undefined ? { workspaceId: context.workspaceId } : {}),
    ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
  };
}

interface CandidatePersistResult {
  readonly candidatesExtracted: number;
  readonly candidatesProposed: number;
  readonly candidatesRejected: number;
  readonly proposalIds: readonly string[];
}

// Persists one capture outcome as a `"proposed"` memory record via the SAME vault path the chat handler
// uses (`buildMemoryRecordFromProposal` → `vault.insertMemory`). Only PUBLIC, no-approval candidates are
// stored; everything else (sensitive, requires-approval, rejected, update/forget/supersession) is counted
// as rejected and never written (AC6). Returns the inserted id when a record was stored.
function persistCandidate(outcome: CaptureOutcome, vault: MemoryVaultStore): MemoryId | undefined {
  if (outcome.kind !== "candidate" || !isPersistableMemoryCandidate(outcome)) {
    return undefined;
  }
  const proposalId = outcome.proposal.proposalId as unknown as MemoryId;
  const record = buildMemoryRecordFromProposal(proposalId, outcome);
  if (record === null) {
    return undefined;
  }
  return vault.insertMemory(record).id;
}

function persistRecapCandidates(
  outcomes: readonly CaptureOutcome[],
  vault: MemoryVaultStore,
): CandidatePersistResult {
  const proposalIds: string[] = [];
  for (const outcome of outcomes) {
    const insertedId = persistCandidate(outcome, vault);
    if (insertedId !== undefined) {
      proposalIds.push(String(insertedId));
    }
  }
  return {
    candidatesExtracted: outcomes.length,
    candidatesProposed: proposalIds.length,
    candidatesRejected: outcomes.length - proposalIds.length,
    proposalIds,
  };
}

// THE BLOCKER FIX (ADR-0067 D5): the response is FLAT — `candidatesProposed`, `candidatesRejected`, and
// `proposalIds` at the top level (matching the UI hook's `VoiceRecapBuildResponse`). The counts are NOT
// nested under `summary`.
interface RecapResponseBody {
  readonly candidatesProposed: number;
  readonly candidatesRejected: number;
  readonly proposalIds: readonly string[];
}

function buildRecapResponse(
  profile: VoiceProfile,
  transcript: VoiceTranscriptEvidenceSummary,
  persisted: CandidatePersistResult,
  startedAtMs: number,
): { readonly body: RecapResponseBody; readonly audit: VoiceSessionRecapAuditRecord } {
  const audit = buildVoiceSessionRecapAuditRecord({
    profile,
    committedSegmentCount: transcript.segmentCount,
    committedChars: transcript.committedChars,
    candidatesExtracted: persisted.candidatesExtracted,
    candidatesRejected: persisted.candidatesRejected,
    candidatesProposed: persisted.candidatesProposed,
    triggeredByUser: true,
    durationMs: Math.max(0, Date.now() - startedAtMs),
  });
  return {
    body: {
      candidatesProposed: persisted.candidatesProposed,
      candidatesRejected: persisted.candidatesRejected,
      proposalIds: persisted.proposalIds,
    },
    audit,
  };
}

// Persists the content-free audit record under its own evidence id. The record structurally cannot carry
// transcript text (no text field exists on it), so this write is content-free by construction (AC4).
function persistRecapAudit(deps: UiHandlerDeps, audit: VoiceSessionRecapAuditRecord): void {
  deps.evidenceStore.put(`voice-recap-${randomUUID()}`, JSON.stringify(audit));
}

// Extracts candidates from EACH committed span independently and flattens every outcome into one array,
// so a session with multiple committed utterances yields per-utterance candidates. The request carries
// ONLY committedSpans + content-free transcript counts — no assistant text can ever reach this path (AC5).
function extractFromSpans(
  committedSpans: readonly string[],
  body: Record<string, unknown>,
  deps: UiHandlerDeps,
): readonly CaptureOutcome[] {
  const context = buildCaptureContext(resolveRecapMemoryContext(body));
  const policy = memoryCapturePolicyForDeps(deps);
  const outcomes: CaptureOutcome[] = [];
  for (const span of committedSpans) {
    outcomes.push(...extractCandidatesFromUserText(span, context, policy));
  }
  return outcomes;
}

export async function handleVoiceRecapBuild(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const profile = serverTrustedVoiceProfile(deps);
  if (!voiceRecapAllowed(profile)) {
    return unavailable(deps);
  }
  if (deps.memoryVault === undefined) {
    return {
      status: 503,
      body: deps.redactor(errorBody("MEMORY_UNAVAILABLE", "Memory vault is not configured.")),
    };
  }
  const parsed = await readJsonObject(ctx.req);
  if (isRouteResult(parsed)) {
    return parsed;
  }
  const startedAtMs = Date.now();
  const committedSpans = parseCommittedSpans(parsed);
  const transcript = sanitizeTranscriptSummary(parsed, committedSpans);
  const outcomes =
    committedSpans.length === 0 ? [] : extractFromSpans(committedSpans, parsed, deps);
  const persisted = persistRecapCandidates(outcomes, deps.memoryVault);
  const { body, audit } = buildRecapResponse(profile, transcript, persisted, startedAtMs);
  persistRecapAudit(deps, audit);
  return { status: 200, body: deps.redactor(body) };
}
