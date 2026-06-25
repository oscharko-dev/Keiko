// Issue #503 (ADR-0066) — the Voice ↔ Spoken-action-governance binding. Proves the four ACs the hook is
// responsible for: text-first dormancy for `none` / `speech-output` (AC1), committed-only proposals
// (AC2), confirmation discipline for mutating effects (AC3), and stale-intent prevention via correction
// supersession / barge-in interruption / turn-advance expiry (AC4). It also pins the content-free
// observer: no event field carries committed text, a digest, or transcript content.

import { describe, expect, it, vi } from "vitest";
import type { VoiceProfile } from "@/lib/types";
import type { VoiceTranscriptSegment, VoiceTranscriptSource } from "@oscharko-dev/keiko-contracts";
import {
  type VoiceActionIntentBinding,
  type VoiceActionIntentObserver,
  type VoiceActionIntentStateEvent,
  createVoiceActionIntentBinding,
} from "./voice-action-intent";
import type { VoiceTurnSnapshot } from "./voice-turn-manager";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeBinding(
  profile: VoiceProfile,
  observer?: VoiceActionIntentObserver,
): VoiceActionIntentBinding {
  return createVoiceActionIntentBinding({ profile, observer });
}

// A transcript segment fixture. Only `state`, `text`, `seq`, `id` matter to the committed projection;
// the rest are content-free defaults so the projection behaves like the live reducer.
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

function committed(
  text: string,
  overrides?: Partial<VoiceTranscriptSegment>,
): VoiceTranscriptSegment {
  return segment({ id: "c", seq: 0, state: "committed", text, ...overrides });
}

// A minimal #499 turn-manager snapshot carrying only the fields the binding observes.
function turnSnapshot(
  partial: Partial<Pick<VoiceTurnSnapshot, "state" | "recovering" | "turnIndex">>,
): VoiceTurnSnapshot {
  return {
    profile: "full-realtime",
    active: true,
    state: partial.state ?? "speaking",
    floorHolder: "none",
    turnIndex: partial.turnIndex ?? 0,
    interruptions: 0,
    backchannels: 0,
    pendingCommit: false,
    recovering: partial.recovering ?? false,
    lastEndOfTurnAtMs: undefined,
    lastInterruptAtMs: undefined,
  };
}

const REALTIME: VoiceTranscriptSource = "realtime";
const DRIVING_PROFILES: readonly VoiceProfile[] = ["speech-to-text", "full-realtime"];
const DORMANT_PROFILES: readonly VoiceProfile[] = ["none", "speech-output"];

// ─── Capability gating / dormancy (AC1 text-first) ───────────────────────────────

describe("dormancy for non-capturing profiles (AC1)", () => {
  it.each(DORMANT_PROFILES)("%s does no action work and fires no observer", (profile) => {
    const observer: Required<VoiceActionIntentObserver> = {
      onProposed: vi.fn(),
      onStateChange: vi.fn(),
    };
    const binding = makeBinding(profile, observer);

    expect(binding.canPropose()).toBe(false);
    expect(binding.propose([committed("delete the account")], 0, REALTIME)).toBeUndefined();
    expect(binding.confirm()).toBeUndefined();
    expect(binding.cancel()).toBeUndefined();
    expect(binding.applyCommitted([committed("delete the account")])).toBeUndefined();
    expect(binding.observeTurn(turnSnapshot({ state: "interrupted" }))).toBeUndefined();

    const view = binding.snapshot();
    expect(view.active).toBe(false);
    expect(view.proposal).toBeUndefined();
    expect(view.state).toBeUndefined();

    expect(observer.onProposed).not.toHaveBeenCalled();
    expect(observer.onStateChange).not.toHaveBeenCalled();
  });

  it.each(DRIVING_PROFILES)("%s can propose actions", (profile) => {
    expect(makeBinding(profile).canPropose()).toBe(true);
  });
});

// ─── Committed-only proposals (AC2) ───────────────────────────────────────────────

describe("committed-only proposals (AC2)", () => {
  it.each(DRIVING_PROFILES)("%s proposes from committed text only", (profile) => {
    const binding = makeBinding(profile);
    const proposal = binding.propose([committed("show the report")], 4, REALTIME);
    expect(proposal).toBeDefined();
    expect(proposal?.turnIndex).toBe(4);
    expect(proposal?.source).toBe(REALTIME);
  });

  it("never proposes from partial / non-committed segments", () => {
    const binding = makeBinding("full-realtime");
    const segments: readonly VoiceTranscriptSegment[] = [
      segment({ id: "p", seq: 0, state: "partial", text: "delete everything" }),
      segment({ id: "s", seq: 1, state: "stable", text: "send the wire" }),
      segment({ id: "d", seq: 2, state: "discarded", text: "" }),
      segment({ id: "r", seq: 3, state: "redacted", text: "" }),
    ];
    expect(binding.propose(segments, 0, REALTIME)).toBeUndefined();
    expect(binding.snapshot().proposal).toBeUndefined();
  });

  it("returns undefined when the committed projection is empty / whitespace", () => {
    const binding = makeBinding("speech-to-text");
    expect(binding.propose([committed("   ")], 0, REALTIME)).toBeUndefined();
    expect(binding.propose([], 0, REALTIME)).toBeUndefined();
  });

  it("uses only committed text and excludes partial content in a mixed transcript", () => {
    const binding = makeBinding("full-realtime");
    const onProposed = vi.fn();
    const observed = makeBinding("full-realtime", { onProposed });
    const segments: readonly VoiceTranscriptSegment[] = [
      segment({ id: "p", seq: 0, state: "partial", text: "PARTIAL" }),
      segment({ id: "c", seq: 1, state: "committed", text: "list" }),
    ];
    expect(binding.propose(segments, 0, REALTIME)?.effectClass).toBe("read-only");
    observed.propose(segments, 0, REALTIME);
    // The committed projection is just "list" (4 chars, 1 segment) — PARTIAL is excluded.
    expect(onProposed).toHaveBeenCalledWith({
      effectClass: "read-only",
      requiresConfirmation: false,
      committedChars: 4,
      committedSegments: 1,
    });
  });
});

// ─── Confirmation discipline (AC3) ────────────────────────────────────────────────

describe("confirmation discipline (AC3)", () => {
  it("a read-only proposal opens `proposed` and needs no confirmation", () => {
    const binding = makeBinding("full-realtime");
    const proposal = binding.propose([committed("show the dashboard")], 0, REALTIME);
    expect(proposal?.effectClass).toBe("read-only");
    expect(proposal?.requiresConfirmation).toBe(false);
    expect(proposal?.state).toBe("proposed");
    expect(binding.snapshot().state).toBe("proposed");
  });

  it.each([
    ["delete the account", "destructive"],
    ["transfer the funds", "external-effect"],
    ["update the record", "mutating"],
    ["frobnicate the widget", "unknown"],
  ] as const)("%s opens awaiting-confirmation (%s)", (text, effectClass) => {
    const binding = makeBinding("full-realtime");
    const proposal = binding.propose([committed(text)], 0, REALTIME);
    expect(proposal?.effectClass).toBe(effectClass);
    expect(proposal?.requiresConfirmation).toBe(true);
    expect(proposal?.state).toBe("awaiting-confirmation");
  });

  it("confirm advances awaiting-confirmation → confirmed", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 0, REALTIME);
    expect(binding.confirm()).toBe("confirmed");
    expect(binding.snapshot().state).toBe("confirmed");
  });

  it("confirm is undefined when no proposal exists", () => {
    const binding = makeBinding("full-realtime");
    expect(binding.confirm()).toBeUndefined();
  });

  it("confirm on a read-only proposal is an illegal transition and leaves it `proposed`", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("show the report")], 0, REALTIME);
    // proposed → confirmed is not a legal transition; the state is unchanged.
    expect(binding.confirm()).toBe("proposed");
    expect(binding.snapshot().state).toBe("proposed");
  });

  it("cancel voids a non-terminal proposal", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 0, REALTIME);
    expect(binding.cancel()).toBe("cancelled");
    expect(binding.snapshot().state).toBe("cancelled");
  });

  it("cancel after a terminal state is an illegal no-op", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 0, REALTIME);
    binding.cancel();
    // Already cancelled (terminal): a second cancel cannot transition.
    expect(binding.cancel()).toBe("cancelled");
  });

  it("cancel is undefined when no proposal exists", () => {
    const binding = makeBinding("full-realtime");
    expect(binding.cancel()).toBeUndefined();
  });
});

// ─── Stale-intent prevention (AC4) ────────────────────────────────────────────────

describe("stale-intent prevention via correction (AC4)", () => {
  it("a corrected committed transcript supersedes the active proposal", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 0, REALTIME);
    // A correction changes the committed text → the canonical binding changes → superseded.
    const result = binding.applyCommitted([committed("delete the report")]);
    expect(result).toBe("superseded");
    expect(binding.snapshot().state).toBe("superseded");
  });

  it("an effect-class change in the corrected text supersedes the proposal", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("show the account")], 0, REALTIME); // read-only
    const result = binding.applyCommitted([committed("delete the account")]); // destructive
    expect(result).toBe("superseded");
  });

  it("an unchanged committed transcript does NOT supersede the proposal", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 0, REALTIME);
    const result = binding.applyCommitted([committed("delete the account")]);
    expect(result).toBe("awaiting-confirmation");
    expect(binding.snapshot().state).toBe("awaiting-confirmation");
  });

  it("removing the committed text supersedes the proposal", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 0, REALTIME);
    const result = binding.applyCommitted([segment({ state: "partial", text: "still talking" })]);
    expect(result).toBe("superseded");
  });

  it("a confirmed proposal is still superseded when corrected (no stale execution)", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 0, REALTIME);
    binding.confirm();
    expect(binding.applyCommitted([committed("delete the report")])).toBe("superseded");
  });

  it("applyCommitted is undefined when no proposal exists", () => {
    const binding = makeBinding("full-realtime");
    expect(binding.applyCommitted([committed("delete the account")])).toBeUndefined();
  });

  it("applyCommitted on a terminal proposal is an illegal no-op", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 0, REALTIME);
    binding.cancel();
    // cancelled is terminal; supersede cannot fire.
    expect(binding.applyCommitted([committed("delete the report")])).toBe("cancelled");
  });
});

describe("stale-intent prevention via turn snapshot (AC4)", () => {
  it("a barge-in interrupts the active proposal", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 3, REALTIME);
    expect(binding.observeTurn(turnSnapshot({ state: "interrupted", turnIndex: 3 }))).toBe(
      "interrupted",
    );
    expect(binding.snapshot().state).toBe("interrupted");
  });

  it("a recovering snapshot interrupts the active proposal", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 3, REALTIME);
    expect(
      binding.observeTurn(turnSnapshot({ state: "recovering", recovering: true, turnIndex: 3 })),
    ).toBe("interrupted");
  });

  it("a turn advancing past the proposal's turn expires it", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 3, REALTIME);
    expect(binding.observeTurn(turnSnapshot({ state: "listening", turnIndex: 4 }))).toBe("expired");
    expect(binding.snapshot().state).toBe("expired");
  });

  it("a same-turn, non-interrupting snapshot leaves the proposal active", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 3, REALTIME);
    expect(binding.observeTurn(turnSnapshot({ state: "speaking", turnIndex: 3 }))).toBe(
      "awaiting-confirmation",
    );
  });

  it("an earlier-turn snapshot does not expire the proposal", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 3, REALTIME);
    expect(binding.observeTurn(turnSnapshot({ state: "idle", turnIndex: 2 }))).toBe(
      "awaiting-confirmation",
    );
  });

  it("observeTurn is undefined before any proposal", () => {
    const binding = makeBinding("full-realtime");
    expect(binding.observeTurn(turnSnapshot({ state: "interrupted" }))).toBeUndefined();
  });

  it("a barge-in on a terminal proposal is an illegal no-op", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 3, REALTIME);
    binding.cancel();
    expect(binding.observeTurn(turnSnapshot({ state: "interrupted", turnIndex: 3 }))).toBe(
      "cancelled",
    );
  });
});

// ─── Content-free observer (privacy) ──────────────────────────────────────────────

describe("content-free observer", () => {
  it("emits enums / integers only — never committed text or a digest", () => {
    const events: unknown[] = [];
    const observer: VoiceActionIntentObserver = {
      onProposed: (event) => events.push(event),
      onStateChange: (event) => events.push(event),
    };
    const binding = makeBinding("full-realtime", observer);

    binding.propose([committed("delete the secret account now")], 3, REALTIME);
    binding.confirm();
    binding.applyCommitted([committed("delete the public account now")]);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("delete");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("account");

    for (const event of events) {
      for (const value of Object.values(event as Record<string, unknown>)) {
        const ok =
          typeof value === "number"
            ? Number.isFinite(value)
            : typeof value === "boolean" || typeof value === "string";
        expect(ok).toBe(true);
      }
    }
  });

  it("reports the effect class, confirmation flag, and committed counts on proposal", () => {
    const onProposed = vi.fn();
    const binding = makeBinding("full-realtime", { onProposed });
    binding.propose([committed("delete it")], 0, REALTIME);
    expect(onProposed).toHaveBeenCalledWith({
      effectClass: "destructive",
      requiresConfirmation: true,
      committedChars: "delete it".length,
      committedSegments: 1,
    });
  });

  it("fires onStateChange with the proposal's turnIndex on a real transition", () => {
    const onStateChange = vi.fn();
    const binding = makeBinding("full-realtime", { onStateChange });
    binding.propose([committed("delete the account")], 9, REALTIME);
    binding.confirm();
    expect(onStateChange).toHaveBeenCalledWith({
      from: "awaiting-confirmation",
      to: "confirmed",
      turnIndex: 9,
    });
  });

  it("does not fire onStateChange on an illegal (no-op) transition", () => {
    const onStateChange = vi.fn();
    const binding = makeBinding("full-realtime", { onStateChange });
    binding.propose([committed("show the report")], 0, REALTIME); // read-only, `proposed`
    onStateChange.mockClear();
    binding.confirm(); // proposed → confirmed is illegal
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("does not fire onProposed for a dormant / empty proposal", () => {
    const onProposed = vi.fn();
    const binding = makeBinding("full-realtime", { onProposed });
    binding.propose([committed("   ")], 0, REALTIME);
    expect(onProposed).not.toHaveBeenCalled();
  });
});

// ─── reset ─────────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("clears the active proposal and state", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 0, REALTIME);
    binding.reset();
    const view = binding.snapshot();
    expect(view.proposal).toBeUndefined();
    expect(view.state).toBeUndefined();
    // After reset, confirm / observe are no-ops (no active proposal).
    expect(binding.confirm()).toBeUndefined();
    expect(binding.observeTurn(turnSnapshot({ state: "interrupted" }))).toBeUndefined();
  });

  it("a fresh proposal after reset replaces any prior binding", () => {
    const binding = makeBinding("full-realtime");
    binding.propose([committed("delete the account")], 0, REALTIME);
    binding.propose([committed("show the report")], 1, REALTIME);
    // The second proposal replaced the first; its read-only state is active.
    expect(binding.snapshot().state).toBe("proposed");
    expect(binding.snapshot().proposal?.turnIndex).toBe(1);
  });
});

// ─── Superseding a live proposal (lifecycle completeness) ─────────────────────────

describe("proposing over a non-terminal proposal supersedes the prior one", () => {
  it("supersedes a prior awaiting-confirmation proposal before opening the new one", () => {
    const events: VoiceActionIntentStateEvent[] = [];
    let proposedAfterSupersede = false;
    const observer: VoiceActionIntentObserver = {
      onStateChange: (event) => events.push(event),
      onProposed: () => {
        // Record whether the prior proposal was already superseded by the time the new one is announced.
        proposedAfterSupersede = events.length === 1 && events[0]?.to === "superseded";
      },
    };
    const binding = makeBinding("full-realtime", observer);

    binding.propose([committed("delete the account")], 0, REALTIME); // awaiting-confirmation
    binding.propose([committed("show the report")], 1, REALTIME); // read-only, replaces prior

    // The prior proposal received a terminal `superseded` transition; an observer tracking the
    // lifecycle learns the prior intent ended rather than silently vanishing.
    expect(events).toEqual([{ from: "awaiting-confirmation", to: "superseded", turnIndex: 0 }]);
    // Ordering: the supersession fires before the new proposal is announced.
    expect(proposedAfterSupersede).toBe(true);
    // The new proposal is the active one.
    expect(binding.snapshot().state).toBe("proposed");
    expect(binding.snapshot().proposal?.turnIndex).toBe(1);
  });

  it("supersedes a prior confirmed proposal before opening the new one", () => {
    const onStateChange = vi.fn();
    const binding = makeBinding("full-realtime", { onStateChange });

    binding.propose([committed("delete the account")], 0, REALTIME);
    binding.confirm(); // awaiting-confirmation → confirmed
    onStateChange.mockClear();
    binding.propose([committed("transfer the funds")], 1, REALTIME);

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith({
      from: "confirmed",
      to: "superseded",
      turnIndex: 0,
    });
    expect(binding.snapshot().proposal?.turnIndex).toBe(1);
  });

  it("does not emit a state change when the prior proposal is already terminal", () => {
    const onStateChange = vi.fn();
    const binding = makeBinding("full-realtime", { onStateChange });

    binding.propose([committed("delete the account")], 0, REALTIME);
    binding.cancel(); // terminal
    onStateChange.mockClear();
    binding.propose([committed("show the report")], 1, REALTIME);

    // A terminal prior proposal has already emitted its terminal transition; no extra change fires.
    expect(onStateChange).not.toHaveBeenCalled();
    expect(binding.snapshot().proposal?.turnIndex).toBe(1);
  });
});
