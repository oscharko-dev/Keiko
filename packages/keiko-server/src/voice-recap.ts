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
// AC4 / content-free: the request carries the committed transcript text ONCE for extraction (a local BFF
// boundary); the text is never persisted by the server. The route's response and the persisted
// `VoiceSessionRecapAuditRecord` carry only counts, enums, booleans, and durations — never transcript
// text, audio, or assistant response text. Assistant-turn descriptors are context-only and are NEVER
// passed to candidate extraction (AC5 invariant, mirroring `collectMemoryActions`).
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
  type VoiceSessionRecapEvidenceSummary,
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

interface RecapRequest {
  readonly committedText: string;
  readonly segmentCount: number;
}

function nonNegativeIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

// Parses the content-free + committed-text recap body. The committed text is the only transcript input;
// `segmentCount` and `committedChars` are content-free counts the client derives from
// `selectCommittedVoiceTranscript` and are never used for extraction (AC5). An absent or whitespace-only
// committed text yields an empty string, which makes the route dormant (no candidates, no side effects).
function parseRecapRequest(body: Record<string, unknown>): RecapRequest {
  const committedText = typeof body.committedText === "string" ? body.committedText : "";
  return { committedText, segmentCount: nonNegativeIntOr(body.segmentCount, 0) };
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

interface RecapResponseBody {
  readonly summary: VoiceSessionRecapEvidenceSummary;
  readonly proposalIds: readonly string[];
}

function buildRecapResponse(
  profile: VoiceProfile,
  transcript: VoiceTranscriptEvidenceSummary,
  persisted: CandidatePersistResult,
  startedAtMs: number,
): { readonly body: RecapResponseBody; readonly audit: VoiceSessionRecapAuditRecord } {
  const summary: VoiceSessionRecapEvidenceSummary = {
    schemaVersion: "1",
    transcript,
    candidatesExtracted: persisted.candidatesExtracted,
    candidatesRejected: persisted.candidatesRejected,
    candidatesProposed: persisted.candidatesProposed,
    triggeredByUser: true,
  };
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
  return { body: { summary, proposalIds: persisted.proposalIds }, audit };
}

// Persists the content-free audit record under its own evidence id. The record structurally cannot carry
// transcript text (no text field exists on it), so this write is content-free by construction (AC4).
function persistRecapAudit(deps: UiHandlerDeps, audit: VoiceSessionRecapAuditRecord): void {
  deps.evidenceStore.put(`voice-recap-${randomUUID()}`, JSON.stringify(audit));
}

// Builds the content-free transcript roll-up the recap embeds. The route never receives raw segments —
// only the joined committed text and the client's content-free `segmentCount` derived from
// `selectCommittedVoiceTranscript` — so the roll-up reports the authoritative committed character count
// (the actual submitted text length) and the client's committed segment count (zero when empty). It
// carries no segment text by construction.
function transcriptSummaryFor(
  committedText: string,
  committedSegmentCount: number,
): VoiceTranscriptEvidenceSummary {
  return {
    schemaVersion: "1",
    segmentCount: committedSegmentCount,
    committedCount: committedSegmentCount,
    correctedCount: 0,
    discardedCount: 0,
    redactedCount: 0,
    providerErrorCount: 0,
    committedChars: committedText.length,
    highestSeq: committedSegmentCount,
  };
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
  const request = parseRecapRequest(parsed);
  const committedText = request.committedText.trim();
  const transcript = transcriptSummaryFor(committedText, request.segmentCount);
  const outcomes =
    committedText.length === 0
      ? []
      : extractCandidatesFromUserText(
          committedText,
          buildCaptureContext(resolveRecapMemoryContext(parsed)),
          memoryCapturePolicyForDeps(deps),
        );
  const persisted = persistRecapCandidates(outcomes, deps.memoryVault);
  const { body, audit } = buildRecapResponse(profile, transcript, persisted, startedAtMs);
  persistRecapAudit(deps, audit);
  return { status: 200, body: deps.redactor(body) };
}
