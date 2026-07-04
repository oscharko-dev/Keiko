// Issue #500 (ADR-0105) — the Voice transcript segment store. Drives the reducer with a deterministic
// SCRIPTED clock (an injected `{ now }` — no fake timers, no performance.now) and the semantic input
// union, pinning the acceptance criteria as executable, mutation-resistant invariants:
//   AC1 — no-voice / speech-output dormancy: zero side effects, the clock is never read.
//   AC2 — STT-only preview + commit / discard semantics.
//   AC3 — partial churn never enters the committed projection (no premature context change).
//   AC4 — provider corrections supersede prior committed text deterministically by seq + id.
//   AC5 — only committed + corrected content is exposed by committed() / the snapshot projection.
//   AC6 — partial instability, late correction, discard, commit, and provider-error cases, plus the
//         content-free observer (transcript text never leaves through the observer).

import { describe, expect, it, vi } from "vitest";
import type { VoiceProfile } from "@/lib/types";
import {
  createVoiceTranscriptSegmentStore,
  type VoiceClock,
  type VoiceTranscriptCommitObservation,
  type VoiceTranscriptSegmentObservation,
  type VoiceTranscriptStoreObserver,
} from "./voice-transcript-segments";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

// A scripted clock: `now()` returns the next scripted value, then holds the last once exhausted, so
// latencyMs is an exact function of the test and no real clock leaks into the engine.
function scriptedClock(values: readonly number[]): VoiceClock {
  let index = 0;
  return {
    now(): number {
      const value = values[Math.min(index, values.length - 1)] ?? 0;
      index += 1;
      return value;
    },
  };
}

// A recording observer that captures every content-free event for assertion.
function recordingObserver(): {
  readonly observer: VoiceTranscriptStoreObserver;
  readonly segments: VoiceTranscriptSegmentObservation[];
  readonly commits: VoiceTranscriptCommitObservation[];
} {
  const segments: VoiceTranscriptSegmentObservation[] = [];
  const commits: VoiceTranscriptCommitObservation[] = [];
  return {
    observer: {
      onSegment: (event): void => {
        segments.push(event);
      },
      onCommit: (event): void => {
        commits.push(event);
      },
    },
    segments,
    commits,
  };
}

// ─── AC1: no-voice / speech-output dormancy ──────────────────────────────────────

describe("AC1 dormancy", () => {
  for (const profile of ["none", "speech-output"] as const satisfies readonly VoiceProfile[]) {
    it(`is dormant and silent for the ${profile} profile`, () => {
      const now = vi.fn<() => number>(() => 0);
      const { observer, segments, commits } = recordingObserver();
      const store = createVoiceTranscriptSegmentStore({ profile, clock: { now }, observer });

      const result = store.apply({ kind: "partial", id: "a", seq: 1, text: "ignored" });

      expect(result.outcome).toBe("not-allowed-for-profile");
      expect(result.snapshot.active).toBe(false);
      expect(result.snapshot.segments).toEqual([]);
      expect(store.committed().segmentCount).toBe(0);
      expect(now).not.toHaveBeenCalled();
      expect(segments).toEqual([]);
      expect(commits).toEqual([]);
    });
  }
});

// ─── AC2: STT-only preview + commit / discard ────────────────────────────────────

describe("AC2 STT preview, commit, and discard", () => {
  it("previews a partial, stabilises it, and commits it without exposing it until commit", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "speech-to-text",
      source: "dictation",
      clock: scriptedClock([10, 20, 30]),
    });

    const previewed = store.apply({ kind: "partial", id: "clip-1", seq: 1, text: "hello wor" });
    expect(previewed.outcome).toBe("applied");
    expect(previewed.snapshot.segments[0]?.state).toBe("partial");
    expect(previewed.snapshot.committed.segmentCount).toBe(0);

    const stabilised = store.apply({ kind: "stabilize", id: "clip-1" });
    expect(stabilised.snapshot.segments[0]?.state).toBe("stable");
    expect(stabilised.snapshot.committed.segmentCount).toBe(0);

    const committed = store.apply({ kind: "commit", id: "clip-1" });
    expect(committed.snapshot.segments[0]?.state).toBe("committed");
    expect(committed.snapshot.committed.text).toBe("hello wor");
    expect(committed.snapshot.summary.committedCount).toBe(1);
  });

  it("records a content-free discarded segment on discard (distinct from a reset)", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "speech-to-text",
      clock: scriptedClock([1, 2]),
    });
    store.apply({ kind: "partial", id: "clip-1", seq: 1, text: "throw away" });

    const discarded = store.apply({ kind: "discard", id: "clip-1" });

    expect(discarded.outcome).toBe("applied");
    expect(discarded.snapshot.segments[0]?.state).toBe("discarded");
    expect(discarded.snapshot.segments[0]?.text).toBe("");
    expect(discarded.snapshot.committed.segmentCount).toBe(0);
    expect(discarded.snapshot.summary.discardedCount).toBe(1);
  });
});

// ─── AC3 / AC6: partial instability ──────────────────────────────────────────────

describe("AC3 partial instability", () => {
  it("absorbs rapid partial churn without ever entering the committed projection", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3, 4, 5]),
    });

    for (const [i, text] of ["h", "he", "hел", "hello"].entries()) {
      const result = store.apply({ kind: "partial", id: "turn-1", seq: i + 1, text });
      expect(result.outcome).toBe("applied");
      expect(result.snapshot.committed.segmentCount).toBe(0);
    }
    const snapshot = store.snapshot();
    expect(snapshot.segments).toHaveLength(1);
    expect(snapshot.segments[0]?.state).toBe("partial");
    expect(snapshot.segments[0]?.text).toBe("hello");
  });

  it("treats an out-of-order (stale) partial as a deterministic no-op", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 5, text: "current" });

    const stale = store.apply({ kind: "partial", id: "turn-1", seq: 2, text: "old" });

    expect(stale.outcome).toBe("no-op");
    expect(stale.snapshot.segments[0]?.text).toBe("current");
  });

  it("ignores a partial that targets an already-finalised segment", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "x" });
    store.apply({ kind: "commit", id: "turn-1", seq: 2 });

    const latePartial = store.apply({ kind: "partial", id: "turn-1", seq: 3, text: "resurrect" });

    expect(latePartial.outcome).toBe("no-op");
    expect(latePartial.snapshot.segments[0]?.state).toBe("committed");
  });
});

// ─── AC4 / AC6: late correction ──────────────────────────────────────────────────

describe("AC4 corrections", () => {
  it("supersedes a prior committed segment with a later corrected segment by id", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "teh cat" });
    store.apply({ kind: "commit", id: "turn-1", seq: 2 });

    const corrected = store.apply({
      kind: "correct",
      id: "turn-1-fix",
      seq: 3,
      text: "the cat",
      supersedesId: "turn-1",
    });

    expect(corrected.outcome).toBe("applied");
    expect(corrected.snapshot.committed.text).toBe("the cat");
    expect(corrected.snapshot.committed.segments.map((s) => s.id)).toEqual(["turn-1-fix"]);
  });

  it("corrects a committed segment in place, bumping its revision deterministically", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3, 4]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "draft" });
    store.apply({ kind: "commit", id: "turn-1", seq: 2 });

    const first = store.apply({ kind: "correct", id: "turn-1", seq: 3, text: "final" });
    expect(first.snapshot.segments[0]?.state).toBe("corrected");
    expect(first.snapshot.segments[0]?.revision).toBe(1);
    expect(first.snapshot.committed.text).toBe("final");

    const second = store.apply({ kind: "correct", id: "turn-1", seq: 4, text: "final v2" });
    expect(second.snapshot.segments[0]?.revision).toBe(2);
    expect(second.snapshot.committed.text).toBe("final v2");
  });

  it("treats a stale or out-of-order correction as a no-op", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 5, text: "x" });
    store.apply({ kind: "commit", id: "turn-1", seq: 5 });

    const stale = store.apply({ kind: "correct", id: "turn-1", seq: 5, text: "stale" });

    expect(stale.outcome).toBe("no-op");
    expect(stale.snapshot.segments[0]?.state).toBe("committed");
  });

  it("corrects a stable (provider-final, not-yet-committed) segment", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "draft" });
    store.apply({ kind: "stabilize", id: "turn-1", seq: 2 });

    const corrected = store.apply({ kind: "correct", id: "turn-1", seq: 3, text: "final" });

    expect(corrected.outcome).toBe("applied");
    expect(corrected.snapshot.segments[0]?.state).toBe("corrected");
    expect(corrected.snapshot.segments[0]?.revision).toBe(1);
    expect(corrected.snapshot.committed.text).toBe("final");
  });

  it("does not correct an in-flight partial", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "x" });

    const result = store.apply({ kind: "correct", id: "turn-1", seq: 2, text: "no" });

    expect(result.outcome).toBe("no-op");
    expect(result.snapshot.segments[0]?.state).toBe("partial");
  });

  it("does not resurface superseded text when the superseding correction is later discarded", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3, 4]),
    });
    store.apply({ kind: "partial", id: "orig", seq: 1, text: "OLD SENSITIVE WRONG TEXT" });
    store.apply({ kind: "commit", id: "orig", seq: 2 });
    store.apply({ kind: "correct", id: "fix", seq: 3, text: "the cat", supersedesId: "orig" });

    const discarded = store.apply({ kind: "discard", id: "fix" });

    // Neither the discarded correction nor the superseded original may appear downstream.
    expect(discarded.snapshot.committed.segmentCount).toBe(0);
    expect(discarded.snapshot.committed.text).toBe("");
  });

  it("does not resurface superseded text when the superseding correction is later redacted", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3, 4]),
    });
    store.apply({ kind: "partial", id: "orig", seq: 1, text: "OLD SENSITIVE WRONG TEXT" });
    store.apply({ kind: "commit", id: "orig", seq: 2 });
    store.apply({ kind: "correct", id: "fix", seq: 3, text: "the cat", supersedesId: "orig" });

    const redacted = store.apply({ kind: "redact", id: "fix" });

    expect(redacted.snapshot.committed.segmentCount).toBe(0);
    expect(redacted.snapshot.committed.text).toBe("");
  });

  it("creates a corrected segment when the correction arrives for an unknown id", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1]),
    });

    const result = store.apply({ kind: "correct", id: "fresh", seq: 7, text: "corrected text" });

    expect(result.outcome).toBe("applied");
    expect(result.snapshot.segments[0]?.state).toBe("corrected");
    expect(result.snapshot.segments[0]?.revision).toBe(1);
    expect(result.snapshot.committed.text).toBe("corrected text");
  });
});

// ─── AC6: commit edge cases ──────────────────────────────────────────────────────

describe("AC6 commit", () => {
  it("commits a stable segment as well as a partial one", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "via stable" });
    store.apply({ kind: "stabilize", id: "turn-1", seq: 2, text: "via stable!" });

    const committed = store.apply({ kind: "commit", id: "turn-1", seq: 3 });

    expect(committed.snapshot.segments[0]?.state).toBe("committed");
    expect(committed.snapshot.committed.text).toBe("via stable!");
  });

  it("is a no-op to commit an unknown or already-committed segment", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
    });
    expect(store.apply({ kind: "commit", id: "missing" }).outcome).toBe("no-op");

    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "x" });
    store.apply({ kind: "commit", id: "turn-1", seq: 2 });
    expect(store.apply({ kind: "commit", id: "turn-1", seq: 3 }).outcome).toBe("no-op");
  });
});

// ─── AC6: provider-error ─────────────────────────────────────────────────────────

describe("AC6 provider-error", () => {
  it("transitions an in-flight partial to provider-error, excluding it from the projection", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "speech-to-text",
      clock: scriptedClock([1, 2]),
    });
    store.apply({ kind: "partial", id: "clip-1", seq: 1, text: "half a sentence" });

    const errored = store.apply({
      kind: "providerError",
      id: "clip-1",
      providerErrorKind: "timeout",
    });

    expect(errored.outcome).toBe("applied");
    expect(errored.snapshot.segments[0]?.state).toBe("provider-error");
    expect(errored.snapshot.segments[0]?.providerErrorKind).toBe("timeout");
    expect(errored.snapshot.segments[0]?.text).toBe("");
    expect(errored.snapshot.committed.segmentCount).toBe(0);
    expect(errored.snapshot.summary.providerErrorCount).toBe(1);
  });

  it("records a provider-error segment when the failure arrives for an unknown id", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "speech-to-text",
      clock: scriptedClock([1]),
    });

    const result = store.apply({
      kind: "providerError",
      id: "clip-1",
      seq: 4,
      providerErrorKind: "rate-limited",
    });

    expect(result.outcome).toBe("applied");
    expect(result.snapshot.segments[0]?.state).toBe("provider-error");
    expect(result.snapshot.highestSeq).toBe(4);
  });

  it("stamps a seqless provider-error for an unknown id with the current highest seq", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 3, text: "x" });

    const result = store.apply({
      kind: "providerError",
      id: "turn-2",
      providerErrorKind: "unavailable",
    });

    expect(result.outcome).toBe("applied");
    expect(result.snapshot.segments.find((s) => s.id === "turn-2")?.seq).toBe(3);
  });

  it("does not fail a committed segment after the fact", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "x" });
    store.apply({ kind: "commit", id: "turn-1", seq: 2 });

    const result = store.apply({
      kind: "providerError",
      id: "turn-1",
      providerErrorKind: "internal",
    });

    expect(result.outcome).toBe("no-op");
    expect(result.snapshot.segments[0]?.state).toBe("committed");
  });
});

// ─── Redaction ───────────────────────────────────────────────────────────────────

describe("redaction", () => {
  it("redacts a committed segment, clearing its text and excluding it from the projection", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "sensitive" });
    store.apply({ kind: "commit", id: "turn-1", seq: 2 });

    const redacted = store.apply({ kind: "redact", id: "turn-1" });

    expect(redacted.outcome).toBe("applied");
    expect(redacted.snapshot.segments[0]?.state).toBe("redacted");
    expect(redacted.snapshot.segments[0]?.text).toBe("");
    expect(redacted.snapshot.committed.segmentCount).toBe(0);
    expect(redacted.snapshot.summary.redactedCount).toBe(1);
  });

  it("is a no-op to redact an unknown, discarded, or already-redacted segment", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3, 4]),
    });
    expect(store.apply({ kind: "redact", id: "missing" }).outcome).toBe("no-op");

    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "x" });
    store.apply({ kind: "discard", id: "turn-1" });
    expect(store.apply({ kind: "redact", id: "turn-1" }).outcome).toBe("no-op");
  });

  it("is a no-op to discard an unknown, already-discarded, or redacted segment", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
    });
    expect(store.apply({ kind: "discard", id: "missing" }).outcome).toBe("no-op");

    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "x" });
    store.apply({ kind: "redact", id: "turn-1" });
    expect(store.apply({ kind: "discard", id: "turn-1" }).outcome).toBe("no-op");
  });
});

// ─── Stabilize edge cases ────────────────────────────────────────────────────────

describe("stabilize", () => {
  it("is a no-op to stabilize an unknown or non-partial segment", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
    });
    expect(store.apply({ kind: "stabilize", id: "missing" }).outcome).toBe("no-op");

    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "x" });
    store.apply({ kind: "commit", id: "turn-1", seq: 2 });
    expect(store.apply({ kind: "stabilize", id: "turn-1" }).outcome).toBe("no-op");
  });

  it("keeps the prior seq and text when stabilize omits them", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 4, text: "kept" });

    const stabilised = store.apply({ kind: "stabilize", id: "turn-1" });

    expect(stabilised.snapshot.segments[0]?.seq).toBe(4);
    expect(stabilised.snapshot.segments[0]?.text).toBe("kept");
  });
});

// ─── AC5: committed-only projection invariant ────────────────────────────────────

describe("AC5 committed-only projection", () => {
  it("exposes only committed and corrected segments across a mixed transcript", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    });
    store.apply({ kind: "partial", id: "p", seq: 1, text: "partial" });
    store.apply({ kind: "partial", id: "s", seq: 2, text: "stable-text" });
    store.apply({ kind: "stabilize", id: "s", seq: 3 });
    store.apply({ kind: "partial", id: "c", seq: 4, text: "committed-text" });
    store.apply({ kind: "commit", id: "c", seq: 5 });
    store.apply({ kind: "partial", id: "d", seq: 6, text: "dropped" });
    store.apply({ kind: "discard", id: "d" });
    store.apply({ kind: "partial", id: "e", seq: 7, text: "errored" });
    store.apply({ kind: "providerError", id: "e", providerErrorKind: "provider-error" });

    const projection = store.committed();
    expect(projection.segments.map((seg) => seg.state)).toEqual(["committed"]);
    expect(projection.text).toBe("committed-text");
    expect(store.summary().segmentCount).toBe(5);
  });
});

// ─── AC6: content-free observer ──────────────────────────────────────────────────

describe("AC6 content-free observer", () => {
  const ALLOWED_SEGMENT_KEYS = new Set([
    "id",
    "inputKind",
    "from",
    "to",
    "seq",
    "revision",
    "latencyMs",
  ]);

  it("never passes transcript text through the observer and fires onCommit only on committed change", () => {
    const secret = "SUPER_SECRET_TRANSCRIPT_PAYLOAD";
    const { observer, segments, commits } = recordingObserver();
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([100, 200, 300, 400]),
      observer,
    });

    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: secret });
    expect(commits).toHaveLength(0); // a preview is not a committed change
    store.apply({ kind: "stabilize", id: "turn-1", seq: 2 });
    store.apply({ kind: "commit", id: "turn-1", seq: 3 });
    store.apply({ kind: "correct", id: "turn-1", seq: 4, text: `${secret}-corrected` });

    const serialised = JSON.stringify([...segments, ...commits]);
    expect(serialised).not.toContain("SECRET");
    expect(serialised).not.toContain("PAYLOAD");
    for (const event of segments) {
      for (const key of Object.keys(event)) {
        expect(ALLOWED_SEGMENT_KEYS.has(key)).toBe(true);
      }
    }
    // commit + correction both change the committed projection -> two onCommit events.
    expect(commits).toHaveLength(2);
    expect(commits[1]).toEqual({ committedCount: 1, committedChars: `${secret}-corrected`.length });
  });

  it("fires onCommit for a same-length correction the character count alone could not detect", () => {
    const { observer, commits } = recordingObserver();
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
      observer,
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "teh" });
    store.apply({ kind: "commit", id: "turn-1", seq: 2 });
    expect(commits).toHaveLength(1);

    // "teh" -> "the": same length, different content. Membership-based detection still fires.
    store.apply({ kind: "correct", id: "turn-1", seq: 3, text: "the" });

    expect(commits).toHaveLength(2);
    expect(commits[1]).toEqual({ committedCount: 1, committedChars: 3 });
  });

  it("fires onCommit when a committed segment is discarded (leaves the projection)", () => {
    const { observer, commits } = recordingObserver();
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3]),
      observer,
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "x" });
    store.apply({ kind: "commit", id: "turn-1", seq: 2 });

    store.apply({ kind: "discard", id: "turn-1" });

    expect(commits).toHaveLength(2);
    expect(commits[1]).toEqual({ committedCount: 0, committedChars: 0 });
  });

  it("reports the same committedChars in onCommit and the evidence summary for a multi-segment transcript", () => {
    const { observer, commits } = recordingObserver();
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2, 3, 4]),
      observer,
    });
    store.apply({ kind: "partial", id: "a", seq: 1, text: "hello" });
    store.apply({ kind: "commit", id: "a", seq: 2 });
    store.apply({ kind: "partial", id: "b", seq: 3, text: "world!" });
    const last = store.apply({ kind: "commit", id: "b", seq: 4 });

    const summaryChars = last.snapshot.summary.committedChars;
    const onCommitChars = commits[commits.length - 1]?.committedChars;
    expect(summaryChars).toBe(last.snapshot.committed.text.length);
    expect(onCommitChars).toBe(summaryChars);
  });

  it("reports the first transition latency as zero and a later one as the clock delta", () => {
    const { observer, segments } = recordingObserver();
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([100, 250]),
      observer,
    });

    store.apply({ kind: "partial", id: "turn-1", seq: 1, text: "a" });
    store.apply({ kind: "commit", id: "turn-1", seq: 2 });

    expect(segments[0]?.latencyMs).toBe(0);
    expect(segments[1]?.latencyMs).toBe(150);
  });
});

// ─── Snapshot, summary, reset, source ────────────────────────────────────────────

describe("store lifecycle", () => {
  it("defaults source to realtime and honours an explicit dictation source", () => {
    const realtime = createVoiceTranscriptSegmentStore({ profile: "full-realtime" });
    expect(realtime.snapshot().source).toBe("realtime");

    const dictation = createVoiceTranscriptSegmentStore({
      profile: "speech-to-text",
      source: "dictation",
      clock: scriptedClock([1]),
    });
    const applied = dictation.apply({ kind: "partial", id: "clip-1", seq: 1, text: "x" });
    expect(applied.snapshot.segments[0]?.source).toBe("dictation");
  });

  it("reset() clears all segments and the highest seq", () => {
    const store = createVoiceTranscriptSegmentStore({
      profile: "full-realtime",
      clock: scriptedClock([1, 2]),
    });
    store.apply({ kind: "partial", id: "turn-1", seq: 9, text: "x" });
    store.apply({ kind: "commit", id: "turn-1" });
    expect(store.snapshot().highestSeq).toBe(9);

    store.reset();

    expect(store.snapshot().segments).toEqual([]);
    expect(store.snapshot().highestSeq).toBe(0);
    expect(store.committed().segmentCount).toBe(0);
  });
});
