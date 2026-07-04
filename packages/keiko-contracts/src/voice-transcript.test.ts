// Regression tests for the Voice Digital Twin transcript segment lifecycle contract (Issue #500,
// ADR-0105). These pin the acceptance criteria as executable, mutation-resistant invariants:
//   AC4 — provider corrections replace prior text deterministically (a corrected segment supersedes the
//         prior committed segment by id; the committed projection excludes the superseded id).
//   AC5 — memory / workflow integrations consume ONLY committed content: `selectCommittedVoiceTranscript`
//         returns committed + corrected segments only, and `summarizeVoiceTranscript` is content-free.
//   AC1/AC2/AC3 admission gating is derived from the wire contract, not re-encoded.
// The module is pure; these tests read no clock and perform no IO.

import { describe, expect, it } from "vitest";
import type { VoiceProfile } from "./gateway.js";
import type { VoiceControlMessageKind } from "./voice-protocol.js";
import { VOICE_CONTROL_MESSAGE_KINDS } from "./voice-protocol.js";
import {
  VOICE_TRANSCRIPT_CONSUMABLE_STATES,
  VOICE_TRANSCRIPT_PROVIDER_ERROR_KINDS,
  VOICE_TRANSCRIPT_SCHEMA_VERSION,
  VOICE_TRANSCRIPT_SEGMENT_REDACTION,
  VOICE_TRANSCRIPT_SEGMENT_REPLAY,
  VOICE_TRANSCRIPT_SEGMENT_STATES,
  VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS,
  VOICE_TRANSCRIPT_SOURCES,
  type CommittedVoiceTranscriptProjection,
  type VoiceTranscriptSegment,
  type VoiceTranscriptSegmentState,
  assertNeverVoiceTranscriptSegmentState,
  canTransitionVoiceTranscriptSegment,
  isCommittedVoiceTranscriptState,
  isVoiceTranscriptProviderErrorKind,
  isVoiceTranscriptSchemaVersionSupported,
  isVoiceTranscriptSegmentState,
  isVoiceTranscriptSource,
  mapWireKindToVoiceTranscriptSegmentState,
  selectCommittedVoiceTranscript,
  summarizeVoiceTranscript,
  voiceTranscriptCaptureAllowed,
  voiceTranscriptPreviewAllowed,
  voiceTranscriptSegmentRedactionClass,
  voiceTranscriptSegmentReplayClass,
} from "./voice-transcript.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function segment(
  partial: Partial<VoiceTranscriptSegment> & {
    id: string;
    seq: number;
    state: VoiceTranscriptSegmentState;
  },
): VoiceTranscriptSegment {
  return {
    text: "",
    source: "realtime",
    revision: 0,
    replayClass: voiceTranscriptSegmentReplayClass(partial.state),
    redactionClass: voiceTranscriptSegmentRedactionClass(partial.state),
    ...partial,
  };
}

const ALL_PROFILES: readonly VoiceProfile[] = [
  "none",
  "speech-to-text",
  "speech-output",
  "full-realtime",
];

// ─── Schema version ──────────────────────────────────────────────────────────────

describe("schema version", () => {
  it("pins the schema version independently of the wire protocol version", () => {
    expect(VOICE_TRANSCRIPT_SCHEMA_VERSION).toBe("1");
  });

  it("accepts only the supported schema version", () => {
    expect(isVoiceTranscriptSchemaVersionSupported("1")).toBe(true);
    expect(isVoiceTranscriptSchemaVersionSupported("2")).toBe(false);
    expect(isVoiceTranscriptSchemaVersionSupported(1)).toBe(false);
    expect(isVoiceTranscriptSchemaVersionSupported(undefined)).toBe(false);
  });
});

// ─── State catalog ───────────────────────────────────────────────────────────────

describe("segment state catalog", () => {
  it("pins exactly the seven lifecycle states", () => {
    expect([...VOICE_TRANSCRIPT_SEGMENT_STATES]).toEqual([
      "partial",
      "stable",
      "committed",
      "corrected",
      "discarded",
      "redacted",
      "provider-error",
    ]);
  });

  it("pins the consumable states to committed + corrected only", () => {
    expect([...VOICE_TRANSCRIPT_CONSUMABLE_STATES]).toEqual(["committed", "corrected"]);
  });

  it("pins the provider error taxonomy and segment sources", () => {
    expect([...VOICE_TRANSCRIPT_PROVIDER_ERROR_KINDS]).toEqual([
      "rate-limited",
      "timeout",
      "provider-error",
      "unavailable",
      "internal",
    ]);
    expect([...VOICE_TRANSCRIPT_SOURCES]).toEqual(["dictation", "realtime"]);
  });

  it("classifies replay + redaction for every state (totality)", () => {
    for (const state of VOICE_TRANSCRIPT_SEGMENT_STATES) {
      expect(VOICE_TRANSCRIPT_SEGMENT_REPLAY[state]).toBeDefined();
      expect(VOICE_TRANSCRIPT_SEGMENT_REDACTION[state]).toBeDefined();
      expect(voiceTranscriptSegmentReplayClass(state)).toBe(VOICE_TRANSCRIPT_SEGMENT_REPLAY[state]);
      expect(voiceTranscriptSegmentRedactionClass(state)).toBe(
        VOICE_TRANSCRIPT_SEGMENT_REDACTION[state],
      );
    }
  });

  it("aligns replay classes with the lifecycle (partial/stable ephemeral, the rest replayable)", () => {
    expect(VOICE_TRANSCRIPT_SEGMENT_REPLAY.partial).toBe("ephemeral");
    expect(VOICE_TRANSCRIPT_SEGMENT_REPLAY.stable).toBe("ephemeral");
    for (const state of [
      "committed",
      "corrected",
      "discarded",
      "redacted",
      "provider-error",
    ] as const) {
      expect(VOICE_TRANSCRIPT_SEGMENT_REPLAY[state]).toBe("replayable");
    }
  });

  it("aligns redaction classes (text-bearing reviewable-text, the rest content-free)", () => {
    for (const state of ["partial", "stable", "committed", "corrected"] as const) {
      expect(VOICE_TRANSCRIPT_SEGMENT_REDACTION[state]).toBe("reviewable-text");
    }
    for (const state of ["discarded", "redacted", "provider-error"] as const) {
      expect(VOICE_TRANSCRIPT_SEGMENT_REDACTION[state]).toBe("content-free");
    }
  });
});

// ─── Type guards ─────────────────────────────────────────────────────────────────

describe("type guards", () => {
  it("recognises valid and rejects invalid segment states", () => {
    for (const state of VOICE_TRANSCRIPT_SEGMENT_STATES) {
      expect(isVoiceTranscriptSegmentState(state)).toBe(true);
    }
    expect(isVoiceTranscriptSegmentState("final")).toBe(false);
    expect(isVoiceTranscriptSegmentState(42)).toBe(false);
    expect(isVoiceTranscriptSegmentState(undefined)).toBe(false);
  });

  it("recognises valid and rejects invalid provider error kinds", () => {
    for (const kind of VOICE_TRANSCRIPT_PROVIDER_ERROR_KINDS) {
      expect(isVoiceTranscriptProviderErrorKind(kind)).toBe(true);
    }
    expect(isVoiceTranscriptProviderErrorKind("boom")).toBe(false);
    expect(isVoiceTranscriptProviderErrorKind(null)).toBe(false);
  });

  it("recognises valid and rejects invalid sources", () => {
    expect(isVoiceTranscriptSource("dictation")).toBe(true);
    expect(isVoiceTranscriptSource("realtime")).toBe(true);
    expect(isVoiceTranscriptSource("telepathy")).toBe(false);
    expect(isVoiceTranscriptSource(7)).toBe(false);
  });

  it("classifies committed states (committed + corrected) as consumable", () => {
    expect(isCommittedVoiceTranscriptState("committed")).toBe(true);
    expect(isCommittedVoiceTranscriptState("corrected")).toBe(true);
    for (const state of ["partial", "stable", "discarded", "redacted", "provider-error"] as const) {
      expect(isCommittedVoiceTranscriptState(state)).toBe(false);
    }
  });

  it("assertNeverVoiceTranscriptSegmentState throws when reached", () => {
    expect(() =>
      // A deliberately unreachable cast to exercise the exhaustiveness guard at runtime.
      assertNeverVoiceTranscriptSegmentState("nonexistent" as never),
    ).toThrow(/unhandled voice transcript segment state/);
  });
});

// ─── Transition table ────────────────────────────────────────────────────────────

describe("transition table", () => {
  it("classifies legal targets for every state (totality)", () => {
    for (const state of VOICE_TRANSCRIPT_SEGMENT_STATES) {
      expect(Array.isArray(VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS[state])).toBe(true);
    }
  });

  it("makes discarded and redacted terminal", () => {
    expect([...VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS.discarded]).toEqual([]);
    expect([...VOICE_TRANSCRIPT_SEGMENT_TRANSITIONS.redacted]).toEqual([]);
    expect(canTransitionVoiceTranscriptSegment("discarded", "committed")).toBe(false);
    expect(canTransitionVoiceTranscriptSegment("redacted", "committed")).toBe(false);
  });

  it("allows the canonical preview -> commit -> correct path", () => {
    expect(canTransitionVoiceTranscriptSegment("partial", "stable")).toBe(true);
    expect(canTransitionVoiceTranscriptSegment("partial", "committed")).toBe(true);
    expect(canTransitionVoiceTranscriptSegment("stable", "committed")).toBe(true);
    expect(canTransitionVoiceTranscriptSegment("committed", "corrected")).toBe(true);
  });

  it("forbids correcting an in-flight partial and regressing committed text to provider-error", () => {
    expect(canTransitionVoiceTranscriptSegment("partial", "corrected")).toBe(false);
    expect(canTransitionVoiceTranscriptSegment("committed", "provider-error")).toBe(false);
    expect(canTransitionVoiceTranscriptSegment("corrected", "provider-error")).toBe(false);
  });
});

// ─── Wire-kind mapping ───────────────────────────────────────────────────────────

describe("wire-kind mapping", () => {
  it("maps only the three transcript wire kinds to states", () => {
    expect(mapWireKindToVoiceTranscriptSegmentState("transcript.partial")).toBe("partial");
    expect(mapWireKindToVoiceTranscriptSegmentState("transcript.committed")).toBe("committed");
    expect(mapWireKindToVoiceTranscriptSegmentState("transcript.discarded")).toBe("discarded");
  });

  it("returns undefined for every non-transcript control kind", () => {
    const transcriptKinds = new Set<VoiceControlMessageKind>([
      "transcript.partial",
      "transcript.committed",
      "transcript.discarded",
    ]);
    for (const kind of VOICE_CONTROL_MESSAGE_KINDS) {
      if (!transcriptKinds.has(kind)) {
        expect(mapWireKindToVoiceTranscriptSegmentState(kind)).toBeUndefined();
      }
    }
  });
});

// ─── Capability gating (AC1/AC2/AC3) ─────────────────────────────────────────────

describe("capability gating", () => {
  it("permits transcript capture + preview only for speech-to-text and full-realtime", () => {
    const expected: Record<VoiceProfile, boolean> = {
      none: false,
      "speech-to-text": true,
      "speech-output": false,
      "full-realtime": true,
    };
    for (const profile of ALL_PROFILES) {
      expect(voiceTranscriptCaptureAllowed(profile)).toBe(expected[profile]);
      expect(voiceTranscriptPreviewAllowed(profile)).toBe(expected[profile]);
    }
  });
});

// ─── Committed-only projection (AC5) + corrections (AC4) ──────────────────────────

describe("selectCommittedVoiceTranscript (AC5)", () => {
  it("returns only committed + corrected segments, excluding every other state", () => {
    const segments: readonly VoiceTranscriptSegment[] = [
      segment({ id: "a", seq: 1, state: "partial", text: "par" }),
      segment({ id: "b", seq: 2, state: "stable", text: "sta" }),
      segment({ id: "c", seq: 3, state: "committed", text: "hello" }),
      segment({ id: "d", seq: 4, state: "discarded" }),
      segment({ id: "e", seq: 5, state: "redacted" }),
      segment({ id: "f", seq: 6, state: "provider-error", providerErrorKind: "timeout" }),
      segment({ id: "g", seq: 7, state: "corrected", text: "world" }),
    ];
    const projection = selectCommittedVoiceTranscript(segments);
    expect(projection.segments.map((s) => s.id)).toEqual(["c", "g"]);
    expect(projection.segmentCount).toBe(2);
    expect(projection.text).toBe("hello world");
    expect(projection.schemaVersion).toBe("1");
  });

  it("orders the projection deterministically by seq, breaking ties by id", () => {
    const segments: readonly VoiceTranscriptSegment[] = [
      segment({ id: "z", seq: 5, state: "committed", text: "five-z" }),
      segment({ id: "a", seq: 5, state: "committed", text: "five-a" }),
      segment({ id: "m", seq: 1, state: "committed", text: "one" }),
    ];
    const projection = selectCommittedVoiceTranscript(segments);
    expect(projection.segments.map((s) => s.id)).toEqual(["m", "a", "z"]);
    expect(projection.text).toBe("one five-a five-z");
  });

  it("breaks a seq tie by id regardless of input order", () => {
    const ascending = selectCommittedVoiceTranscript([
      segment({ id: "a", seq: 5, state: "committed", text: "A" }),
      segment({ id: "b", seq: 5, state: "committed", text: "B" }),
    ]);
    const descending = selectCommittedVoiceTranscript([
      segment({ id: "b", seq: 5, state: "committed", text: "B" }),
      segment({ id: "a", seq: 5, state: "committed", text: "A" }),
    ]);
    expect(ascending.segments.map((s) => s.id)).toEqual(["a", "b"]);
    expect(descending.segments.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("excludes an empty committed segment from the concatenated text but keeps it as a segment", () => {
    const segments: readonly VoiceTranscriptSegment[] = [
      segment({ id: "a", seq: 1, state: "committed", text: "" }),
      segment({ id: "b", seq: 2, state: "committed", text: "kept" }),
    ];
    const projection = selectCommittedVoiceTranscript(segments);
    expect(projection.segmentCount).toBe(2);
    expect(projection.text).toBe("kept");
  });

  it("excludes a committed segment that a later correction supersedes by id (AC4 replace)", () => {
    const segments: readonly VoiceTranscriptSegment[] = [
      segment({ id: "orig", seq: 1, state: "committed", text: "teh cat" }),
      segment({ id: "fix", seq: 2, state: "corrected", text: "the cat", supersedesId: "orig" }),
    ];
    const projection = selectCommittedVoiceTranscript(segments);
    expect(projection.segments.map((s) => s.id)).toEqual(["fix"]);
    expect(projection.text).toBe("the cat");
  });

  it("keeps a superseded segment excluded even after the superseding segment is discarded/redacted", () => {
    // The superseder carries supersedesId but is itself no longer 'corrected' (it was discarded). The
    // superseded original must NOT resurface into the consumable projection (AC5 / privacy).
    const segments: readonly VoiceTranscriptSegment[] = [
      segment({ id: "orig", seq: 1, state: "committed", text: "OLD WRONG TEXT" }),
      segment({ id: "fix", seq: 2, state: "discarded", supersedesId: "orig" }),
    ];
    const projection = selectCommittedVoiceTranscript(segments);
    expect(projection.segmentCount).toBe(0);
    expect(projection.text).toBe("");
  });

  it("returns an empty projection when nothing is committed", () => {
    const segments: readonly VoiceTranscriptSegment[] = [
      segment({ id: "a", seq: 1, state: "partial", text: "x" }),
    ];
    const projection: CommittedVoiceTranscriptProjection = selectCommittedVoiceTranscript(segments);
    expect(projection.segmentCount).toBe(0);
    expect(projection.text).toBe("");
    expect(projection.segments).toEqual([]);
  });
});

// ─── Evidence-safe summary (AC5) ─────────────────────────────────────────────────

describe("summarizeVoiceTranscript (AC5 evidence-safe)", () => {
  it("rolls up content-free counts, the committed character length, and the highest seq", () => {
    const segments: readonly VoiceTranscriptSegment[] = [
      segment({ id: "a", seq: 1, state: "partial", text: "par" }),
      segment({ id: "b", seq: 3, state: "committed", text: "hello" }),
      segment({ id: "c", seq: 9, state: "corrected", text: "world!" }),
      segment({ id: "d", seq: 2, state: "discarded" }),
      segment({ id: "e", seq: 4, state: "redacted" }),
      segment({ id: "f", seq: 5, state: "provider-error", providerErrorKind: "timeout" }),
    ];
    const summary = summarizeVoiceTranscript(segments);
    expect(summary).toEqual({
      schemaVersion: "1",
      segmentCount: 6,
      committedCount: 1,
      correctedCount: 1,
      discardedCount: 1,
      redactedCount: 1,
      providerErrorCount: 1,
      // "hello" + " " + "world!" — the joined projection text length, matching onCommit.
      committedChars: 12,
      highestSeq: 9,
    });
  });

  it("reports zero counts and seq for an empty transcript", () => {
    const summary = summarizeVoiceTranscript([]);
    expect(summary.segmentCount).toBe(0);
    expect(summary.committedChars).toBe(0);
    expect(summary.highestSeq).toBe(0);
  });
});
