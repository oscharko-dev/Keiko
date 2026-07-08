// Voice session recap contract (Epic #491, Issue #504, ADR-0109). A recap derives governed memory
// candidates EXCLUSIVELY from the committed voice transcript projection (ADR-0105 boundary) and is
// always USER-TRIGGERED — never automatic on disconnect (ADR-0109 D2). This leaf module defines the
// content-free event model around that flow: the capability predicate, the candidate lifecycle, the
// committed-span / assistant-turn descriptors, and the evidence audit record.
//
// It is pure data + pure functions only — no IO, no clock reads, no randomness, no audio processing.
// Every boundary value is a closed enum, a boolean, an integer count, a character count, a duration
// integer, or the fixed schema version string. No raw transcript text, raw audio, sign-in material,
// provider address, model id, or assistant response text is a field of any type here (ADR-0109 D8);
// transcript text lives transiently in the server at extraction time and in the UI hook's closure,
// never in this contract.
//
// This module deliberately does NOT import `./memory-records.js` or any memory-domain type: the leaf
// contract is upstream of the memory domain (ADR-0109 D1). The server (voice-recap.ts) is the single
// site that imports both this contract and `@oscharko-dev/keiko-memory-capture` and wires them.
//
// `VOICE_SESSION_RECAP_SCHEMA_VERSION` follows the sibling evolution rule: a breaking change
// introduces a NEW literal rather than mutating "1", and it is INDEPENDENT of the transcript,
// action-intent, and conversation-capability schema versions. Leaf-package rule (ADR-0019
// direction 1): siblings are reached by relative path only.

import type { VoiceProfile } from "./gateway.js";
import type { VoiceTranscriptEvidenceSummary, VoiceTranscriptSource } from "./voice-transcript.js";
import { isVoiceTranscriptSource, voiceTranscriptCaptureAllowed } from "./voice-transcript.js";

// ─── Schema version ───────────────────────────────────────────────────────────
export const VOICE_SESSION_RECAP_SCHEMA_VERSION = "1" as const;

export type VoiceSessionRecapSchemaVersion = typeof VOICE_SESSION_RECAP_SCHEMA_VERSION;

export function isVoiceSessionRecapSchemaVersionSupported(version: unknown): boolean {
  return version === VOICE_SESSION_RECAP_SCHEMA_VERSION;
}

// ─── Capability gating (AC1) ──────────────────────────────────────────────────
// Derived from the transcript-capture predicate so recap dormancy can never drift from the
// committed-transcript capability: true for "speech-to-text" and "full-realtime", false for "none"
// and "speech-output". Same one-line derivation pattern as `voiceCanProposeAction` (ADR-0108).
export function voiceRecapAllowed(profile: VoiceProfile): boolean {
  return voiceTranscriptCaptureAllowed(profile);
}

// ─── Recap candidate lifecycle ────────────────────────────────────────────────
// Maps onto the existing memory status lifecycle: "proposed" is the ONLY initial state a recap may
// produce; the terminal transitions (accept / reject / forget) are delegated to the existing memory
// review surface — the recap itself never mutates beyond the initial proposal (ADR-0109 D4).
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

// ─── Content-free committed-span descriptor ───────────────────────────────────
// Records WHAT was submitted for extraction without retaining the text itself: ordinal position,
// source modality, and counts only. The extraction input (the span text) exists in the server only
// for the duration of the extraction call.
export interface VoiceRecapCommittedSpanDescriptor {
  readonly schemaVersion: VoiceSessionRecapSchemaVersion;
  readonly spanIndex: number;
  readonly source: VoiceTranscriptSource;
  readonly charCount: number;
  readonly segmentCount: number;
  readonly highestSeq: number;
}

// ─── Content-free assistant-turn descriptor ───────────────────────────────────
// Records that an assistant response occurred at a given turn for auditing purposes only. Assistant
// text is NEVER an extraction input (ADR-0109 D5) and never a field here; "text-response" is the
// only source — no audio/TTS payload descriptor exists by design.
export interface VoiceRecapAssistantTurnDescriptor {
  readonly schemaVersion: VoiceSessionRecapSchemaVersion;
  readonly turnIndex: number;
  readonly source: "text-response";
}

// ─── Evidence summary ─────────────────────────────────────────────────────────
// The recap-level roll-up: the committed transcript evidence summary (reused from
// voice-transcript.ts) plus the extraction outcome counts. "Rejected" means "extracted but not
// surfaced as a proposed candidate" — it counts scanner-rejected, sensitivity-gated, and
// governance-action outcomes alike (ADR-0109 D3).
export interface VoiceSessionRecapEvidenceSummary {
  readonly schemaVersion: VoiceSessionRecapSchemaVersion;
  readonly transcript: VoiceTranscriptEvidenceSummary;
  readonly candidatesExtracted: number;
  readonly candidatesRejected: number;
  readonly candidatesProposed: number;
  readonly triggeredByUser: boolean;
}

// ─── Content-free audit record ────────────────────────────────────────────────
// Mirrors the SpokenActionAuditRecord posture: enums, counts, booleans, and a duration only.
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

// ─── Validation ───────────────────────────────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const VOICE_PROFILES: readonly VoiceProfile[] = [
  "none",
  "speech-to-text",
  "speech-output",
  "full-realtime",
] as const;

function isVoiceProfile(value: unknown): value is VoiceProfile {
  return typeof value === "string" && (VOICE_PROFILES as readonly string[]).includes(value);
}

const AUDIT_COUNT_FIELDS = [
  "committedSegmentCount",
  "committedChars",
  "candidatesExtracted",
  "candidatesRejected",
  "candidatesProposed",
  "durationMs",
] as const;

export function validateVoiceSessionRecapAuditRecord(
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "audit: must be an object" };
  }
  if (!isVoiceSessionRecapSchemaVersionSupported(value.schemaVersion)) {
    return { ok: false, reason: "schemaVersion: unsupported" };
  }
  if (!isVoiceProfile(value.profile)) {
    return { ok: false, reason: "profile: unknown voice profile" };
  }
  for (const field of AUDIT_COUNT_FIELDS) {
    if (!isNonNegativeInteger(value[field])) {
      return { ok: false, reason: `${field}: must be a non-negative integer` };
    }
  }
  if (value.triggeredByUser !== true) {
    // The recap is user-triggered by design (ADR-0109 D2); an audit record claiming otherwise is
    // structurally invalid, which makes the "never automatic" invariant machine-checkable.
    return { ok: false, reason: "triggeredByUser: must be true (recap is user-triggered only)" };
  }
  return { ok: true };
}

// Re-export the guard the descriptors depend on so consumers validating a descriptor's `source` do
// not need a second import site.
export { isVoiceTranscriptSource };
