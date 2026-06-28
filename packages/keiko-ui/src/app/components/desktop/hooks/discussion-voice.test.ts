// Issue #502 (ADR-0065) — the Voice ↔ Discussion intelligence binding. Proves the four issue ACs the
// binding is responsible for: text-first dormancy for `none` / `speech-output` (AC1), committed-only
// spoken input (AC5), mode reuse through the SAME contract plan (AC2), and interruption → recovery
// without losing the active mode / topicId / turnIndex (AC4). It also pins the content-free observer:
// no event field carries text, a topicId, or transcript content.

import { describe, expect, it, vi } from "vitest";
import type { VoiceProfile } from "@/lib/types";
import {
  DISCUSSION_MODE_PLANS,
  type DiscussionMode,
  type VoiceTranscriptSegment,
} from "@oscharko-dev/keiko-contracts";
import {
  VOICE_DISCUSSION_INTENTS,
  type DiscussionVoiceBinding,
  type DiscussionVoiceObserver,
  type VoiceDiscussionIntent,
  createDiscussionVoiceBinding,
  isVoiceDiscussionIntent,
} from "./discussion-voice";
import type { VoiceTurnSnapshot } from "./voice-turn-manager";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeBinding(
  profile: VoiceProfile,
  observer?: DiscussionVoiceObserver,
): DiscussionVoiceBinding {
  return createDiscussionVoiceBinding({ profile, observer });
}

// A transcript segment fixture. Only `state`, `text`, `seq`, `id` matter to the committed projection;
// the rest are filled with content-free defaults so the projection behaves like the live reducer.
function segment(partial: Partial<VoiceTranscriptSegment>): VoiceTranscriptSegment {
  return {
    id: partial.id ?? "seg-0",
    seq: partial.seq ?? 0,
    state: partial.state ?? "committed",
    text: partial.text ?? "",
    source: partial.source ?? "realtime",
    revision: partial.revision ?? 0,
    replayClass: partial.replayClass ?? "replayable",
    redactionClass: partial.redactionClass ?? "reviewable-text",
    supersedesId: partial.supersedesId,
    providerErrorKind: partial.providerErrorKind,
  };
}

// A minimal #499 turn-manager snapshot carrying only the fields the binding observes.
function turnSnapshot(state: VoiceTurnSnapshot["state"], recovering: boolean): VoiceTurnSnapshot {
  return {
    profile: "full-realtime",
    active: true,
    state,
    floorHolder: "none",
    turnIndex: 0,
    interruptions: 0,
    backchannels: 0,
    pendingCommit: false,
    recovering,
    lastEndOfTurnAtMs: undefined,
    lastInterruptAtMs: undefined,
  };
}

const DRIVING_PROFILES: readonly VoiceProfile[] = ["speech-to-text", "full-realtime"];
const DORMANT_PROFILES: readonly VoiceProfile[] = ["none", "speech-output"];

// ─── Capability gating / dormancy (AC1 text-first) ───────────────────────────────

describe("dormancy for non-driving profiles (AC1)", () => {
  it.each(DORMANT_PROFILES)("%s does no discussion work", (profile) => {
    const observer: Required<DiscussionVoiceObserver> = {
      onModeSelected: vi.fn(),
      onTurnStatus: vi.fn(),
      onCommittedInput: vi.fn(),
    };
    const binding = makeBinding(profile, observer);

    expect(binding.canDrive()).toBe(false);
    // No mode is ever selected from a spoken intent.
    expect(binding.selectDiscussionMode("request-challenge")).toBeUndefined();
    // No turn can begin and no transcript work is performed.
    expect(binding.beginTurn("topic-1", 0)).toBeUndefined();
    expect(binding.committedInput([segment({ state: "committed", text: "x" })])).toBe("");
    expect(binding.observeTurn(turnSnapshot("interrupted", false))).toBeUndefined();
    expect(binding.resolveTurn()).toBeUndefined();

    const view = binding.snapshot();
    expect(view.active).toBe(false);
    expect(view.selectedMode).toBeUndefined();
    expect(view.turn).toBeUndefined();

    expect(observer.onModeSelected).not.toHaveBeenCalled();
    expect(observer.onTurnStatus).not.toHaveBeenCalled();
    expect(observer.onCommittedInput).not.toHaveBeenCalled();
  });

  it.each(DRIVING_PROFILES)("%s can drive discussion", (profile) => {
    expect(makeBinding(profile).canDrive()).toBe(true);
  });
});

// ─── Mode reuse through the SAME contract plan (AC2) ──────────────────────────────

describe("mode selection reuses the discussion contract (AC2)", () => {
  const expectations: ReadonlyArray<readonly [VoiceDiscussionIntent, DiscussionMode]> = [
    ["request-challenge", "challenge"],
    ["request-review", "review"],
    ["request-decide", "decide"],
    ["request-brainstorm", "brainstorm"],
    ["request-evidence-check", "evidence-check"],
  ];

  it.each(expectations)("%s selects the %s contract plan", (intent, mode) => {
    const binding = makeBinding("full-realtime");
    const plan = binding.selectDiscussionMode(intent);
    // The returned plan is the SAME frozen contract object, not a parallel construction.
    expect(plan).toBe(DISCUSSION_MODE_PLANS[mode]);
    expect(binding.snapshot().selectedMode).toBe(mode);
  });

  it("covers every intent in the closed vocabulary", () => {
    const binding = makeBinding("speech-to-text");
    for (const intent of VOICE_DISCUSSION_INTENTS) {
      const plan = binding.selectDiscussionMode(intent);
      expect(plan).toBeDefined();
      expect(DISCUSSION_MODE_PLANS[plan?.mode ?? "challenge"]).toBe(plan);
    }
  });

  it("the intent type guard accepts intents and rejects non-intents", () => {
    expect(isVoiceDiscussionIntent("request-decide")).toBe(true);
    expect(isVoiceDiscussionIntent("decide")).toBe(false);
    expect(isVoiceDiscussionIntent(42)).toBe(false);
  });
});

// ─── Committed-only spoken input (AC5) ────────────────────────────────────────────

describe("committed-only input (AC5)", () => {
  it("uses only committed / corrected text and excludes everything else", () => {
    const binding = makeBinding("full-realtime");
    const segments: readonly VoiceTranscriptSegment[] = [
      segment({ id: "p", seq: 0, state: "partial", text: "PARTIAL" }),
      segment({ id: "s", seq: 1, state: "stable", text: "STABLE" }),
      segment({ id: "c", seq: 2, state: "committed", text: "committed" }),
      segment({ id: "x", seq: 3, state: "corrected", text: "corrected" }),
      segment({ id: "d", seq: 4, state: "discarded", text: "" }),
      segment({ id: "r", seq: 5, state: "redacted", text: "" }),
      segment({ id: "e", seq: 6, state: "provider-error", text: "" }),
    ];
    const text = binding.committedInput(segments);

    expect(text).toBe("committed corrected");
    expect(text).not.toContain("PARTIAL");
    expect(text).not.toContain("STABLE");
  });

  it("returns empty when there is no committed text", () => {
    const binding = makeBinding("speech-to-text");
    expect(binding.committedInput([segment({ state: "partial", text: "draft" })])).toBe("");
  });
});

// ─── Interruption → recovery preserves context (AC4) ──────────────────────────────

describe("interruption then recovery preserves mode / topicId / turnIndex (AC4)", () => {
  function startedBinding(): DiscussionVoiceBinding {
    const binding = makeBinding("full-realtime");
    binding.selectDiscussionMode("request-decide");
    binding.beginTurn("decision-42", 7);
    return binding;
  }

  it("barge-in then recover yields an identical context", () => {
    const binding = startedBinding();
    const before = binding.snapshot().turn;

    const interrupted = binding.observeTurn(turnSnapshot("interrupted", false));
    expect(interrupted?.status).toBe("interrupted");

    const recovered = binding.observeTurn(turnSnapshot("idle", false));
    expect(recovered?.status).toBe("recovered");
    // The no-context-loss proof: mode / topicId / turnIndex are unchanged across the round-trip.
    expect(recovered?.mode).toBe(before?.mode);
    expect(recovered?.topicId).toBe(before?.topicId);
    expect(recovered?.turnIndex).toBe(before?.turnIndex);
    expect(recovered?.mode).toBe("decide");
    expect(recovered?.topicId).toBe("decision-42");
    expect(recovered?.turnIndex).toBe(7);
  });

  it("treats a recovering snapshot as an interruption", () => {
    const binding = startedBinding();
    const result = binding.observeTurn(turnSnapshot("recovering", true));
    expect(result?.status).toBe("interrupted");
  });

  it("a non-interrupting snapshot before any interruption leaves the turn active", () => {
    const binding = startedBinding();
    const result = binding.observeTurn(turnSnapshot("speaking", false));
    expect(result?.status).toBe("active");
  });

  it("repeated barge-in then recover restores the same context again", () => {
    const binding = startedBinding();
    binding.observeTurn(turnSnapshot("interrupted", false));
    binding.observeTurn(turnSnapshot("idle", false));
    binding.observeTurn(turnSnapshot("interrupted", false));
    const recovered = binding.observeTurn(turnSnapshot("idle", false));
    expect(recovered?.status).toBe("recovered");
    expect(recovered?.topicId).toBe("decision-42");
    expect(recovered?.turnIndex).toBe(7);
  });

  it("observeTurn is a no-op before a turn begins", () => {
    const binding = makeBinding("full-realtime");
    expect(binding.observeTurn(turnSnapshot("interrupted", false))).toBeUndefined();
  });

  it("resolveTurn marks an active turn resolved", () => {
    const binding = startedBinding();
    expect(binding.resolveTurn()?.status).toBe("resolved");
  });

  it("resolveTurn is a no-op before a turn begins", () => {
    const binding = makeBinding("full-realtime");
    expect(binding.resolveTurn()).toBeUndefined();
  });

  it("an illegal transition (interrupt while resolved) leaves the context unchanged", () => {
    const binding = startedBinding();
    binding.resolveTurn();
    const result = binding.observeTurn(turnSnapshot("interrupted", false));
    // `resolved` is terminal: the contract returns the input unchanged, so status stays resolved.
    expect(result?.status).toBe("resolved");
  });

  it("a barge-in on a resolved turn does not later spuriously fire a recovery (FIX 7)", () => {
    const onTurnStatus = vi.fn();
    const binding = makeBinding("full-realtime", { onTurnStatus });
    binding.selectDiscussionMode("request-decide");
    binding.beginTurn("decision-42", 7);
    binding.resolveTurn(); // turn is now terminal
    onTurnStatus.mockClear();

    // A barge-in on the resolved turn is a no-op (no transition), so `interrupted` must NOT latch.
    const interrupted = binding.observeTurn(turnSnapshot("interrupted", false));
    expect(interrupted?.status).toBe("resolved");
    // The subsequent non-interrupting snapshot must therefore NOT trigger a recovery transition.
    const next = binding.observeTurn(turnSnapshot("idle", false));
    expect(next?.status).toBe("resolved");
    // No status-change event ever fired (no interrupt, no recovery).
    expect(onTurnStatus).not.toHaveBeenCalled();
  });

  it("beginTurn requires a selected mode first", () => {
    const binding = makeBinding("full-realtime");
    expect(binding.beginTurn("topic", 0)).toBeUndefined();
  });
});

// ─── Content-free observer (privacy) ──────────────────────────────────────────────

describe("content-free observer", () => {
  it("emits enums / integers only — never text, topicId, or transcript", () => {
    const events: unknown[] = [];
    const observer: DiscussionVoiceObserver = {
      onModeSelected: (event) => events.push(event),
      onTurnStatus: (event) => events.push(event),
      onCommittedInput: (event) => events.push(event),
    };
    const binding = makeBinding("full-realtime", observer);

    binding.selectDiscussionMode("request-challenge");
    binding.beginTurn("secret-topic-id", 3);
    binding.committedInput([segment({ state: "committed", text: "sensitive spoken words" })]);
    binding.observeTurn(turnSnapshot("interrupted", false));
    binding.observeTurn(turnSnapshot("idle", false));

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("secret-topic-id");
    expect(serialized).not.toContain("sensitive");
    expect(serialized).not.toContain("spoken words");

    // Every value in every event is an enum string or a finite number.
    for (const event of events) {
      for (const value of Object.values(event as Record<string, unknown>)) {
        const ok = typeof value === "number" ? Number.isFinite(value) : typeof value === "string";
        expect(ok).toBe(true);
      }
    }
  });

  it("reports the mandated facet count from the selected mode's contract plan", () => {
    const onModeSelected = vi.fn();
    const binding = makeBinding("full-realtime", { onModeSelected });
    binding.selectDiscussionMode("request-challenge");
    expect(onModeSelected).toHaveBeenCalledWith({
      mode: "challenge",
      mandatedFacetCount: DISCUSSION_MODE_PLANS.challenge.mandatedFacets.length,
    });
  });

  it("reports committed character and segment counts, not text", () => {
    const onCommittedInput = vi.fn();
    const binding = makeBinding("full-realtime", { onCommittedInput });
    binding.committedInput([
      segment({ id: "a", seq: 0, state: "committed", text: "abc" }),
      segment({ id: "b", seq: 1, state: "committed", text: "de" }),
    ]);
    // Projection joins the two committed texts with a single space: "abc de" → 6 chars, 2 segments.
    expect(onCommittedInput).toHaveBeenCalledWith({ committedChars: 6, committedSegments: 2 });
  });

  it("fires onTurnStatus only when the status actually changes", () => {
    const onTurnStatus = vi.fn();
    const binding = makeBinding("full-realtime", { onTurnStatus });
    binding.selectDiscussionMode("request-review");
    binding.beginTurn("topic", 0); // initial active event
    onTurnStatus.mockClear();
    // A non-interrupting snapshot makes no transition, so no event fires.
    binding.observeTurn(turnSnapshot("speaking", false));
    expect(onTurnStatus).not.toHaveBeenCalled();
    // An interruption transitions active→interrupted, firing exactly one event.
    binding.observeTurn(turnSnapshot("interrupted", false));
    expect(onTurnStatus).toHaveBeenCalledTimes(1);
  });
});

// ─── reset ─────────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("clears the selected mode and active turn", () => {
    const binding = makeBinding("full-realtime");
    binding.selectDiscussionMode("request-decide");
    binding.beginTurn("topic", 1);
    binding.reset();
    const view = binding.snapshot();
    expect(view.selectedMode).toBeUndefined();
    expect(view.turn).toBeUndefined();
    // After reset, an interruption observation is a no-op (no active turn).
    expect(binding.observeTurn(turnSnapshot("interrupted", false))).toBeUndefined();
  });
});
