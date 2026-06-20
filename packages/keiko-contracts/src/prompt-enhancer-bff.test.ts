import { describe, expect, it } from "vitest";

import {
  PROMPT_ENHANCEMENT_DEFAULT_CANDIDATE_COUNT,
  PROMPT_ENHANCEMENT_LOCALE_MAX_CHARS,
  PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT,
  PROMPT_ENHANCEMENT_MODEL_AVAILABILITIES,
  PROMPT_ENHANCEMENT_MODEL_ID_MAX_CHARS,
  validatePromptEnhancementWireRequest,
} from "./prompt-enhancer-bff.js";

describe("validatePromptEnhancementWireRequest", () => {
  it("accepts a minimal request with only text", () => {
    const result = validatePromptEnhancementWireRequest({ text: "Write a haiku about the sea." });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("Write a haiku about the sea.");
      // exactOptionalPropertyTypes: omitted optionals must not appear as keys.
      expect(Object.keys(result.value)).toEqual(["text"]);
    }
  });

  it("accepts a fully populated request", () => {
    const result = validatePromptEnhancementWireRequest({
      text: "Summarize the attached report.",
      profilePreference: "precise",
      missingInformationStrategy: "assume",
      hasConnectedContext: true,
      attachmentCount: 2,
      locale: "en-US",
      modelId: "example-chat-model",
      candidateCount: 4,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profilePreference).toBe("precise");
      expect(result.value.missingInformationStrategy).toBe("assume");
      expect(result.value.hasConnectedContext).toBe(true);
      expect(result.value.attachmentCount).toBe(2);
      expect(result.value.locale).toBe("en-US");
      expect(result.value.modelId).toBe("example-chat-model");
      expect(result.value.candidateCount).toBe(4);
    }
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "text"],
    ["number", 7],
  ])("rejects a non-object request (%s)", (_label, input) => {
    const result = validatePromptEnhancementWireRequest(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("request must be an object");
    }
  });

  it("rejects an unknown field", () => {
    const result = validatePromptEnhancementWireRequest({ text: "x", evil: "y" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("request must not contain unknown fields");
    }
  });

  it("rejects a missing text field", () => {
    const result = validatePromptEnhancementWireRequest({ profilePreference: "fast" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("request.text must be a string");
    }
  });

  it("rejects a whitespace-only text field", () => {
    const result = validatePromptEnhancementWireRequest({ text: "   \t  " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("request.text must not be empty or whitespace-only");
    }
  });

  it("rejects an over-length text field", () => {
    const result = validatePromptEnhancementWireRequest({ text: "a".repeat(100_001) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("request.text must be at most"))).toBe(true);
    }
  });

  it("rejects an unknown profilePreference", () => {
    const result = validatePromptEnhancementWireRequest({ text: "x", profilePreference: "turbo" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "request.profilePreference must be a known profile id when set",
      );
    }
  });

  it("rejects an unknown missingInformationStrategy", () => {
    const result = validatePromptEnhancementWireRequest({
      text: "x",
      missingInformationStrategy: "ask",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "request.missingInformationStrategy must be a known strategy when set",
      );
    }
  });

  it("rejects a non-boolean hasConnectedContext", () => {
    const result = validatePromptEnhancementWireRequest({ text: "x", hasConnectedContext: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("request.hasConnectedContext must be a boolean when set");
    }
  });

  it("rejects a negative attachmentCount", () => {
    const result = validatePromptEnhancementWireRequest({ text: "x", attachmentCount: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "request.attachmentCount must be a non-negative integer when set",
      );
    }
  });

  it("rejects a non-integer attachmentCount", () => {
    const result = validatePromptEnhancementWireRequest({ text: "x", attachmentCount: 1.5 });
    expect(result.ok).toBe(false);
  });

  it("rejects an over-length locale", () => {
    const result = validatePromptEnhancementWireRequest({
      text: "x",
      locale: "a".repeat(PROMPT_ENHANCEMENT_LOCALE_MAX_CHARS + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("request.locale must be safe text"))).toBe(
        true,
      );
    }
  });

  it("rejects a locale containing a bidi control character", () => {
    const result = validatePromptEnhancementWireRequest({
      text: "x",
      locale: `en${String.fromCharCode(0x202e)}US`,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty modelId", () => {
    const result = validatePromptEnhancementWireRequest({ text: "x", modelId: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.startsWith("request.modelId must be non-empty safe text")),
      ).toBe(true);
    }
  });

  it("rejects an over-length modelId", () => {
    const result = validatePromptEnhancementWireRequest({
      text: "x",
      modelId: "m".repeat(PROMPT_ENHANCEMENT_MODEL_ID_MAX_CHARS + 1),
    });
    expect(result.ok).toBe(false);
  });

  it.each([0, -1, 1.5, PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT + 1])(
    "rejects an out-of-range candidateCount (%s)",
    (candidateCount) => {
      const result = validatePromptEnhancementWireRequest({ text: "x", candidateCount });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => e.startsWith("request.candidateCount must be an integer")),
        ).toBe(true);
      }
    },
  );

  it("accepts the boundary candidate counts", () => {
    for (const candidateCount of [1, PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT]) {
      const result = validatePromptEnhancementWireRequest({ text: "x", candidateCount });
      expect(result.ok).toBe(true);
    }
  });

  it("collects multiple errors at once", () => {
    const result = validatePromptEnhancementWireRequest({
      text: "",
      profilePreference: "nope",
      attachmentCount: -3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("prompt enhancer wire constants", () => {
  it("exposes sane bounds", () => {
    expect(PROMPT_ENHANCEMENT_DEFAULT_CANDIDATE_COUNT).toBeLessThanOrEqual(
      PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT,
    );
    expect(PROMPT_ENHANCEMENT_MODEL_AVAILABILITIES).toEqual([
      "available",
      "unavailable",
      "not-requested",
    ]);
  });
});
