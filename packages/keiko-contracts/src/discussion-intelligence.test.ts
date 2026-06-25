// Regression tests for the Discussion Intelligence contract (Issue #502, Epic #491, ADR-0065). These pin
// the acceptance criteria as executable, mutation-resistant invariants:
//   AC1 — text-first: discussion modes resolve for every voice profile, including `none`.
//   AC2 — voice reuses the SAME contract; gating derives from the voice transcript capability.
//   AC3 — disagreement-capable modes mandate evidence + assumptions + uncertainty.
//   AC4 — interrupt→recover preserves mode/topicId/turnIndex (no context loss).
//   AC5 — content-free everywhere: directive templates carry no forbidden substrings.
// The module is pure; these tests read no clock and perform no IO.

import { describe, expect, it } from "vitest";
import type { VoiceProfile } from "./gateway.js";
import {
  DISAGREEMENT_FACETS,
  DISCUSSION_CONFIDENCE_LEVELS,
  DISCUSSION_DIRECTIVES,
  DISCUSSION_DIRECTIVE_FACETS,
  DISCUSSION_DIRECTIVE_TEMPLATES,
  DISCUSSION_INTELLIGENCE_SCHEMA_VERSION,
  DISCUSSION_MODES,
  DISCUSSION_MODE_PLANS,
  DISCUSSION_TURN_STATUSES,
  DISCUSSION_TURN_STATUS_TRANSITIONS,
  type ConfidenceLevel,
  type DisagreementFacet,
  type DiscussionDirective,
  type DiscussionMode,
  type DiscussionModePlan,
  type DiscussionTurnContext,
  type DiscussionTurnStatus,
  applyDiscussionInterruption,
  applyDiscussionRecovery,
  assertNeverDiscussionDirective,
  assertNeverDiscussionMode,
  assertNeverDiscussionTurnStatus,
  beginDiscussionTurn,
  canTransitionDiscussionTurnStatus,
  confidenceLevelFromScore,
  discussionDirectivesCoverFacets,
  discussionModePlan,
  discussionTopicIdReasons,
  isDiscussionIntelligenceSchemaVersionSupported,
  isDiscussionMode,
  isDiscussionTurnStatus,
  isValidDiscussionTopicId,
  resolveDiscussionTurn,
  summarizeDiscussionTurn,
  validateDiscussionModePlan,
  validateDiscussionTurnContext,
  voiceCanDriveDiscussion,
} from "./discussion-intelligence.js";

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
  "providerconfig",
  "systemprompt",
  "authorization",
  "privatekey",
  "accesskey",
  "toolauthority",
  "grantedtools",
  "allowedtools",
  "canexecute",
];

describe("schema version", () => {
  it("is the literal '1'", () => {
    expect(DISCUSSION_INTELLIGENCE_SCHEMA_VERSION).toBe("1");
  });

  it("accepts only the supported version", () => {
    expect(isDiscussionIntelligenceSchemaVersionSupported("1")).toBe(true);
    expect(isDiscussionIntelligenceSchemaVersionSupported("2")).toBe(false);
    expect(isDiscussionIntelligenceSchemaVersionSupported(1)).toBe(false);
    expect(isDiscussionIntelligenceSchemaVersionSupported(undefined)).toBe(false);
  });
});

describe("discussion modes (closed-set integrity)", () => {
  it("enumerates exactly five modes", () => {
    expect(DISCUSSION_MODES).toEqual([
      "challenge",
      "review",
      "decide",
      "brainstorm",
      "evidence-check",
    ]);
  });

  it("isDiscussionMode accepts members and rejects non-members", () => {
    for (const mode of DISCUSSION_MODES) {
      expect(isDiscussionMode(mode)).toBe(true);
    }
    expect(isDiscussionMode("debate")).toBe(false);
    expect(isDiscussionMode(42)).toBe(false);
    expect(isDiscussionMode(null)).toBe(false);
  });

  it("assertNeverDiscussionMode throws for an unhandled value", () => {
    expect(() => assertNeverDiscussionMode("ghost" as never)).toThrow(/Unhandled DiscussionMode/);
  });
});

describe("confidence level (design-system bridge)", () => {
  it("enumerates high/medium/low", () => {
    expect(DISCUSSION_CONFIDENCE_LEVELS).toEqual(["high", "medium", "low"]);
  });

  it("guards non-finite and out-of-range scores to low", () => {
    const guarded: readonly number[] = [Number.NaN, Number.POSITIVE_INFINITY, -0.01, -1, 1.01, 2];
    for (const score of guarded) {
      expect(confidenceLevelFromScore(score)).toBe<ConfidenceLevel>("low");
    }
  });

  it("maps in-range scores around the 1/3 and 2/3 cut points", () => {
    expect(confidenceLevelFromScore(0)).toBe<ConfidenceLevel>("low");
    expect(confidenceLevelFromScore(1 / 3 - 1e-9)).toBe<ConfidenceLevel>("low");
    expect(confidenceLevelFromScore(1 / 3)).toBe<ConfidenceLevel>("medium");
    expect(confidenceLevelFromScore(0.5)).toBe<ConfidenceLevel>("medium");
    expect(confidenceLevelFromScore(2 / 3 - 1e-9)).toBe<ConfidenceLevel>("medium");
    expect(confidenceLevelFromScore(2 / 3)).toBe<ConfidenceLevel>("high");
    expect(confidenceLevelFromScore(1)).toBe<ConfidenceLevel>("high");
  });
});

describe("disagreement facets", () => {
  it("enumerates evidence/assumptions/uncertainty", () => {
    expect(DISAGREEMENT_FACETS).toEqual<readonly DisagreementFacet[]>([
      "evidence",
      "assumptions",
      "uncertainty",
    ]);
  });
});

describe("discussion directives + templates", () => {
  it("isolates the directive array and the template keys to the same closed set", () => {
    const templateKeys = Object.keys(DISCUSSION_DIRECTIVE_TEMPLATES).sort();
    expect(templateKeys).toEqual([...DISCUSSION_DIRECTIVES].sort());
  });

  it("renders a non-empty bounded template for every directive", () => {
    for (const directive of DISCUSSION_DIRECTIVES) {
      const template = DISCUSSION_DIRECTIVE_TEMPLATES[directive];
      expect(template.length).toBeGreaterThan(0);
      expect(template.length).toBeLessThanOrEqual(160);
      expect(template).not.toMatch(/[\r\n]/);
    }
  });

  it("never embeds a forbidden content-bearing substring", () => {
    for (const directive of DISCUSSION_DIRECTIVES) {
      const lowered = DISCUSSION_DIRECTIVE_TEMPLATES[directive].toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(lowered.includes(forbidden)).toBe(false);
      }
    }
  });

  it("assertNeverDiscussionDirective throws for an unhandled value", () => {
    expect(() => assertNeverDiscussionDirective("ghost" as never)).toThrow(
      /Unhandled DiscussionDirective/,
    );
  });
});

describe("discussion mode plans (totality + invariants)", () => {
  it("has a frozen plan for every mode whose key matches its mode field", () => {
    const planKeys = Object.keys(DISCUSSION_MODE_PLANS).sort();
    expect(planKeys).toEqual([...DISCUSSION_MODES].sort());
    for (const mode of DISCUSSION_MODES) {
      expect(DISCUSSION_MODE_PLANS[mode].mode).toBe(mode);
      expect(discussionModePlan(mode)).toBe(DISCUSSION_MODE_PLANS[mode]);
    }
  });

  it("mandates all three facets for every disagreement-capable mode", () => {
    const disagreementModes: readonly DiscussionMode[] = [
      "challenge",
      "review",
      "decide",
      "evidence-check",
    ];
    for (const mode of disagreementModes) {
      const facets = DISCUSSION_MODE_PLANS[mode].mandatedFacets;
      for (const facet of DISAGREEMENT_FACETS) {
        expect(facets).toContain(facet);
      }
    }
  });

  it("lets brainstorm relax uncertainty", () => {
    const plan = DISCUSSION_MODE_PLANS.brainstorm;
    expect(plan.mandatedFacets).not.toContain<DisagreementFacet>("uncertainty");
    expect(plan.requiresUncertaintyDisclosure).toBe(false);
  });

  it("only the decide mode produces a decision recommendation", () => {
    for (const mode of DISCUSSION_MODES) {
      expect(DISCUSSION_MODE_PLANS[mode].producesDecisionRecommendation).toBe(mode === "decide");
    }
  });

  it("references only known directives in every plan", () => {
    for (const mode of DISCUSSION_MODES) {
      const plan = DISCUSSION_MODE_PLANS[mode];
      expect(plan.directives.length).toBeGreaterThan(0);
      for (const directive of plan.directives) {
        expect(DISCUSSION_DIRECTIVES).toContain<DiscussionDirective>(directive);
      }
    }
  });
});

describe("voice gating (text-first + reuse)", () => {
  it("allows spoken turns only for capture-capable profiles", () => {
    const expected: Readonly<Record<VoiceProfile, boolean>> = {
      none: false,
      "speech-to-text": true,
      "speech-output": false,
      "full-realtime": true,
    };
    for (const profile of VOICE_PROFILES) {
      expect(voiceCanDriveDiscussion(profile)).toBe(expected[profile]);
    }
  });

  it("keeps text-first behavior usable: every mode has a plan regardless of voice", () => {
    for (const mode of DISCUSSION_MODES) {
      expect(discussionModePlan(mode)).toBeDefined();
    }
  });
});

describe("turn status machine", () => {
  it("enumerates the four statuses", () => {
    expect(DISCUSSION_TURN_STATUSES).toEqual<readonly DiscussionTurnStatus[]>([
      "active",
      "interrupted",
      "recovered",
      "resolved",
    ]);
  });

  it("isDiscussionTurnStatus accepts members and rejects non-members", () => {
    for (const status of DISCUSSION_TURN_STATUSES) {
      expect(isDiscussionTurnStatus(status)).toBe(true);
    }
    expect(isDiscussionTurnStatus("paused")).toBe(false);
    expect(isDiscussionTurnStatus(0)).toBe(false);
  });

  it("permits exactly the legal transitions", () => {
    const legal = new Set<string>();
    for (const from of DISCUSSION_TURN_STATUSES) {
      for (const to of DISCUSSION_TURN_STATUS_TRANSITIONS[from]) {
        legal.add(`${from}->${to}`);
      }
    }
    for (const from of DISCUSSION_TURN_STATUSES) {
      for (const to of DISCUSSION_TURN_STATUSES) {
        expect(canTransitionDiscussionTurnStatus(from, to)).toBe(legal.has(`${from}->${to}`));
      }
    }
  });

  it("makes resolved terminal", () => {
    expect(DISCUSSION_TURN_STATUS_TRANSITIONS.resolved).toEqual([]);
  });

  it("assertNeverDiscussionTurnStatus throws for an unhandled value", () => {
    expect(() => assertNeverDiscussionTurnStatus("paused" as never)).toThrow(
      /Unhandled DiscussionTurnStatus/,
    );
  });
});

describe("topicId validation", () => {
  it("accepts a clean opaque id", () => {
    expect(isValidDiscussionTopicId("topic-abc123")).toBe(true);
    expect(discussionTopicIdReasons("topic-abc123")).toEqual([]);
  });

  it("rejects a non-string with a single reason", () => {
    expect(discussionTopicIdReasons(123)).toEqual(["topicId: must be a string"]);
    expect(isValidDiscussionTopicId(123)).toBe(false);
  });

  it("accumulates multiple reasons for a multiply-invalid id", () => {
    const reasons = discussionTopicIdReasons("  a/b  ");
    expect(reasons).toContain("topicId: must not have surrounding whitespace");
    expect(reasons).toContain("topicId: contains control characters");
    expect(reasons).toContain("topicId: contains a forbidden path fragment");
    expect(reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects empty / whitespace-only", () => {
    expect(discussionTopicIdReasons("")).toContain("topicId: must not be empty or whitespace-only");
    expect(discussionTopicIdReasons("   ")).toContain(
      "topicId: must not be empty or whitespace-only",
    );
  });

  it("rejects an over-length id at the 256 boundary", () => {
    expect(isValidDiscussionTopicId("x".repeat(256))).toBe(true);
    expect(discussionTopicIdReasons("x".repeat(257))).toContain("topicId: exceeds max length 256");
  });

  it("rejects a non-NFKC id", () => {
    // U+FF21 FULLWIDTH LATIN CAPITAL A normalises to "A" under NFKC.
    expect(discussionTopicIdReasons("Ａbc")).toContain("topicId: must be NFKC-normalised");
  });

  it("rejects path-traversal fragments", () => {
    expect(discussionTopicIdReasons("..")).toContain("topicId: contains a forbidden path fragment");
    expect(discussionTopicIdReasons("a\\b")).toContain(
      "topicId: contains a forbidden path fragment",
    );
  });
});

describe("turn lifecycle helpers (AC4)", () => {
  it("begins a turn in the active status", () => {
    const ctx = beginDiscussionTurn("decide", "topic-1", 0);
    expect(ctx).toEqual<DiscussionTurnContext>({
      schemaVersion: "1",
      mode: "decide",
      topicId: "topic-1",
      turnIndex: 0,
      status: "active",
    });
  });

  it("rejects an invalid topicId and an invalid turnIndex at construction", () => {
    expect(() => beginDiscussionTurn("decide", "bad/id", 0)).toThrow(/topicId/);
    expect(() => beginDiscussionTurn("decide", "topic-1", -1)).toThrow(/turnIndex/);
    expect(() => beginDiscussionTurn("decide", "topic-1", 1.5)).toThrow(/turnIndex/);
  });

  it("preserves mode/topicId/turnIndex through interrupt then recover", () => {
    const started = beginDiscussionTurn("challenge", "topic-keep", 7);
    const interrupted = applyDiscussionInterruption(started);
    const recovered = applyDiscussionRecovery(interrupted);

    expect(interrupted.status).toBe<DiscussionTurnStatus>("interrupted");
    expect(recovered.status).toBe<DiscussionTurnStatus>("recovered");
    for (const ctx of [interrupted, recovered]) {
      expect(ctx.mode).toBe(started.mode);
      expect(ctx.topicId).toBe(started.topicId);
      expect(ctx.turnIndex).toBe(started.turnIndex);
    }
  });

  it("returns the input unchanged on an illegal transition", () => {
    const started = beginDiscussionTurn("review", "topic-2", 0);
    // recovery is illegal from active.
    expect(applyDiscussionRecovery(started)).toBe(started);
    const resolved = resolveDiscussionTurn(started);
    expect(resolved.status).toBe<DiscussionTurnStatus>("resolved");
    // resolved is terminal: further transitions are no-ops returning the same reference.
    expect(applyDiscussionInterruption(resolved)).toBe(resolved);
    expect(applyDiscussionRecovery(resolved)).toBe(resolved);
    expect(resolveDiscussionTurn(resolved)).toBe(resolved);
  });

  it("supports repeated barge-in (recovered -> interrupted -> recovered)", () => {
    const started = beginDiscussionTurn("decide", "topic-3", 2);
    const recovered = applyDiscussionRecovery(applyDiscussionInterruption(started));
    const reInterrupted = applyDiscussionInterruption(recovered);
    expect(reInterrupted.status).toBe<DiscussionTurnStatus>("interrupted");
    expect(reInterrupted.topicId).toBe("topic-3");
    expect(reInterrupted.turnIndex).toBe(2);
  });
});

describe("turn summary (content-free)", () => {
  it("summarizes without confidence when no score is given", () => {
    const ctx = beginDiscussionTurn("challenge", "topic-4", 3);
    const summary = summarizeDiscussionTurn(ctx);
    expect(summary).toEqual({
      mode: "challenge",
      status: "active",
      turnIndex: 3,
      mandatedFacetCount: 3,
    });
    expect(summary.confidence).toBeUndefined();
    expect(Object.values(summary)).not.toContain("topic-4");
  });

  it("includes a derived confidence level when a score is given", () => {
    const ctx = beginDiscussionTurn("brainstorm", "topic-5", 0);
    expect(summarizeDiscussionTurn(ctx, 0.9).confidence).toBe<ConfidenceLevel>("high");
    expect(summarizeDiscussionTurn(ctx, 0.5).confidence).toBe<ConfidenceLevel>("medium");
    expect(summarizeDiscussionTurn(ctx, 0).confidence).toBe<ConfidenceLevel>("low");
    expect(summarizeDiscussionTurn(ctx, 0).mandatedFacetCount).toBe(2);
  });
});

describe("validateDiscussionTurnContext", () => {
  it("accepts a well-formed context", () => {
    const ctx = beginDiscussionTurn("decide", "topic-ok", 1);
    expect(validateDiscussionTurnContext(ctx)).toEqual({ ok: true });
  });

  it("rejects a non-object", () => {
    expect(validateDiscussionTurnContext(null)).toEqual({
      ok: false,
      reasons: ["context: must be an object"],
    });
  });

  it("accumulates all field reasons", () => {
    const result = validateDiscussionTurnContext({
      schemaVersion: "9",
      mode: "debate",
      topicId: "bad/id",
      turnIndex: -2,
      status: "paused",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("schemaVersion: unsupported");
      expect(result.reasons).toContain("mode: unknown discussion mode");
      expect(result.reasons).toContain("topicId: contains a forbidden path fragment");
      expect(result.reasons).toContain("turnIndex: must be a non-negative integer");
      expect(result.reasons).toContain("status: unknown turn status");
    }
  });

  it("rejects a non-integer turnIndex", () => {
    const ctx = beginDiscussionTurn("decide", "topic-ok", 1);
    const result = validateDiscussionTurnContext({ ...ctx, turnIndex: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("turnIndex: must be a non-negative integer");
    }
  });
});

describe("validateDiscussionModePlan", () => {
  it("accepts every canonical plan", () => {
    for (const mode of DISCUSSION_MODES) {
      expect(validateDiscussionModePlan(DISCUSSION_MODE_PLANS[mode])).toEqual({ ok: true });
    }
  });

  it("rejects a non-object", () => {
    expect(validateDiscussionModePlan(42)).toEqual({
      ok: false,
      reasons: ["plan: must be an object"],
    });
  });

  it("rejects an unknown mode", () => {
    expect(validateDiscussionModePlan({ mode: "debate" })).toEqual({
      ok: false,
      reasons: ["mode: unknown discussion mode"],
    });
  });

  it("flags a disagreement-capable plan missing a mandated facet", () => {
    const broken: DiscussionModePlan = {
      ...DISCUSSION_MODE_PLANS.challenge,
      mandatedFacets: ["evidence", "assumptions"],
    };
    const result = validateDiscussionModePlan(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain("mandatedFacets: challenge must mandate uncertainty");
    }
  });

  it("treats a non-array mandatedFacets as mandating nothing", () => {
    const result = validateDiscussionModePlan({
      ...DISCUSSION_MODE_PLANS.challenge,
      mandatedFacets: "evidence",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const facet of DISAGREEMENT_FACETS) {
        expect(result.reasons).toContain(`mandatedFacets: challenge must mandate ${facet}`);
      }
    }
  });

  it("flags an empty directive list and unknown directives", () => {
    const empty = validateDiscussionModePlan({ ...DISCUSSION_MODE_PLANS.review, directives: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.reasons).toContain("directives: must not be empty");
    }
    const unknown = validateDiscussionModePlan({
      ...DISCUSSION_MODE_PLANS.review,
      directives: ["ghost-directive"],
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.reasons.some((r) => r.startsWith("directives: unknown directive"))).toBe(true);
    }
  });

  it("flags a decision-recommendation mismatch against the canonical plan", () => {
    const broken = { ...DISCUSSION_MODE_PLANS.challenge, producesDecisionRecommendation: true };
    const result = validateDiscussionModePlan(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContain(
        "producesDecisionRecommendation: disagrees with canonical plan",
      );
    }
  });
});

describe("JSON round-trip stability", () => {
  it("preserves a turn context across stringify/parse", () => {
    const ctx = applyDiscussionInterruption(beginDiscussionTurn("evidence-check", "topic-rt", 4));
    const roundTripped = JSON.parse(JSON.stringify(ctx)) as DiscussionTurnContext;
    expect(roundTripped).toEqual(ctx);
    expect(validateDiscussionTurnContext(roundTripped)).toEqual({ ok: true });
  });

  it("preserves every mode plan across stringify/parse", () => {
    for (const mode of DISCUSSION_MODES) {
      const plan = DISCUSSION_MODE_PLANS[mode];
      const roundTripped = JSON.parse(JSON.stringify(plan)) as DiscussionModePlan;
      expect(roundTripped).toEqual(plan);
      expect(validateDiscussionModePlan(roundTripped)).toEqual({ ok: true });
    }
  });
});

describe("directive ↔ facet coverage (AC3 regression guard)", () => {
  it("keys DISCUSSION_DIRECTIVE_FACETS for every directive (totality)", () => {
    const facetKeys = Object.keys(DISCUSSION_DIRECTIVE_FACETS).sort();
    expect(facetKeys).toEqual([...DISCUSSION_DIRECTIVES].sort());
    for (const directive of DISCUSSION_DIRECTIVES) {
      const facets = DISCUSSION_DIRECTIVE_FACETS[directive];
      expect(Array.isArray(facets)).toBe(true);
      for (const facet of facets) {
        expect(DISAGREEMENT_FACETS).toContain<DisagreementFacet>(facet);
      }
    }
  });

  it("renders directives that cover every mandated facet for EVERY mode", () => {
    // This is the load-bearing guard: before `cite-evidence-or-state-none` was added to `decide`, the
    // `decide` plan mandated `evidence` but rendered no evidence-citing directive, so this failed.
    for (const mode of DISCUSSION_MODES) {
      expect(discussionDirectivesCoverFacets(DISCUSSION_MODE_PLANS[mode])).toBe(true);
    }
  });

  it("returns false when a mode drops the only directive covering a mandated facet", () => {
    // Mutation: strip `decide`'s evidence-citing directive and assert the guard catches the gap.
    const broken: DiscussionModePlan = {
      ...DISCUSSION_MODE_PLANS.decide,
      directives: DISCUSSION_MODE_PLANS.decide.directives.filter(
        (directive) => directive !== "cite-evidence-or-state-none",
      ),
    };
    // The mutated plan still mandates `evidence`, but no remaining directive covers it.
    expect(broken.mandatedFacets).toContain<DisagreementFacet>("evidence");
    expect(broken.directives.every((d) => !DISCUSSION_DIRECTIVE_FACETS[d].includes("evidence"))).toBe(
      true,
    );
    expect(discussionDirectivesCoverFacets(broken)).toBe(false);
  });
});
