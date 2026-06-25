// Voice session recap contract (Epic #491, Issue #504, ADR-0067). A voice session recap is a
// USER-TRIGGERED summary of a voice session's committed transcript that derives memory candidates
// EXCLUSIVELY from the committed-only projection (`selectCommittedVoiceTranscript`, ADR-0063). This leaf
// module DEFINES the content-free event model — the candidate lifecycle, the capability predicate, the
// committed-span / assistant-turn descriptors, the evidence summary, and the audit record — that the
// server (Artifact B) and the keiko-ui hook (Artifact C) build upon.
//
// CONTENT-FREE INVARIANT: nothing here is a raw transcript, raw audio buffer, provider host, model id,
// sensitive identity material, or assistant response text. Every boundary value is a closed enum, a
// boolean, an integer count, a character count, a duration integer, or a fixed schema-version string.
// Reviewable transcript text lives ONLY in the server at extraction time and in the keiko-ui hook's
// local closure; it never becomes a field on a type defined here and is never persisted in an audit
// record. The candidate derivation itself reuses the EXISTING governed `extractCandidatesFromUserText`
// path (with its sensitive-material redaction, scope inference, and `buildProposal`) — this leaf adds no
// extraction, no governance, and no memory mutation surface.
//
// COUPLING TO `VoiceTranscriptEvidenceSummary`: `VoiceSessionRecapEvidenceSummary` embeds the
// content-free transcript roll-up produced by `summarizeVoiceTranscript` (`./voice-transcript.js`) and
// adds recap-specific candidate counts. Reusing that summary keeps the committed-character accounting
// identical to the transcript layer rather than re-deriving it, so the recap and the transcript layer
// always agree on `committedChars`.
//
// `VOICE_SESSION_RECAP_SCHEMA_VERSION` follows the sibling evolution rule (ADR-0010 D2): a breaking
// change introduces a NEW literal rather than mutating "1", and it is INDEPENDENT of every other schema
// version (`VOICE_TRANSCRIPT_SCHEMA_VERSION`, `VOICE_ACTION_INTENT_SCHEMA_VERSION`,
// `CONVERSATION_CAPABILITY_CONTRACT_VERSION`). Leaf-package rule (ADR-0019 direction 1): no
// `@oscharko-dev/keiko-*` import may appear here, and this module does NOT import `./memory-records.js`
// or any memory-domain type — it is UPSTREAM of the memory domain; siblings are reached by relative path.

import type { VoiceProfile } from "./gateway.js";
import type { VoiceTranscriptEvidenceSummary, VoiceTranscriptSource } from "./voice-transcript.js";
import { voiceTranscriptCaptureAllowed } from "./voice-transcript.js";

// ─── Schema version ───────────────────────────────────────────────────────────
export const VOICE_SESSION_RECAP_SCHEMA_VERSION = "1" as const;
export type VoiceSessionRecapSchemaVersion = typeof VOICE_SESSION_RECAP_SCHEMA_VERSION;

export function isVoiceSessionRecapSchemaVersionSupported(version: unknown): boolean {
  return version === VOICE_SESSION_RECAP_SCHEMA_VERSION;
}

// ─── Capability gating (AC1) — derived from the committed-transcript capability ──
// Derived from `voiceTranscriptCaptureAllowed` so it cannot drift: a recap can be built only where
// committed transcript capture is allowed (`speech-to-text` / `full-realtime`). `none` and
// `speech-output` (playback-only) make the whole layer dormant (AC1). The text path never calls this.
// The SERVER must enforce this against the DEPLOYMENT capability, not the client-claimed profile.
export function voiceRecapAllowed(profile: VoiceProfile): boolean {
  return voiceTranscriptCaptureAllowed(profile);
}

// ─── Recap candidate lifecycle ──────────────────────────────────────────────────
// The recap proposes candidates that flow through the EXISTING memory status lifecycle; this union is a
// strict SUBSET of `MemoryStatus` (memory.ts) projected onto the four states a recap candidate can
// occupy. It is redeclared here — not imported from `./memory-records.js` — because this leaf is upstream
// of the memory domain (ADR-0019 / ADR-0067 D1). The mapping is exact:
//   "proposed"  → MemoryStatus "proposed"  (the ONLY initial state; `buildProposal` initialStatus)
//   "accepted"  → MemoryStatus "accepted"  (via POST /api/memory/proposals/:id/accept)
//   "rejected"  → MemoryStatus "rejected"  (via POST /api/memory/proposals/:id/reject)
//   "forgotten" → MemoryStatus "forgotten" (via POST /api/memory/:id/forget)
// Terminal transitions delegate to the existing governed endpoints; the recap adds none of its own.
export type VoiceRecapCandidateStatus = "proposed" | "accepted" | "rejected" | "forgotten";

export const VOICE_RECAP_CANDIDATE_STATUSES: readonly VoiceRecapCandidateStatus[] = [
  "proposed",
  "accepted",
  "rejected",
  "forgotten",
] as const;

export function isVoiceRecapCandidateStatus(value: unknown): value is VoiceRecapCandidateStatus {
  return (
    typeof value === "string" &&
    (VOICE_RECAP_CANDIDATE_STATUSES as readonly string[]).includes(value)
  );
}

export function assertNeverVoiceRecapCandidateStatus(value: never): never {
  throw new TypeError(`Unhandled VoiceRecapCandidateStatus: ${JSON.stringify(value)}`);
}

// ─── Content-free committed-span descriptor ─────────────────────────────────────
// The leaf contract does NOT carry transcript text — text lives in the server at extraction time and in
// the keiko-ui hook's local state. This shape is the content-free bridge the server uses to record WHAT
// was submitted for extraction (ordinal position, provenance, character / segment counts) without
// retaining the text itself.
export interface VoiceRecapCommittedSpanDescriptor {
  readonly schemaVersion: VoiceSessionRecapSchemaVersion;
  readonly spanIndex: number;
  readonly source: VoiceTranscriptSource;
  readonly charCount: number;
  readonly segmentCount: number;
  readonly highestSeq: number;
}

// ─── Content-free assistant-turn descriptor ─────────────────────────────────────
// Records that an assistant response occurred at a given turn for auditing purposes only. Assistant
// response text is context-only and is NEVER submitted to `extractCandidatesFromUserText` (ADR-0067 D5),
// so this descriptor carries no text — only the turn index and a closed source enum.
export type VoiceRecapAssistantTurnSource = "text-response";

export const VOICE_RECAP_ASSISTANT_TURN_SOURCES: readonly VoiceRecapAssistantTurnSource[] = [
  "text-response",
] as const;

export function isVoiceRecapAssistantTurnSource(
  value: unknown,
): value is VoiceRecapAssistantTurnSource {
  return (
    typeof value === "string" &&
    (VOICE_RECAP_ASSISTANT_TURN_SOURCES as readonly string[]).includes(value)
  );
}

export interface VoiceRecapAssistantTurnDescriptor {
  readonly schemaVersion: VoiceSessionRecapSchemaVersion;
  readonly turnIndex: number;
  readonly source: VoiceRecapAssistantTurnSource;
}

// ─── Evidence summary for the recap as a whole ──────────────────────────────────
// Reuses `VoiceTranscriptEvidenceSummary` for the committed transcript roll-up and adds recap-specific
// candidate counts. `triggeredByUser` is always true (recap is user-triggered, never automatic — D2).
export interface VoiceSessionRecapEvidenceSummary {
  readonly schemaVersion: VoiceSessionRecapSchemaVersion;
  readonly transcript: VoiceTranscriptEvidenceSummary;
  readonly candidatesExtracted: number;
  readonly candidatesRejected: number;
  readonly candidatesProposed: number;
  readonly triggeredByUser: boolean;
}

// ─── Content-free audit record (AC4) ────────────────────────────────────────────
// Mirrors `SpokenActionAuditRecord` posture: no text, no audio, only enums / ints / bools. There is no
// text field by design, so it structurally cannot carry transcript content.
export interface VoiceSessionRecapAuditRecord {
  readonly schemaVersion: VoiceSessionRecapSchemaVersion;
  readonly profile: VoiceProfile;
  readonly committedSegmentCount: number;
  readonly committedChars: number;
  readonly candidatesExtracted: number;
  readonly candidatesRejected: number;
  readonly candidatesProposed: number;
  readonly triggeredByUser: boolean;
  readonly durationMs: number;
}

// The builder input mirrors the record minus `schemaVersion` (the builder stamps it). All fields are
// content-free. `triggeredByUser` is defaulted to `true` because a recap is always user-triggered, but
// it is accepted as input so the server records the actual trigger provenance explicitly.
export interface VoiceSessionRecapAuditInput {
  readonly profile: VoiceProfile;
  readonly committedSegmentCount: number;
  readonly committedChars: number;
  readonly candidatesExtracted: number;
  readonly candidatesRejected: number;
  readonly candidatesProposed: number;
  readonly triggeredByUser: boolean;
  readonly durationMs: number;
}

// ─── Pure derivations ───────────────────────────────────────────────────────────
// Build the content-free audit record. Copies only content-free fields; structurally cannot carry text
// because no text field exists on either the input or the record.
export function buildVoiceSessionRecapAuditRecord(
  input: VoiceSessionRecapAuditInput,
): VoiceSessionRecapAuditRecord {
  return {
    schemaVersion: VOICE_SESSION_RECAP_SCHEMA_VERSION,
    profile: input.profile,
    committedSegmentCount: input.committedSegmentCount,
    committedChars: input.committedChars,
    candidatesExtracted: input.candidatesExtracted,
    candidatesRejected: input.candidatesRejected,
    candidatesProposed: input.candidatesProposed,
    triggeredByUser: input.triggeredByUser,
    durationMs: input.durationMs,
  };
}

// The recap candidate accounting derived from an extraction run. `candidatesProposed` is the count of
// outcomes that reached the vault as `"proposed"`; the remainder of `candidatesExtracted` is the
// rejected count (sensitive-material or out-of-scope outcomes rejected before vault insert — AC6). These two
// partitions are disjoint and exhaustive, so `proposed + rejected === extracted` by construction.
export interface VoiceSessionRecapCandidateCounts {
  readonly candidatesExtracted: number;
  readonly candidatesProposed: number;
  readonly candidatesRejected: number;
}

export function summarizeVoiceSessionRecap(
  transcript: VoiceTranscriptEvidenceSummary,
  counts: VoiceSessionRecapCandidateCounts,
): VoiceSessionRecapEvidenceSummary {
  return {
    schemaVersion: VOICE_SESSION_RECAP_SCHEMA_VERSION,
    transcript,
    candidatesExtracted: counts.candidatesExtracted,
    candidatesRejected: counts.candidatesRejected,
    candidatesProposed: counts.candidatesProposed,
    triggeredByUser: true,
  };
}

// ─── Validators (never throw) ───────────────────────────────────────────────────
export type VoiceSessionRecapValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const VOICE_PROFILES: readonly VoiceProfile[] = [
  "none",
  "speech-to-text",
  "speech-output",
  "full-realtime",
];

function isVoiceProfile(value: unknown): value is VoiceProfile {
  return typeof value === "string" && (VOICE_PROFILES as readonly string[]).includes(value);
}

// The content-free count fields, validated in declaration order so the first failing field names itself.
const RECAP_AUDIT_COUNT_FIELDS: readonly (keyof VoiceSessionRecapAuditRecord)[] = [
  "committedSegmentCount",
  "committedChars",
  "candidatesExtracted",
  "candidatesRejected",
  "candidatesProposed",
  "durationMs",
];

function firstInvalidCountField(value: Record<string, unknown>): string | undefined {
  return RECAP_AUDIT_COUNT_FIELDS.find((field) => !isNonNegativeInteger(value[field]));
}

export function validateVoiceSessionRecapAuditRecord(
  value: unknown,
): VoiceSessionRecapValidationResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "audit: must be an object" };
  }
  const record = value as Record<string, unknown>;
  if (!isVoiceSessionRecapSchemaVersionSupported(record.schemaVersion)) {
    return { ok: false, reason: "schemaVersion: unsupported" };
  }
  if (!isVoiceProfile(record.profile)) {
    return { ok: false, reason: "profile: unknown voice profile" };
  }
  const invalidField = firstInvalidCountField(record);
  if (invalidField !== undefined) {
    return { ok: false, reason: `${invalidField}: must be a non-negative integer` };
  }
  if (typeof record.triggeredByUser !== "boolean") {
    return { ok: false, reason: "triggeredByUser: must be a boolean" };
  }
  return { ok: true };
}
