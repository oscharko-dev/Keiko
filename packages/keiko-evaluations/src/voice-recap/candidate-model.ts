// Content-free candidate model for the voice-recap evaluation (Epic #491, Issue #504; ADR-0067).
//
// The real recap server (Artifact B) derives candidates by calling the EXISTING governed
// `extractCandidatesFromUserText` (keiko-memory-capture), whose `scanForSecrets` rejects credentials
// before any candidate reaches the vault (AC6). This eval does NOT import that package — adding it would
// be a new runtime dependency, and the eval layer is the highest-level policy consumer (nothing below it
// imports memory-capture). Instead this module reproduces the OBSERVABLE governance verdict deterministically
// over the committed projection: a committed span whose text embeds a credential is REJECTED (never stored
// as a record); a clean committed span is PROPOSED with the contract's only initial status "proposed";
// assistant response text is NEVER submitted here (the caller passes only user-spoken committed projections).
//
// This mirrors the modelling posture of the voice-action eval, which reproduces the effect-class taxonomy
// over committed text rather than re-importing the governance scaffold. Pure: no IO, clock, or randomness.
// The verdict and span counts are content-free; the committed text is read here and discarded — it never
// leaves this function.

import {
  VOICE_RECAP_CANDIDATE_STATUSES,
  isVoiceRecapCandidateStatus,
  type CommittedVoiceTranscriptProjection,
  type VoiceRecapCandidateStatus,
} from "@oscharko-dev/keiko-contracts";
import type { VoiceRecapCandidateOutcome } from "./types.js";

// The only initial status a recap candidate may enter. Resolved through the contract guard so the model
// cannot drift from the contract's candidate lifecycle (a typo here fails the guard, not silently).
const PROPOSED_STATUS: VoiceRecapCandidateStatus = resolveProposedStatus();

function resolveProposedStatus(): VoiceRecapCandidateStatus {
  const candidate = VOICE_RECAP_CANDIDATE_STATUSES[0];
  if (!isVoiceRecapCandidateStatus(candidate) || candidate !== "proposed") {
    throw new Error("voice-recap candidate lifecycle no longer starts at 'proposed'");
  }
  return candidate;
}

// Credential / secret shapes that mirror the observable rejection behaviour of `scanForSecrets`: an
// OpenAI-style API key, a bearer token, and an explicit password / secret assignment. A committed span
// whose text matches ANY of these is rejected before it can be proposed (AC6). These are intentionally
// conservative, anchored shapes — the eval proves the REJECTION path is exercised, not that this is the
// production scanner (that lives behind `extractCandidatesFromUserText`).
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9-]{6,}\b/,
  /\bbearer\s+[A-Za-z0-9._-]{8,}\b/i,
  /\b(?:password|secret|api[_-]?key)\s*[:=]\s*\S+/i,
];

// Whether the committed text embeds a credential. Reads the text and returns only a boolean — the text is
// never propagated.
export function committedTextEmbedsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Derive the content-free candidate verdict for one committed projection. A non-empty committed projection
 * whose text embeds a credential is REJECTED (and never stored); an otherwise non-empty committed
 * projection is PROPOSED with status "proposed". An empty committed projection yields no outcome
 * (`undefined`), so partial-only / dormant spans contribute no candidate (AC2 / AC1). Pure.
 */
export function deriveCandidateOutcome(
  projection: CommittedVoiceTranscriptProjection,
): VoiceRecapCandidateOutcome | undefined {
  const spanCharCount = projection.text.length;
  const spanSegmentCount = projection.segmentCount;
  if (spanSegmentCount === 0 || spanCharCount === 0) {
    return undefined;
  }
  if (committedTextEmbedsSecret(projection.text)) {
    return { verdict: "rejected", status: undefined, spanCharCount, spanSegmentCount };
  }
  return { verdict: "proposed", status: PROPOSED_STATUS, spanCharCount, spanSegmentCount };
}
