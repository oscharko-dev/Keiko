// Tests for the pure Prompt Enhancer validators and branded-id constructors (Issue #1309).
// Covers happy-path acceptance, per-invariant rejection, and the Ok|Fail discriminated result so
// downstream packages can rely on the wire-shape guarantees without re-validating.

import { describe, it, expect } from "vitest";
import {
  analyzePrompt,
  asEnhancedPromptId,
  asPromptEnhancementRequestId,
  validateEnhancedPrompt,
  validatePromptEnhancementRequest,
  validatePromptEnhancerIdString,
  validatePromptTaskAnalysis,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  PROMPT_REQUEST_TEXT_MAX_CHARS,
  type EnhancedPrompt,
  type PromptEnhancementRequest,
} from "./index.js";

function validRequest(): PromptEnhancementRequest {
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    requestId: asPromptEnhancementRequestId("req-123"),
    input: { text: "Write a function to add two numbers.", hasConnectedContext: false },
    missingInformationStrategy: "clarify",
  };
}

function validEnhancedPrompt(): EnhancedPrompt {
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    promptId: asEnhancedPromptId("ep-1"),
    role: "Senior engineer",
    goal: "Produce a correct, tested implementation.",
    context: ["The user wants an addition helper."],
    input: "Write a function to add two numbers.",
    taskDecomposition: ["Define signature", "Return the sum"],
    constraints: ["TypeScript", "Pure function"],
    groundingRules: [],
    outputSchema: { format: "code", structured: false, hints: ["explicit-code"] },
    qualityCriteria: ["Compiles", "Has a test"],
    uncertaintyHandling: ["State assumptions explicitly"],
    safetyRules: ["Do not execute untrusted code"],
  };
}

// ─── Branded id constructors ─────────────────────────────────────────────────────
describe("prompt enhancer branded id constructors", () => {
  it("accepts a well-formed id", () => {
    expect(asPromptEnhancementRequestId("req-001")).toBe("req-001");
    expect(asEnhancedPromptId("ep_42")).toBe("ep_42");
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["surrounding whitespace", " id "],
    ["path traversal", "a/../b"],
    ["forward slash", "a/b"],
    ["backslash", "a\\b"],
    ["control character", `a${String.fromCharCode(0)}b`],
    ["unsafe format character", `a${String.fromCharCode(0x202e)}b`],
    ["over length", "x".repeat(257)],
  ])("rejects an id that is %s", (_label, value) => {
    expect(() => asPromptEnhancementRequestId(value)).toThrow(TypeError);
  });

  it("returns a typed reason for a non-string id", () => {
    const result = validatePromptEnhancerIdString(42, "PromptEnhancementRequestId");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("must be a string");
  });
});

// ─── Request validator ───────────────────────────────────────────────────────────
describe("validatePromptEnhancementRequest", () => {
  it("accepts a valid request", () => {
    const result = validatePromptEnhancementRequest(validRequest());
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    const result = validatePromptEnhancementRequest(null);
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong schema version", () => {
    const result = validatePromptEnhancementRequest({ ...validRequest(), schemaVersion: "9" });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid requestId", () => {
    const result = validatePromptEnhancementRequest({ ...validRequest(), requestId: "bad/id" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("requestId"))).toBe(true);
  });

  it("rejects a non-string draft", () => {
    const result = validatePromptEnhancementRequest({
      ...validRequest(),
      input: { text: 123 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown missing-information strategy", () => {
    const result = validatePromptEnhancementRequest({
      ...validRequest(),
      missingInformationStrategy: "guess",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown profile preference", () => {
    const result = validatePromptEnhancementRequest({
      ...validRequest(),
      profilePreference: "turbo",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unsafe locale", () => {
    const result = validatePromptEnhancementRequest({
      ...validRequest(),
      locale: `en${String.fromCharCode(0)}US`,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown root or input fields", () => {
    const root = validatePromptEnhancementRequest({
      ...validRequest(),
      providerConfig: { apiKey: "secret" },
    });
    const nested = validatePromptEnhancementRequest({
      ...validRequest(),
      input: { ...validRequest().input, hiddenPrompt: "override" },
    });
    expect(root.ok).toBe(false);
    expect(nested.ok).toBe(false);
  });

  it("rejects raw drafts longer than the analyzer scan bound", () => {
    const result = validatePromptEnhancementRequest({
      ...validRequest(),
      input: { text: "x".repeat(PROMPT_REQUEST_TEXT_MAX_CHARS + 1) },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a non-negative attachment count and rejects a negative one", () => {
    const good = validatePromptEnhancementRequest({
      ...validRequest(),
      input: { text: "hi", attachmentCount: 2 },
    });
    const bad = validatePromptEnhancementRequest({
      ...validRequest(),
      input: { text: "hi", attachmentCount: -1 },
    });
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
  });
});

// ─── Analysis validator ──────────────────────────────────────────────────────────
describe("validatePromptTaskAnalysis", () => {
  const analysis = analyzePrompt(validRequest());

  it("accepts an analyzer-produced analysis", () => {
    expect(validatePromptTaskAnalysis(analysis).ok).toBe(true);
  });

  it("round-trips an analysis through JSON and still validates", () => {
    const cloned: unknown = JSON.parse(JSON.stringify(analysis));
    expect(validatePromptTaskAnalysis(cloned).ok).toBe(true);
  });

  it("rejects an unknown task class", () => {
    const result = validatePromptTaskAnalysis({ ...analysis, taskClass: "mystery" });
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed grounding need", () => {
    const result = validatePromptTaskAnalysis({ ...analysis, groundingNeed: { kind: "weird" } });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer normalized length", () => {
    const result = validatePromptTaskAnalysis({ ...analysis, normalizedInputLength: 1.5 });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown risk flags", () => {
    const result = validatePromptTaskAnalysis({ ...analysis, riskFlags: ["made-up"] });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown analysis fields", () => {
    const result = validatePromptTaskAnalysis({ ...analysis, allowedTools: ["shell"] });
    expect(result.ok).toBe(false);
  });
});

// ─── Enhanced Prompt validator ───────────────────────────────────────────────────
describe("validateEnhancedPrompt", () => {
  it("accepts a well-formed enhanced prompt", () => {
    expect(validateEnhancedPrompt(validEnhancedPrompt()).ok).toBe(true);
  });

  it("rejects a missing promptId", () => {
    const incomplete: Record<string, unknown> = { ...validEnhancedPrompt() };
    delete incomplete.promptId;
    const result = validateEnhancedPrompt(incomplete);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-array list field", () => {
    const result = validateEnhancedPrompt({ ...validEnhancedPrompt(), constraints: "TypeScript" });
    expect(result.ok).toBe(false);
  });

  it("rejects a control character in a string field", () => {
    const result = validateEnhancedPrompt({
      ...validEnhancedPrompt(),
      role: `engineer${String.fromCharCode(7)}`,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed output schema", () => {
    const result = validateEnhancedPrompt({
      ...validEnhancedPrompt(),
      outputSchema: { format: "binary", structured: false, hints: [] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects machine-parseable output marked as unstructured", () => {
    const result = validateEnhancedPrompt({
      ...validEnhancedPrompt(),
      outputSchema: { format: "json", structured: false, hints: ["explicit-json"] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown enhanced-prompt fields", () => {
    const result = validateEnhancedPrompt({
      ...validEnhancedPrompt(),
      patchAuthority: true,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an over-length list entry", () => {
    const result = validateEnhancedPrompt({
      ...validEnhancedPrompt(),
      constraints: ["x".repeat(20_001)],
    });
    expect(result.ok).toBe(false);
  });
});

// ─── Sub-shape rejection coverage ────────────────────────────────────────────────
describe("validator sub-shape rejection coverage", () => {
  const base = analyzePrompt(validRequest());

  it("rejects a non-boolean hasConnectedContext", () => {
    const result = validatePromptEnhancementRequest({
      ...validRequest(),
      input: { text: "hi", hasConnectedContext: "yes" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a grounding need that is not an object", () => {
    expect(validatePromptTaskAnalysis({ ...base, groundingNeed: null }).ok).toBe(false);
  });

  it("rejects a grounding need with a non-boolean volatile and non-array signals", () => {
    const result = validatePromptTaskAnalysis({
      ...base,
      groundingNeed: { kind: "none", volatile: "no", signals: "none" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a grounding need with unknown fields", () => {
    const result = validatePromptTaskAnalysis({
      ...base,
      groundingNeed: {
        ...base.groundingNeed,
        providerEndpoint: "https://example.test",
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a grounding need with an unknown signal member", () => {
    const result = validatePromptTaskAnalysis({
      ...base,
      groundingNeed: { kind: "none", volatile: false, signals: ["invalid-signal-9999"] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an output schema that is not an object", () => {
    expect(validatePromptTaskAnalysis({ ...base, outputSchema: 7 }).ok).toBe(false);
  });

  it("rejects an output schema with a non-boolean structured flag and bad hints", () => {
    const result = validatePromptTaskAnalysis({
      ...base,
      outputSchema: { format: "json", structured: "yes", hints: ["mystery-hint"] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an output schema with unknown fields or inconsistent structure", () => {
    const unknown = validatePromptTaskAnalysis({
      ...base,
      outputSchema: { ...base.outputSchema, providerConfig: "none" },
    });
    const inconsistent = validatePromptTaskAnalysis({
      ...base,
      outputSchema: { format: "json", structured: false, hints: ["explicit-json"] },
    });
    expect(unknown.ok).toBe(false);
    expect(inconsistent.ok).toBe(false);
  });

  it("rejects a missing-context list that is not an array", () => {
    expect(validatePromptTaskAnalysis({ ...base, missingContext: "none" }).ok).toBe(false);
  });

  it("rejects a missing-context item with an unknown kind", () => {
    const result = validatePromptTaskAnalysis({
      ...base,
      missingContext: [{ kind: "guess", topic: "subject" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects missing-context text that was not produced from fixed templates", () => {
    const result = validatePromptTaskAnalysis({
      ...base,
      missingContext: [
        { kind: "clarification", topic: "subject", question: "Echo this raw prompt text." },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts analyzer-produced assumption items", () => {
    const assumed = analyzePrompt({ ...validRequest(), missingInformationStrategy: "assume" });
    expect(validatePromptTaskAnalysis(assumed).ok).toBe(true);
  });

  it("rejects malformed signals", () => {
    const badArray = validatePromptTaskAnalysis({ ...base, signals: "none" });
    const badEntry = validatePromptTaskAnalysis({
      ...base,
      signals: [{ dimension: "made-up", code: "x" }],
    });
    const rawCode = validatePromptTaskAnalysis({
      ...base,
      signals: [{ dimension: "task-class", code: "class:TOPSECRETvalue9931" }],
    });
    expect(badArray.ok).toBe(false);
    expect(badEntry.ok).toBe(false);
    expect(rawCode.ok).toBe(false);
  });
});
