import { describe, expect, it } from "vitest";
import { toSpeakableText } from "./voice-speech-text.js";

describe("toSpeakableText", () => {
  it("keeps link labels while removing URLs, citation markers, and source sections", () => {
    const markdown = [
      "## Ergebnis",
      "",
      "Die Einstellung steht in [der Betriebsanleitung](https://example.invalid/runbook?token=secret) [1].",
      "",
      "### Quellen",
      "- [1] [Runbook](https://example.invalid/runbook)",
    ].join("\n");

    const spoken = toSpeakableText(markdown);

    expect(spoken).toBe("Ergebnis. Die Einstellung steht in der Betriebsanleitung.");
    expect(spoken).not.toContain("https");
    expect(spoken).not.toContain("[1]");
    expect(spoken).not.toContain("Runbook");
  });

  it("omits fenced code while retaining short inline identifiers", () => {
    const markdown = [
      "Nutze `npm test`.",
      "",
      "```ts",
      "const secret = 'must-not-be-spoken';",
      "```",
      "",
      "Danach weiter.",
    ].join("\n");

    expect(toSpeakableText(markdown)).toBe("Nutze npm test. Danach weiter.");
  });

  it("removes bare and autolink URLs without leaving broken punctuation", () => {
    expect(
      toSpeakableText(
        "Details: https://example.invalid/a/b?x=1. Bitte <https://example.invalid> im Chat öffnen.",
      ),
    ).toBe("Details: Bitte im Chat öffnen.");
  });

  it("removes complete and unterminated HTML without leaving injection delimiters", () => {
    const markdown = [
      "Hallo <strong>Kollege</strong>.",
      "<script>alert('must-not-be-spoken')</script\t odd-attribute> Danach weiter.",
      "Sicher. <script data-value='unterminated'",
    ].join("\n");

    const spoken = toSpeakableText(markdown);

    expect(spoken).toBe("Hallo Kollege. Danach weiter. Sicher.");
    expect(spoken).not.toMatch(/[<>]/u);
    expect(spoken).not.toContain("must-not-be-spoken");
    expect(spoken).not.toContain("unterminated");
  });

  it("returns an empty string when the input contains no speakable content", () => {
    expect(toSpeakableText("### Sources\n- <https://example.invalid>")).toBe("");
  });
});
