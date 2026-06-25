// Deterministic transcript-segment builders for the voice-action fixtures (Epic #491, Issue #503).
//
// Fixtures supply REAL `VoiceTranscriptSegment` values so the runner can pipe them through the contract
// boundary `selectCommittedVoiceTranscript`. That proves the committed-only guarantee (AC2) structurally
// — a partial / discarded / superseded segment physically present in a fixture cannot reach the proposal
// — rather than asserting it. These builders are pure data factories: no IO, clock, or randomness.

import type {
  VoiceTranscriptSegment,
  VoiceTranscriptSegmentState,
  VoiceTranscriptSource,
} from "@oscharko-dev/keiko-contracts";
import {
  voiceTranscriptSegmentRedactionClass,
  voiceTranscriptSegmentReplayClass,
} from "@oscharko-dev/keiko-contracts";

export interface SegmentSpec {
  readonly id: string;
  readonly seq: number;
  readonly state: VoiceTranscriptSegmentState;
  readonly text: string;
  readonly supersedesId?: string;
}

// Build one segment, deriving the replay / redaction classes from the contract tables so the fixtures
// never re-encode classification (a single source of truth keeps them aligned with the lifecycle).
export function buildSegment(
  spec: SegmentSpec,
  source: VoiceTranscriptSource,
): VoiceTranscriptSegment {
  return {
    id: spec.id,
    seq: spec.seq,
    state: spec.state,
    text: spec.text,
    source,
    revision: spec.supersedesId === undefined ? 0 : 1,
    replayClass: voiceTranscriptSegmentReplayClass(spec.state),
    redactionClass: voiceTranscriptSegmentRedactionClass(spec.state),
    supersedesId: spec.supersedesId,
  };
}

export function buildSegments(
  specs: readonly SegmentSpec[],
  source: VoiceTranscriptSource,
): readonly VoiceTranscriptSegment[] {
  return specs.map((spec) => buildSegment(spec, source));
}
