// OpenCode 2.0.10 persists a streamed text or reasoning part only empty and complete; the deltas are
// ephemeral events (#3873 review, PR #3876). These tests pin the overlay that carries them: what a
// part shows while it streams, what is ignored, what is counted, and the bounds.
import { describe, expect, it } from "vitest";

import {
  MAX_LIVE_REASONING_UTF8_BYTES,
  MAX_LIVE_TEXT_UTF8_BYTES,
  createOpenCodeV2LiveText,
  type LiveTextKind,
} from "./opencodeV2LiveText.js";

const SESSION = "ses_live";
const MESSAGE = "msg_assistant";

type EventRecord = Readonly<Record<string, unknown>>;

// The shapes below are the ones the pinned runtime emits (a probe of the bundled 2.0.10 payload).
function started(
  kind: LiveTextKind,
  ordinal: number,
  data: Readonly<Record<string, unknown>> = {},
  id = `evt_${kind}_started_${String(ordinal)}`,
): EventRecord {
  return {
    id,
    type: `session.${kind}.started`,
    data: { sessionID: SESSION, assistantMessageID: MESSAGE, ordinal, ...data },
  };
}

function delta(
  kind: LiveTextKind,
  ordinal: number,
  text: unknown,
  data: Readonly<Record<string, unknown>> = {},
  id?: string,
): EventRecord {
  return {
    ...(id === undefined ? {} : { id }),
    type: `session.${kind}.delta`,
    data: { sessionID: SESSION, assistantMessageID: MESSAGE, ordinal, delta: text, ...data },
  };
}

describe("OpenCode V2 live text overlay", () => {
  it("grows a part from the deltas that arrive after it started", () => {
    const live = createOpenCodeV2LiveText();

    live.observe(SESSION, started("reasoning", 0));
    expect(live.textOf(MESSAGE, "reasoning", 0)).toBe("");
    live.observe(SESSION, delta("reasoning", 0, "Let me "));
    live.observe(SESSION, delta("reasoning", 0, "think."));

    expect(live.textOf(MESSAGE, "reasoning", 0)).toBe("Let me think.");
    expect(live.takeCounts()).toEqual({ applied: 2, dropped: 0, diverged: 0 });
  });

  it("keeps text and reasoning of one ordinal, and two ordinals of one kind, apart", () => {
    const live = createOpenCodeV2LiveText();
    for (const [kind, ordinal] of [
      ["reasoning", 0],
      ["text", 0],
      ["text", 1],
    ] as const) {
      live.observe(SESSION, started(kind, ordinal));
      live.observe(SESSION, delta(kind, ordinal, `${kind}${String(ordinal)}`));
    }

    expect(live.textOf(MESSAGE, "reasoning", 0)).toBe("reasoning0");
    expect(live.textOf(MESSAGE, "text", 0)).toBe("text0");
    expect(live.textOf(MESSAGE, "text", 1)).toBe("text1");
    expect(live.textOf(MESSAGE, "reasoning", 1)).toBeUndefined();
    expect(live.textOf("msg_other", "text", 0)).toBeUndefined();
  });

  it("does not extend a part it never saw start, and counts the delta dropped", () => {
    const live = createOpenCodeV2LiveText();

    live.observe(SESSION, delta("text", 0, "orphan"));

    expect(live.textOf(MESSAGE, "text", 0)).toBeUndefined();
    expect(live.takeCounts()).toEqual({ applied: 0, dropped: 1, diverged: 0 });
  });

  it("ignores events of other sessions and of other event types without counting them", () => {
    const live = createOpenCodeV2LiveText();
    live.observe(SESSION, started("text", 0));

    live.observe(SESSION, delta("text", 0, "foreign", { sessionID: "ses_other" }));
    live.observe(SESSION, {
      id: "evt_1",
      type: "session.text.ended",
      data: { sessionID: SESSION },
    });
    live.observe(SESSION, { id: "evt_2", type: "session.step.started", data: {} });
    live.observe(SESSION, { id: "evt_3", type: "constructor", data: { sessionID: SESSION } });
    live.observe(SESSION, { id: "evt_4", type: 7, data: { sessionID: SESSION } });
    live.observe(SESSION, { id: "evt_5", type: "session.text.delta", data: "not-a-record" });
    live.observe(SESSION, { id: "evt_6", type: "session.text.delta" });

    expect(live.textOf(MESSAGE, "text", 0)).toBe("");
    expect(live.takeCounts()).toEqual({ applied: 0, dropped: 0, diverged: 0 });
  });

  it.each([
    ["a message id outside the runtime's grammar", { assistantMessageID: "msg_ bad id" }],
    ["a message id that is not text", { assistantMessageID: 7 }],
    ["a negative ordinal", { ordinal: -1 }],
    ["a fractional ordinal", { ordinal: 0.5 }],
    ["an ordinal beyond the bound", { ordinal: 1_024 }],
    ["an ordinal that is not a number", { ordinal: "0" }],
    ["an unsafe integer ordinal", { ordinal: Number.MAX_SAFE_INTEGER + 1 }],
  ])("counts a delta of this session with %s as dropped", (_name, data) => {
    const live = createOpenCodeV2LiveText();
    live.observe(SESSION, started("text", 0));

    live.observe(SESSION, delta("text", 0, "words", data));

    expect(live.textOf(MESSAGE, "text", 0)).toBe("");
    expect(live.takeCounts()).toEqual({ applied: 0, dropped: 1, diverged: 0 });
  });

  it("does not start a part from a malformed started event", () => {
    const live = createOpenCodeV2LiveText();

    live.observe(SESSION, started("text", 0, { ordinal: -1 }));
    live.observe(SESSION, started("text", 0, { assistantMessageID: "bad" }));
    live.observe(SESSION, delta("text", 0, "words"));

    expect(live.textOf(MESSAGE, "text", 0)).toBeUndefined();
  });

  it("freezes a part at a delta that is not text, so the part never has a gap", () => {
    const live = createOpenCodeV2LiveText();
    live.observe(SESSION, started("text", 0));
    live.observe(SESSION, delta("text", 0, "kept"));

    live.observe(SESSION, delta("text", 0, 42));
    live.observe(SESSION, delta("text", 0, " later"));

    expect(live.textOf(MESSAGE, "text", 0)).toBe("kept");
    expect(live.takeCounts()).toEqual({ applied: 1, dropped: 2, diverged: 0 });
  });

  it("takes an empty delta as nothing: it is neither applied nor dropped", () => {
    const live = createOpenCodeV2LiveText();
    live.observe(SESSION, started("text", 0));
    live.observe(SESSION, delta("text", 0, "kept"));

    live.observe(SESSION, delta("text", 0, ""));
    live.observe(SESSION, delta("text", 0, " more"));

    expect(live.textOf(MESSAGE, "text", 0)).toBe("kept more");
    expect(live.takeCounts()).toEqual({ applied: 2, dropped: 0, diverged: 0 });
  });

  it("takes an event delivered twice as one delta", () => {
    const live = createOpenCodeV2LiveText();
    live.observe(SESSION, started("text", 0));

    live.observe(SESSION, delta("text", 0, "once ", {}, "evt_a"));
    live.observe(SESSION, delta("text", 0, "once ", {}, "evt_a"));
    live.observe(SESSION, delta("text", 0, "more", {}, "evt_b"));

    expect(live.textOf(MESSAGE, "text", 0)).toBe("once more");
    expect(live.takeCounts()).toEqual({ applied: 2, dropped: 0, diverged: 0 });
  });

  it("does not restart or extend a part that a second started event names", () => {
    const live = createOpenCodeV2LiveText();
    live.observe(SESSION, started("text", 0));
    live.observe(SESSION, delta("text", 0, "kept"));

    live.observe(SESSION, started("text", 0));

    expect(live.textOf(MESSAGE, "text", 0)).toBe("kept");
  });

  describe("bounds", () => {
    it("keeps a text part to its byte bound and drops what comes after", () => {
      const live = createOpenCodeV2LiveText();
      live.observe(SESSION, started("text", 0));
      const chunk = "a".repeat(10_000);

      for (let sent = 0; sent < 8; sent += 1) live.observe(SESSION, delta("text", 0, chunk));

      const shown = live.textOf(MESSAGE, "text", 0) ?? "";
      expect(Buffer.byteLength(shown, "utf8")).toBe(MAX_LIVE_TEXT_UTF8_BYTES);
      // Six whole chunks fit, the seventh was cut at the bound, the eighth found the part full.
      expect(live.takeCounts()).toEqual({ applied: 7, dropped: 1, diverged: 0 });
    });

    it("keeps a reasoning part to the projection's bound, cut on a whole character", () => {
      const live = createOpenCodeV2LiveText();
      live.observe(SESSION, started("reasoning", 0));
      // Three-byte characters: the bound is not a multiple of three, so the cut must fall short of it.
      const chunk = "€".repeat(3_000);

      // The second chunk is cut at the bound, the third finds the part full.
      for (let sent = 0; sent < 3; sent += 1) live.observe(SESSION, delta("reasoning", 0, chunk));

      const shown = live.textOf(MESSAGE, "reasoning", 0) ?? "";
      expect(Buffer.byteLength(shown, "utf8")).toBeLessThanOrEqual(MAX_LIVE_REASONING_UTF8_BYTES);
      expect(Buffer.byteLength(shown, "utf8")).toBeGreaterThan(MAX_LIVE_REASONING_UTF8_BYTES - 3);
      expect(shown).toBe("€".repeat(shown.length));
      expect(live.takeCounts()).toEqual({ applied: 2, dropped: 1, diverged: 0 });
    });

    it("drops a delta that cannot add a single character to a full part", () => {
      const live = createOpenCodeV2LiveText();
      live.observe(SESSION, started("text", 0));
      live.observe(SESSION, delta("text", 0, "a".repeat(MAX_LIVE_TEXT_UTF8_BYTES - 1)));

      live.observe(SESSION, delta("text", 0, "€"));
      live.observe(SESSION, delta("text", 0, "b"));

      expect(Buffer.byteLength(live.textOf(MESSAGE, "text", 0) ?? "", "utf8")).toBe(
        MAX_LIVE_TEXT_UTF8_BYTES - 1,
      );
      expect(live.takeCounts()).toEqual({ applied: 1, dropped: 2, diverged: 0 });
    });

    it("tracks a bounded number of unfinished parts", () => {
      const live = createOpenCodeV2LiveText();
      for (let ordinal = 0; ordinal < 40; ordinal += 1) {
        live.observe(SESSION, started("text", ordinal));
        live.observe(SESSION, delta("text", ordinal, "x"));
      }

      expect(live.textOf(MESSAGE, "text", 31)).toBe("x");
      expect(live.textOf(MESSAGE, "text", 32)).toBeUndefined();
      expect(live.takeCounts()).toEqual({ applied: 32, dropped: 8, diverged: 0 });
    });
  });

  describe("a character split between two deltas", () => {
    it("never shows half a surrogate pair, and shows the whole pair once it arrives", () => {
      const live = createOpenCodeV2LiveText();
      live.observe(SESSION, started("text", 0));

      live.observe(SESSION, delta("text", 0, "ok \ud83d"));
      expect(live.textOf(MESSAGE, "text", 0)).toBe("ok ");

      live.observe(SESSION, delta("text", 0, "\ude00 done"));
      expect(live.textOf(MESSAGE, "text", 0)).toBe("ok \u{1f600} done");
    });
  });

  describe("an interrupted event stream", () => {
    it("stops extending the parts it fed, counts what follows, and keeps what they showed", () => {
      const live = createOpenCodeV2LiveText();
      live.observe(SESSION, started("text", 0));
      live.observe(SESSION, delta("text", 0, "before "));

      live.freeze();
      live.observe(SESSION, delta("text", 0, "after"));

      expect(live.textOf(MESSAGE, "text", 0)).toBe("before ");
      expect(live.takeCounts()).toEqual({ applied: 1, dropped: 1, diverged: 0 });
    });

    it("tracks a part that starts on the stream that replaced it", () => {
      const live = createOpenCodeV2LiveText();
      live.observe(SESSION, started("text", 0));
      live.freeze();

      live.observe(SESSION, started("text", 1));
      live.observe(SESSION, delta("text", 1, "fresh"));

      expect(live.textOf(MESSAGE, "text", 1)).toBe("fresh");
      expect(live.textOf(MESSAGE, "text", 0)).toBe("");
    });
  });

  describe("a part the history shows complete", () => {
    it("is spent: it shows nothing, and a delta still in flight is not counted", () => {
      const live = createOpenCodeV2LiveText();
      live.observe(SESSION, started("text", 0));
      live.observe(SESSION, delta("text", 0, "done"));
      live.takeCounts();

      live.retire(MESSAGE, "text", 0);
      live.observe(SESSION, delta("text", 0, " late"));
      live.observe(SESSION, started("text", 0));

      expect(live.textOf(MESSAGE, "text", 0)).toBeUndefined();
      expect(live.takeCounts()).toEqual({ applied: 0, dropped: 0, diverged: 0 });
    });

    it("ignores the retirement of a part it does not track", () => {
      const live = createOpenCodeV2LiveText();

      live.retire(MESSAGE, "text", 0);
      live.observe(SESSION, delta("text", 0, "orphan"));

      expect(live.takeCounts()).toEqual({ applied: 0, dropped: 1, diverged: 0 });
    });

    it("remembers a bounded number of spent parts", () => {
      const live = createOpenCodeV2LiveText();
      for (let ordinal = 0; ordinal < 200; ordinal += 1) {
        live.observe(SESSION, started("text", ordinal));
        live.retire(MESSAGE, "text", ordinal);
      }
      live.takeCounts();

      // The oldest spent part was forgotten, so its late delta is a delta for a part nobody tracks.
      live.observe(SESSION, delta("text", 0, "forgotten"));
      // The newest is still remembered.
      live.observe(SESSION, delta("text", 199, "remembered"));

      expect(live.takeCounts()).toEqual({ applied: 0, dropped: 1, diverged: 0 });
    });
  });

  describe("a complete text that does not extend what was shown", () => {
    it("is counted once per part, however often the history shows it", () => {
      const live = createOpenCodeV2LiveText();
      live.observe(SESSION, started("text", 0));

      live.markDiverged(MESSAGE, "text", 0);
      live.markDiverged(MESSAGE, "text", 0);
      live.markDiverged(MESSAGE, "text", 7);

      expect(live.takeCounts()).toEqual({ applied: 0, dropped: 0, diverged: 1 });
    });
  });

  it("resets its counts each time they are taken", () => {
    const live = createOpenCodeV2LiveText();
    live.observe(SESSION, started("text", 0));
    live.observe(SESSION, delta("text", 0, "a"));
    live.observe(SESSION, delta("text", 5, "b"));
    live.markDiverged(MESSAGE, "text", 0);

    expect(live.takeCounts()).toEqual({ applied: 1, dropped: 1, diverged: 1 });
    expect(live.takeCounts()).toEqual({ applied: 0, dropped: 0, diverged: 0 });
  });
});
