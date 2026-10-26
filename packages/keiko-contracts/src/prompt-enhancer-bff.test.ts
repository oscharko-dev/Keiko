import { describe, expect, expectTypeOf, it } from "vitest";

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

// Family6 preparation: conditional original-first source/public copy-phase hypotheses.
// These controls have not been executed and are not a regression claim.
describe("family6 wire copy observations", () => {
  const sourceEntry = validatePromptEnhancementWireRequest;
  it.each(["source", "public"])("admits the actual copied text through %s", async (entry) => {
    const validate =
      entry === "source"
        ? sourceEntry
        : (await import("@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-bff"))
            .validatePromptEnhancementWireRequest;
    let reads = 0;
    const input = {
      get text(): unknown {
        reads += 1;
        return reads === 4 ? 42 : "healthy draft";
      },
    };
    expect(validate(input)).toEqual({ ok: false, errors: ["request.text must be a string"] });
    expect(reads).toBe(4);
  });
  it.each(["source", "public"])("preserves a healthy copied text through %s", async (entry) => {
    const validate =
      entry === "source"
        ? sourceEntry
        : (await import("@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-bff"))
            .validatePromptEnhancementWireRequest;
    let reads = 0;
    const input = {
      get text(): string {
        reads += 1;
        return "healthy draft";
      },
    };
    const result = validate(input);
    expect(result).toEqual({ ok: true, value: { text: "healthy draft" } });
    expect(reads).toBe(4);
    if (result.ok) expect(result.value).not.toBe(input);
  });
});

// Source-only healthy changing copy observation; UNEXECUTED.
describe("family6 healthy changing wire copy", () => {
  it.each(["source", "public"])(
    "retains the fourth valid copied text through %s",
    async (entry) => {
      const validate =
        entry === "source"
          ? validatePromptEnhancementWireRequest
          : (await import("@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-bff"))
              .validatePromptEnhancementWireRequest;
      let reads = 0;
      const input = {
        get text(): string {
          return ++reads === 4 ? "later valid draft" : "earlier valid draft";
        },
      };
      const result = validate(input);
      expect(result).toEqual({ ok: true, value: { text: "later valid draft" } });
      expect(reads).toBe(4);
      if (result.ok) expect(result.value).not.toBe(input);
    },
  );
});

describe("complete wire optional copy admission", () => {
  it.each(["source", "public"] as const)(
    "preserves absent and ordinary undefined omission through %s",
    async (surface) => {
      const validate =
        surface === "source"
          ? validatePromptEnhancementWireRequest
          : (await import("@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-bff"))
              .validatePromptEnhancementWireRequest;
      for (const input of [
        { text: "healthy draft" },
        { text: "healthy draft", profilePreference: undefined },
      ]) {
        const result = validate(input);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(Object.keys(result.value)).toEqual(["text"]);
          expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
          expect(result.value).not.toBe(input);
        }
      }
    },
  );
  it.each(["source", "public"] as const)(
    "preserves the actual later-valid profile copy through %s",
    async (surface) => {
      const validate =
        surface === "source"
          ? validatePromptEnhancementWireRequest
          : (await import("@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-bff"))
              .validatePromptEnhancementWireRequest;
      let reads = 0;
      const input = {
        text: "healthy draft",
        get profilePreference(): string {
          return ++reads < 4 ? "technical" : "precise";
        },
      };
      const result = validate(input);
      const observedReads = reads;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.profilePreference).toBe("precise");
        expect(Object.keys(result.value)).toEqual(["text", "profilePreference"]);
        expect(result.value).not.toBe(input);
      }
      expect(observedReads).toBe(4);
    },
  );
  it.each(["source", "public"] as const)(
    "refuses an actual present undefined profile copy through %s",
    async (surface) => {
      const validate =
        surface === "source"
          ? validatePromptEnhancementWireRequest
          : (await import("@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-bff"))
              .validatePromptEnhancementWireRequest;
      let reads = 0;
      const input = {
        text: "healthy draft",
        get profilePreference(): unknown {
          return ++reads < 4 ? "technical" : undefined;
        },
      };
      const result = validate(input);
      const observedReads = reads;
      expect(result).toEqual({
        ok: false,
        errors: ["request.profilePreference must be a known profile id when set"],
      });
      expect(observedReads).toBe(4);
    },
  );
});

describe("private skill output kind", () => {
  // DEV-SYNC-PROMPT-OUTPUT-KIND-COPY-01: admit the actual supplied copy, not a filtered mode.
  for (const surface of ["source", "public"] as const) {
    it(`${surface}: refuses an invalid output kind observed during copying`, async () => {
      const validate =
        surface === "source"
          ? validatePromptEnhancementWireRequest
          : (await import("@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-bff"))
              .validatePromptEnhancementWireRequest;
      let reads = 0;
      const input = {
        text: "Synthetic complete document",
        get outputKind(): string {
          return ++reads < 3 ? "markdown-skill" : "invalid-kind";
        },
      };
      expect(validate(input)).toEqual({
        ok: false,
        errors: ["request.outputKind must be markdown-skill when set"],
      });
      expect(reads).toBe(4);
    });
    it(`${surface}: refuses a present undefined mode copied after successful preflight`, async () => {
      const validate =
        surface === "source"
          ? validatePromptEnhancementWireRequest
          : (await import("@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-bff"))
              .validatePromptEnhancementWireRequest;
      let reads = 0;
      const input = {
        text: "Synthetic complete document",
        get outputKind(): string | undefined {
          return ++reads < 4 ? "markdown-skill" : undefined;
        },
      };
      expect(validate(input)).toEqual({
        ok: false,
        errors: ["request.outputKind must be markdown-skill when set"],
      });
      expect(reads).toBe(4);
    });
    it(`${surface}: preserves ordinary mode omission skill mode and initial error order`, async () => {
      const validate =
        surface === "source"
          ? validatePromptEnhancementWireRequest
          : (await import("@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-bff"))
              .validatePromptEnhancementWireRequest;
      for (const input of [
        { text: "Synthetic complete document" },
        { text: "Synthetic complete document", outputKind: undefined },
      ]) {
        expect(validate(input)).toEqual({ ok: true, value: { text: input.text } });
      }
      const skill = { text: "Synthetic complete document", outputKind: "markdown-skill" };
      expect(validate(skill)).toEqual({ ok: true, value: skill });
      expect(
        validate({ text: null, outputKind: "invalid-kind", profilePreference: "invalid" }),
      ).toEqual({
        ok: false,
        errors: [
          "request.outputKind must be markdown-skill when set",
          "request.text must be a string",
          "request.profilePreference must be a known profile id when set",
        ],
      });
    });
  }
  it("preserves the opt-in document-to-skill mode", () => {
    expect(
      validatePromptEnhancementWireRequest({
        text: "Complete source",
        outputKind: "markdown-skill",
      }),
    ).toEqual({ ok: true, value: { text: "Complete source", outputKind: "markdown-skill" } });
  });
  it.each([null, "code", 1, {}])("rejects unsupported output modes: %j", (outputKind) => {
    expect(validatePromptEnhancementWireRequest({ text: "Complete source", outputKind }).ok).toBe(
      false,
    );
  });
});

import {
  validatePromptEnhancementWireRequest as publicWireCapture,
  type PromptEnhancementWireRequest as PublicWireRequest,
} from "@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-bff";
import type { PromptEnhancerValidation as PublicPromptValidation } from "@oscharko-dev/keiko-contracts/runtime/prompt-enhancer-validation";

it("retains truthful public raw input and admitted wire key types (#3918)", () => {
  expectTypeOf(publicWireCapture).parameter(0).toEqualTypeOf<unknown>();
  expectTypeOf(publicWireCapture).returns.toEqualTypeOf<
    PublicPromptValidation<PublicWireRequest>
  >();
  expectTypeOf<keyof PublicWireRequest>().toEqualTypeOf<
    | "text"
    | "outputKind"
    | "profilePreference"
    | "missingInformationStrategy"
    | "hasConnectedContext"
    | "attachmentCount"
    | "locale"
    | "modelId"
    | "candidateCount"
  >();
});

it("preserves the public nine-field copy after actual admission (#3918)", () => {
  const input = {
    text: "Synthetic complete document",
    outputKind: "markdown-skill",
    profilePreference: "precise",
    missingInformationStrategy: "clarify",
    hasConnectedContext: true,
    attachmentCount: 2,
    locale: "en-US",
    modelId: "example-chat-model",
    candidateCount: 2,
  };
  const parsed = publicWireCapture(input);
  if (!parsed.ok) throw new TypeError("healthy public wire capture refused");
  expect(parsed.value).toEqual(input);
  expect(parsed.value).not.toBe(input);
  expect(Object.keys(parsed.value)).toEqual([
    "text",
    "outputKind",
    "profilePreference",
    "missingInformationStrategy",
    "hasConnectedContext",
    "attachmentCount",
    "locale",
    "modelId",
    "candidateCount",
  ]);
});

const PROMPT_WIRE_PHASE_TRACE = [
  "output",
  "output",
  "text",
  "text",
  "text",
  "profile",
  "profile",
  "strategy",
  "strategy",
  "connected",
  "connected",
  "attachment",
  "attachment",
  "locale",
  "locale",
  "model",
  "model",
  "model",
  "candidate",
  "text",
  "output",
  "output",
  "profile",
  "profile",
  "strategy",
  "strategy",
  "connected",
  "connected",
  "attachment",
  "attachment",
  "locale",
  "locale",
  "model",
  "model",
  "candidate",
  "candidate",
];

function tracedWireRequest(trace: string[]): Record<string, unknown> {
  const input = {
    get text(): string {
      trace.push("text");
      return "Synthetic complete document";
    },
    get outputKind(): string {
      trace.push("output");
      return "markdown-skill";
    },
    get profilePreference(): string {
      trace.push("profile");
      return "precise";
    },
    get missingInformationStrategy(): string {
      trace.push("strategy");
      return "clarify";
    },
    get hasConnectedContext(): boolean {
      trace.push("connected");
      return true;
    },
    get attachmentCount(): number {
      trace.push("attachment");
      return 2;
    },
    get modelId(): string {
      trace.push("model");
      return "example-chat-model";
    },
    get candidateCount(): number {
      trace.push("candidate");
      return 2;
    },
  };
  Object.setPrototypeOf(input, {
    get locale(): string {
      trace.push("locale");
      return "en-US";
    },
  });
  return input;
}

describe("wire capture intent context and model observations (#3918)", (): void => {
  for (const surface of ["source", "public"] as const) {
    const validate =
      surface === "source" ? validatePromptEnhancementWireRequest : publicWireCapture;

    it(`${surface}: preserves complete phase order and inherited context capture`, (): void => {
      const trace: string[] = [];
      const input = tracedWireRequest(trace);
      const result = validate(input);
      expect(result.ok).toBe(true);
      expect(trace).toEqual(PROMPT_WIRE_PHASE_TRACE);
      if (result.ok) {
        expect(result.value.locale).toBe("en-US");
        expect(Object.keys(result.value)).toEqual([
          "text",
          "outputKind",
          "profilePreference",
          "missingInformationStrategy",
          "hasConnectedContext",
          "attachmentCount",
          "locale",
          "modelId",
          "candidateCount",
        ]);
        expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
        expect(result.value).not.toBe(input);
      }
      expect(Object.hasOwn(input, "locale")).toBe(false);
    });

    it(`${surface}: eagerly refuses later context and model copy values in order`, (): void => {
      let connected = 0;
      let attachment = 0;
      let locale = 0;
      let model = 0;
      let candidate = 0;
      const input = {
        text: "Synthetic complete document",
        get hasConnectedContext(): unknown {
          return ++connected === 4 ? undefined : true;
        },
        get attachmentCount(): number {
          return ++attachment === 4 ? -1 : 2;
        },
        get locale(): unknown {
          return ++locale === 4 ? undefined : "en-US";
        },
        get modelId(): string {
          return ++model === 5 ? "" : "example-chat-model";
        },
        get candidateCount(): number {
          return ++candidate === 3 ? 0 : 2;
        },
      };
      expect(validate(input)).toEqual({
        ok: false,
        errors: [
          "request.hasConnectedContext must be a boolean when set",
          "request.attachmentCount must be a non-negative integer when set",
          "request.locale must be safe text of at most 35 characters when set",
          "request.modelId must be non-empty safe text of at most 200 characters when set",
          "request.candidateCount must be an integer in [1, 7] when set",
        ],
      });
      expect([connected, attachment, locale, model, candidate]).toEqual([4, 4, 4, 5, 3]);
    });

    it(`${surface}: observes context mutation before capturing model options`, (): void => {
      let locale = 0;
      let model = 0;
      let selectedModel = "earlier-model";
      const input = {
        text: "Synthetic complete document",
        get locale(): string {
          if (++locale === 4) selectedModel = "later-model";
          return "en-US";
        },
        get modelId(): string {
          model += 1;
          return selectedModel;
        },
      };
      expect(validate(input)).toEqual({
        ok: true,
        value: {
          text: "Synthetic complete document",
          locale: "en-US",
          modelId: "later-model",
        },
      });
      expect([locale, model]).toEqual([4, 5]);
    });

    it(`${surface}: preserves opaque capture failure and stops before model reads`, (): void => {
      const sentinel: Error = Object.freeze(new TypeError("synthetic capture failure"));
      const trace: string[] = [];
      let locale = 0;
      const input = {
        text: "Synthetic complete document",
        get locale(): string {
          trace.push("locale");
          if (++locale === 4) throw sentinel;
          return "en-US";
        },
        get modelId(): string {
          trace.push("model");
          return "example-chat-model";
        },
        get candidateCount(): number {
          trace.push("candidate");
          return 2;
        },
      };
      let caught: unknown;
      try {
        validate(input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
      expect(trace).toEqual([
        "locale",
        "locale",
        "model",
        "model",
        "model",
        "candidate",
        "locale",
        "locale",
      ]);
    });
  }
});
