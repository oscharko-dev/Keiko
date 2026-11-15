import { describe, expect, it } from "vitest";
import { MARKDOWN_SKILL_REFUSAL_REASONS } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ApiError } from "./api";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "./i18n-messages.optional.de";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "./i18n-messages.optional.en";
import { carryMarkdownSkillRefusal, markdownSkillRefusalOf } from "./markdown-skill-refusal";

function failure(envelope: { error: Record<string, unknown> } | undefined): Error {
  const error = new Error("HTTP 400");
  carryMarkdownSkillRefusal(error as ApiError, envelope as never);
  return error;
}

describe("the refusal a skill save carries (F31)", () => {
  it("reads the closed reason and the line off the error envelope", () => {
    const error = failure({
      error: { code: "INVALID_REQUEST", message: "x", reason: "template-unknown-key", line: 7 },
    });
    expect(markdownSkillRefusalOf(error)).toEqual({ reason: "template-unknown-key", line: 7 });
  });

  it("keeps a refusal without a line", () => {
    const error = failure({
      error: { code: "INVALID_REQUEST", message: "x", reason: "text-empty" },
    });
    expect(markdownSkillRefusalOf(error)).toEqual({ reason: "text-empty" });
  });

  it.each([
    ["a conflict without a reason", { error: { code: "CONFLICT", message: "x" } }],
    [
      "a reason this build does not know",
      { error: { code: "X", message: "x", reason: "new-one" } },
    ],
    ["a body that is not the envelope", undefined],
  ])("leaves the generic failure for %s", (_name, envelope) => {
    expect(markdownSkillRefusalOf(failure(envelope))).toBeUndefined();
  });

  it("ignores a line that is not a positive whole number", () => {
    const error = failure({
      error: { code: "X", message: "x", reason: "template-malformed-line", line: -3 },
    });
    expect(markdownSkillRefusalOf(error)).toEqual({ reason: "template-malformed-line" });
  });

  // A reason without a sentence would leave the person with the generic banner again.
  it.each(MARKDOWN_SKILL_REFUSAL_REASONS)(
    "has a sentence in English and German for %s",
    (reason) => {
      const key = `chat.skills.refusal.${reason}` as keyof typeof OPTIONAL_WIDGET_EN_MESSAGES;
      expect(OPTIONAL_WIDGET_EN_MESSAGES[key].length).toBeGreaterThan(20);
      expect(OPTIONAL_WIDGET_DE_MESSAGES[key].length).toBeGreaterThan(20);
      for (const text of [OPTIONAL_WIDGET_EN_MESSAGES[key], OPTIONAL_WIDGET_DE_MESSAGES[key]]) {
        // Words a clerk does not know: the rule id, the wire code and the file format's jargon.
        expect(text).not.toMatch(
          /template-|INVALID_REQUEST|front.?matter|Vorlagen-Kopf|Schlüssel/iu,
        );
      }
    },
  );
});
