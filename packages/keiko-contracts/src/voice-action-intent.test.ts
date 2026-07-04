// Regression tests for the Spoken Action Intent governance contract (Issue #503, Epic #491, ADR-0108).
// These pin the acceptance criteria as executable, mutation-resistant invariants:
//   AC1 — spoken actions are impossible without voice capture capability (none/speech-output dormant).
//   AC2 — both STT and full-realtime require committed transcript text; empty projection → no proposal.
//   AC3 — mutating/destructive/external/unknown require explicit confirmation; read-only does not.
//   AC4 — confirmation binding canonical string changes when committedText/turnIndex/effectClass change.
//   AC5 — the audit record carries no text/audio; the module source carries no forbidden substrings.
// The module is pure; these tests read no clock and perform no IO.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { VoiceProfile } from "./gateway.js";
import type {
  CommittedVoiceTranscriptProjection,
  VoiceTranscriptSource,
} from "./voice-transcript.js";
import {
  SPOKEN_ACTION_EFFECT_CLASSES,
  SPOKEN_ACTION_EFFECT_MARKERS,
  SPOKEN_ACTION_EFFECT_REQUIRES_CONFIRMATION,
  SPOKEN_ACTION_OUTCOMES,
  SPOKEN_ACTION_STATES,
  SPOKEN_ACTION_STATE_TRANSITIONS,
  SPOKEN_ACTION_TERMINAL_STATES,
  VOICE_ACTION_INTENT_SCHEMA_VERSION,
  type SpokenActionAuditRecord,
  type SpokenActionConfirmationInput,
  type SpokenActionProposal,
  type SpokenActionState,
  assertNeverSpokenActionEffectClass,
  assertNeverSpokenActionState,
  buildSpokenActionAuditRecord,
  canTransitionSpokenAction,
  canonicalizeSpokenActionConfirmation,
  classifySpokenActionEffect,
  isSpokenActionEffectClass,
  isSpokenActionOutcome,
  isSpokenActionState,
  isTerminalSpokenActionState,
  isVoiceActionIntentSchemaVersionSupported,
  normalizeSpokenActionProposal,
  spokenActionRequiresConfirmation,
  validateSpokenActionAuditRecord,
  validateSpokenActionProposal,
  voiceCanProposeAction,
} from "./voice-action-intent.js";

const VOICE_PROFILES: readonly VoiceProfile[] = [
  "none",
  "speech-to-text",
  "speech-output",
  "full-realtime",
];

const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  "apikey",
  "secret",
  "password",
  "credential",
  "bearer",
  "baseurl",
  "endpoint",
  "authorization",
  "privatekey",
  "accesskey",
  "token",
];

function projectionWithText(text: string, segmentCount = 1): CommittedVoiceTranscriptProjection {
  return {
    schemaVersion: "1",
    segments: [],
    text,
    segmentCount,
  };
}

function confirmationInput(
  overrides: Partial<SpokenActionConfirmationInput> = {},
): SpokenActionConfirmationInput {
  return {
    schemaVersion: VOICE_ACTION_INTENT_SCHEMA_VERSION,
    committedText: "delete the staging record",
    turnIndex: 3,
    effectClass: "destructive",
    source: "realtime",
    committedSegmentCount: 2,
    ...overrides,
  };
}

describe("schema version", () => {
  it("is the literal '1'", () => {
    expect(VOICE_ACTION_INTENT_SCHEMA_VERSION).toBe("1");
  });

  it("accepts only the supported version", () => {
    expect(isVoiceActionIntentSchemaVersionSupported("1")).toBe(true);
    expect(isVoiceActionIntentSchemaVersionSupported("2")).toBe(false);
    expect(isVoiceActionIntentSchemaVersionSupported(1)).toBe(false);
    expect(isVoiceActionIntentSchemaVersionSupported(undefined)).toBe(false);
  });
});

describe("AC1 — capability gating", () => {
  it("permits proposals only where transcript capture is allowed", () => {
    const expected: Readonly<Record<VoiceProfile, boolean>> = {
      none: false,
      "speech-output": false,
      "speech-to-text": true,
      "full-realtime": true,
    };
    for (const profile of VOICE_PROFILES) {
      expect(voiceCanProposeAction(profile)).toBe(expected[profile]);
    }
  });

  it("normalize returns undefined for dormant profiles even with committed text", () => {
    for (const profile of ["none", "speech-output"] as const) {
      expect(
        normalizeSpokenActionProposal(
          projectionWithText("show the open tickets"),
          profile,
          0,
          "realtime",
        ),
      ).toBeUndefined();
    }
  });
});

describe("AC2 — committed-only entry", () => {
  it("returns undefined when the committed projection text is empty or whitespace", () => {
    for (const text of ["", "   ", "\n\t "]) {
      expect(
        normalizeSpokenActionProposal(projectionWithText(text), "speech-to-text", 0, "dictation"),
      ).toBeUndefined();
    }
  });

  it("returns a proposal for non-empty committed text in BOTH STT and realtime sources", () => {
    const sources: readonly VoiceTranscriptSource[] = ["dictation", "realtime"];
    for (const source of sources) {
      const proposal = normalizeSpokenActionProposal(
        projectionWithText("delete the record", 2),
        source === "dictation" ? "speech-to-text" : "full-realtime",
        4,
        source,
      );
      expect(proposal).toBeDefined();
      expect(proposal?.source).toBe(source);
      expect(proposal?.turnIndex).toBe(4);
      expect(proposal?.committedSegmentCount).toBe(2);
      expect(proposal?.committedChars).toBe("delete the record".length);
    }
  });
});

describe("AC3 — confirmation discipline", () => {
  it("requires confirmation for every class except read-only", () => {
    expect(spokenActionRequiresConfirmation("read-only")).toBe(false);
    expect(spokenActionRequiresConfirmation("mutating")).toBe(true);
    expect(spokenActionRequiresConfirmation("destructive")).toBe(true);
    expect(spokenActionRequiresConfirmation("external-effect")).toBe(true);
    expect(spokenActionRequiresConfirmation("unknown")).toBe(true);
  });

  it("table matches the predicate for every class (totality)", () => {
    for (const cls of SPOKEN_ACTION_EFFECT_CLASSES) {
      expect(SPOKEN_ACTION_EFFECT_REQUIRES_CONFIRMATION[cls]).toBe(
        spokenActionRequiresConfirmation(cls),
      );
    }
  });

  it("read-only proposals are 'proposed'; everything else 'awaiting-confirmation'", () => {
    const readOnly = normalizeSpokenActionProposal(
      projectionWithText("show the open tickets"),
      "speech-to-text",
      0,
      "dictation",
    );
    expect(readOnly?.effectClass).toBe("read-only");
    expect(readOnly?.requiresConfirmation).toBe(false);
    expect(readOnly?.state).toBe("proposed");

    const mutating = normalizeSpokenActionProposal(
      projectionWithText("update the config"),
      "speech-to-text",
      0,
      "dictation",
    );
    expect(mutating?.requiresConfirmation).toBe(true);
    expect(mutating?.state).toBe("awaiting-confirmation");
  });
});

describe("classifier — deterministic, fail-closed, ordered precedence", () => {
  it("maps representative phrases", () => {
    expect(classifySpokenActionEffect("show the open tickets")).toBe("read-only");
    expect(classifySpokenActionEffect("update the config")).toBe("mutating");
    expect(classifySpokenActionEffect("delete the staging record")).toBe("destructive");
    expect(classifySpokenActionEffect("send the report to finance")).toBe("external-effect");
  });

  it("empty / whitespace text → unknown", () => {
    expect(classifySpokenActionEffect("")).toBe("unknown");
    expect(classifySpokenActionEffect("   \t\n")).toBe("unknown");
  });

  it("unrecognized text → unknown (fail-closed)", () => {
    expect(classifySpokenActionEffect("the weather is nice today")).toBe("unknown");
  });

  it("precedence destructive > external-effect > mutating > read-only", () => {
    expect(classifySpokenActionEffect("update then delete the record")).toBe("destructive");
    expect(classifySpokenActionEffect("create and send the invoice")).toBe("external-effect");
    expect(classifySpokenActionEffect("show and update the config")).toBe("mutating");
  });

  it("is case-insensitive and whitespace-robust", () => {
    expect(classifySpokenActionEffect("  DELETE   the   Record ")).toBe("destructive");
  });

  it("matches whole words only (no substring false positives)", () => {
    expect(classifySpokenActionEffect("the settlement was finalized")).toBe("unknown");
  });

  it("is deterministic for identical input", () => {
    expect(classifySpokenActionEffect("delete it")).toBe(classifySpokenActionEffect("delete it"));
  });

  it("folds a fullwidth destructive verb to its ASCII spelling via NFKC", () => {
    // "ｄelete" is fullwidth 'd' + ASCII 'elete'; NFKC folds it to "delete".
    expect(classifySpokenActionEffect("ｄelete the database")).toBe("destructive");
  });

  it("classifies a fullwidth destructive verb as destructive even beside a read-only marker", () => {
    // Without NFKC this would match only the read-only 'show' marker and skip confirmation.
    expect(classifySpokenActionEffect("ｄelete the database but first show me the rows")).toBe(
      "destructive",
    );
    expect(classifySpokenActionEffect("show then ｄelete everything")).toBe("destructive");
  });

  it("strips a zero-width char injected into a destructive verb (no read-only downgrade)", () => {
    const zwsp = "​"; // zero-width space
    expect(classifySpokenActionEffect(`de${zwsp}lete the records`)).toBe("destructive");
    expect(classifySpokenActionEffect(`show the rows then de${zwsp}lete them`)).toBe("destructive");
  });

  it("strips a BOM / bidi-override injected into a destructive verb", () => {
    const bom = "﻿"; // zero-width no-break space / BOM
    const rlo = "‮"; // right-to-left override
    expect(classifySpokenActionEffect(`de${bom}lete it`)).toBe("destructive");
    expect(classifySpokenActionEffect(`de${rlo}lete it`)).toBe("destructive");
  });

  it("preserves word boundaries across tab / newline whitespace (collapsed, not stripped)", () => {
    // tab/LF/CR are control chars but must NOT be stripped: collapsing them to a space keeps the
    // 'delete' marker word-bounded. Stripping them would join words ("delete\tit" -> "deleteit").
    expect(classifySpokenActionEffect("delete\tthe record")).toBe("destructive");
    expect(classifySpokenActionEffect("show\ndelete the rows")).toBe("destructive");
    expect(classifySpokenActionEffect("show\r\nthe tickets")).toBe("read-only");
  });

  it("leaves plain ASCII classification unchanged (NFKC + strip are identity)", () => {
    expect(classifySpokenActionEffect("show the open tickets")).toBe("read-only");
    expect(classifySpokenActionEffect("update the config")).toBe("mutating");
    expect(classifySpokenActionEffect("send the report")).toBe("external-effect");
    expect(classifySpokenActionEffect("the settlement was finalized")).toBe("unknown");
  });
});

describe("AC4 — confirmation binding canonicalization", () => {
  it("is deterministic for identical input", () => {
    expect(canonicalizeSpokenActionConfirmation(confirmationInput())).toBe(
      canonicalizeSpokenActionConfirmation(confirmationInput()),
    );
  });

  it("differs when committedText changes", () => {
    expect(canonicalizeSpokenActionConfirmation(confirmationInput())).not.toBe(
      canonicalizeSpokenActionConfirmation(confirmationInput({ committedText: "delete it now" })),
    );
  });

  it("differs when turnIndex changes", () => {
    expect(canonicalizeSpokenActionConfirmation(confirmationInput())).not.toBe(
      canonicalizeSpokenActionConfirmation(confirmationInput({ turnIndex: 4 })),
    );
  });

  it("differs when effectClass changes", () => {
    expect(canonicalizeSpokenActionConfirmation(confirmationInput())).not.toBe(
      canonicalizeSpokenActionConfirmation(confirmationInput({ effectClass: "mutating" })),
    );
  });

  it("cannot confuse one field's content with another (length-prefixed)", () => {
    const a = confirmationInput({ committedText: "ab", committedSegmentCount: 12 });
    const b = confirmationInput({ committedText: "ab12", committedSegmentCount: 1 });
    expect(canonicalizeSpokenActionConfirmation(a)).not.toBe(
      canonicalizeSpokenActionConfirmation(b),
    );
  });
});

describe("AC5 — evidence safety", () => {
  it("the audit record has no text or audio property", () => {
    const record = buildSpokenActionAuditRecord({
      effectClass: "destructive",
      state: "routed",
      confirmationRequired: true,
      confirmed: true,
      outcome: "routed",
      source: "realtime",
      turnIndex: 3,
      committedSegmentCount: 2,
      committedChars: 25,
      bindingDigest: "a".repeat(64),
    });
    const keys = Object.keys(record);
    expect(keys).not.toContain("text");
    expect(keys).not.toContain("committedText");
    expect(keys).not.toContain("audio");
    expect(keys).not.toContain("transcript");
  });

  it("the builder never copies committed text (no text field anywhere)", () => {
    const record = buildSpokenActionAuditRecord({
      effectClass: "read-only",
      state: "completed",
      confirmationRequired: false,
      confirmed: false,
      outcome: "routed",
      source: "dictation",
      turnIndex: 0,
      committedSegmentCount: 1,
      committedChars: 10,
      bindingDigest: "",
    });
    const serialized = JSON.stringify(record).toLowerCase();
    expect(serialized).not.toContain("committedtext");
  });

  it("the module source contains no forbidden secret vocabulary", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./voice-action-intent.ts", import.meta.url)),
      "utf8",
    ).toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("the effect marker lexicon contains no forbidden secret vocabulary", () => {
    const markers = [
      ...SPOKEN_ACTION_EFFECT_MARKERS.destructive,
      ...SPOKEN_ACTION_EFFECT_MARKERS.externalEffect,
      ...SPOKEN_ACTION_EFFECT_MARKERS.mutating,
      ...SPOKEN_ACTION_EFFECT_MARKERS.readOnly,
    ];
    for (const marker of markers) {
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(marker).not.toContain(forbidden);
      }
    }
  });
});

describe("effect class guards", () => {
  it("accepts every known class and rejects others", () => {
    for (const cls of SPOKEN_ACTION_EFFECT_CLASSES) {
      expect(isSpokenActionEffectClass(cls)).toBe(true);
    }
    expect(isSpokenActionEffectClass("nope")).toBe(false);
    expect(isSpokenActionEffectClass(42)).toBe(false);
    expect(isSpokenActionEffectClass(undefined)).toBe(false);
  });

  it("assertNever throws for an out-of-domain value", () => {
    expect(() => assertNeverSpokenActionEffectClass("rogue" as never)).toThrow(
      /Unhandled SpokenActionEffectClass/,
    );
  });

  it("has exactly five classes", () => {
    expect(SPOKEN_ACTION_EFFECT_CLASSES).toHaveLength(5);
  });
});

describe("outcome guard", () => {
  it("accepts every known outcome and rejects others", () => {
    for (const outcome of SPOKEN_ACTION_OUTCOMES) {
      expect(isSpokenActionOutcome(outcome)).toBe(true);
    }
    expect(isSpokenActionOutcome("nope")).toBe(false);
    expect(isSpokenActionOutcome(0)).toBe(false);
  });
});

describe("state machine", () => {
  it("accepts every known state and rejects others", () => {
    for (const state of SPOKEN_ACTION_STATES) {
      expect(isSpokenActionState(state)).toBe(true);
    }
    expect(isSpokenActionState("nope")).toBe(false);
    expect(isSpokenActionState(null)).toBe(false);
  });

  it("read-only path: proposed → routed → completed", () => {
    expect(canTransitionSpokenAction("proposed", "routed")).toBe(true);
    expect(canTransitionSpokenAction("routed", "completed")).toBe(true);
  });

  it("confirm path: proposed → awaiting-confirmation → confirmed → routed → completed", () => {
    expect(canTransitionSpokenAction("proposed", "awaiting-confirmation")).toBe(true);
    expect(canTransitionSpokenAction("awaiting-confirmation", "confirmed")).toBe(true);
    expect(canTransitionSpokenAction("confirmed", "routed")).toBe(true);
    expect(canTransitionSpokenAction("routed", "completed")).toBe(true);
  });

  it("every non-terminal state can be invalidated to all four invalidation states", () => {
    const nonTerminal: readonly SpokenActionState[] = [
      "proposed",
      "awaiting-confirmation",
      "confirmed",
      "routed",
    ];
    for (const from of nonTerminal) {
      for (const to of ["cancelled", "superseded", "interrupted", "expired"] as const) {
        expect(canTransitionSpokenAction(from, to)).toBe(true);
      }
    }
  });

  it("denies illegal transitions", () => {
    expect(canTransitionSpokenAction("proposed", "confirmed")).toBe(false);
    expect(canTransitionSpokenAction("awaiting-confirmation", "routed")).toBe(false);
    expect(canTransitionSpokenAction("completed", "routed")).toBe(false);
  });

  it("terminal states have no outgoing transitions", () => {
    for (const state of SPOKEN_ACTION_TERMINAL_STATES) {
      expect(SPOKEN_ACTION_STATE_TRANSITIONS[state]).toHaveLength(0);
      expect(isTerminalSpokenActionState(state)).toBe(true);
    }
  });

  it("non-terminal states are not terminal", () => {
    for (const state of ["proposed", "awaiting-confirmation", "confirmed", "routed"] as const) {
      expect(isTerminalSpokenActionState(state)).toBe(false);
    }
  });

  it("transition table is keyed for every state (totality)", () => {
    for (const state of SPOKEN_ACTION_STATES) {
      expect(SPOKEN_ACTION_STATE_TRANSITIONS[state]).toBeDefined();
    }
  });

  it("assertNever throws for an out-of-domain state", () => {
    expect(() => assertNeverSpokenActionState("rogue" as never)).toThrow(
      /Unhandled SpokenActionState/,
    );
  });
});

describe("validateSpokenActionProposal", () => {
  function wellFormed(): SpokenActionProposal {
    return {
      schemaVersion: VOICE_ACTION_INTENT_SCHEMA_VERSION,
      effectClass: "mutating",
      requiresConfirmation: true,
      state: "awaiting-confirmation",
      source: "dictation",
      turnIndex: 2,
      committedSegmentCount: 1,
      committedChars: 17,
      confirmationInput: confirmationInput({ effectClass: "mutating" }),
    };
  }

  it("accepts a well-formed proposal", () => {
    expect(validateSpokenActionProposal(wellFormed())).toEqual({ ok: true });
  });

  it("accepts the product of normalize", () => {
    const proposal = normalizeSpokenActionProposal(
      projectionWithText("update the config"),
      "speech-to-text",
      0,
      "dictation",
    );
    expect(proposal).toBeDefined();
    expect(validateSpokenActionProposal(proposal)).toEqual({ ok: true });
  });

  it("rejects non-objects", () => {
    expect(validateSpokenActionProposal(null).ok).toBe(false);
    expect(validateSpokenActionProposal("x").ok).toBe(false);
  });

  it("rejects a bad schema version", () => {
    const result = validateSpokenActionProposal({ ...wellFormed(), schemaVersion: "2" });
    expect(result.ok).toBe(false);
  });

  it("accumulates multiple reasons", () => {
    const result = validateSpokenActionProposal({
      schemaVersion: "2",
      effectClass: "nope",
      requiresConfirmation: "yes",
      state: "rogue",
      source: "dictation",
      turnIndex: -1,
      committedSegmentCount: 1.5,
      committedChars: -3,
      confirmationInput: 7,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.length).toBeGreaterThan(3);
    }
  });

  it("rejects an invalid source and accepts each valid source", () => {
    const bad = validateSpokenActionProposal({ ...wellFormed(), source: "telepathy" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reasons).toContain("source: unknown transcript source");
    }
    for (const source of ["dictation", "realtime"] as const) {
      expect(
        validateSpokenActionProposal({
          ...wellFormed(),
          source,
          confirmationInput: confirmationInput({ effectClass: "mutating", source }),
        }),
      ).toEqual({ ok: true });
    }
  });

  it("rejects an invalid source nested in confirmationInput", () => {
    const result = validateSpokenActionProposal({
      ...wellFormed(),
      confirmationInput: { ...confirmationInput({ effectClass: "mutating" }), source: "nope" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("confirmationInput.source: unknown transcript source");
    }
  });
});

describe("validateSpokenActionAuditRecord", () => {
  function wellFormed(): SpokenActionAuditRecord {
    return {
      schemaVersion: VOICE_ACTION_INTENT_SCHEMA_VERSION,
      effectClass: "destructive",
      state: "routed",
      confirmationRequired: true,
      confirmed: true,
      outcome: "routed",
      source: "realtime",
      turnIndex: 3,
      committedSegmentCount: 2,
      committedChars: 25,
      bindingDigest: "a".repeat(64),
    };
  }

  it("accepts a well-formed record", () => {
    expect(validateSpokenActionAuditRecord(wellFormed())).toEqual({ ok: true });
  });

  it("accepts an empty binding digest (no confirmation bound)", () => {
    expect(validateSpokenActionAuditRecord({ ...wellFormed(), bindingDigest: "" })).toEqual({
      ok: true,
    });
  });

  it("rejects a malformed binding digest", () => {
    expect(validateSpokenActionAuditRecord({ ...wellFormed(), bindingDigest: "xyz" }).ok).toBe(
      false,
    );
    expect(
      validateSpokenActionAuditRecord({ ...wellFormed(), bindingDigest: "A".repeat(64) }).ok,
    ).toBe(false);
  });

  it("rejects non-objects and bad enums", () => {
    expect(validateSpokenActionAuditRecord(undefined).ok).toBe(false);
    expect(validateSpokenActionAuditRecord({ ...wellFormed(), outcome: "nope" }).ok).toBe(false);
    expect(validateSpokenActionAuditRecord({ ...wellFormed(), state: "rogue" }).ok).toBe(false);
  });

  it("rejects an invalid source and accepts each valid source", () => {
    const bad = validateSpokenActionAuditRecord({ ...wellFormed(), source: "telepathy" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reasons).toContain("source: unknown transcript source");
    }
    for (const source of ["dictation", "realtime"] as const) {
      expect(validateSpokenActionAuditRecord({ ...wellFormed(), source })).toEqual({ ok: true });
    }
  });
});
