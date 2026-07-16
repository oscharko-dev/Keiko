import { describe, expect, it } from "vitest";
import { stripSpaceBeforePunctuation, toSpeakableText } from "./voice-speech-text.js";

describe("toSpeakableText", () => {
  it("stays fast on a line with a long run of unclosed markdown-link brackets (S8786)", () => {
    // Regression test for the markdown-link stripper: the previous /\[([^\]\n]+)\]\([^\n)]*\)/gu
    // re-attempted an unbounded scan at every '[' in this run, which measured ~170ms at this size
    // and grows quadratically. The rewritten linear-scan version completes in low single-digit ms.
    const adversarial = "See " + "[".repeat(20000) + " for details.";

    const start = Date.now();
    const result = toSpeakableText(adversarial);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(result).not.toContain("undefined");
  });

  it("stays fast on a long whitespace run preceding an unclosed citation marker (S8786)", () => {
    // Regression test for CITATION_MARKER: the previous /\s*\[(?:\^?\d+|[A-Za-z]+-?\d+)\]/gu
    // re-backtracked the leading \s* at every offset of this whitespace run, which measured
    // ~500ms at this size and grows quadratically. Bounding both quantifiers fixes it.
    const adversarial = "Answer" + " ".repeat(20000) + "[" + "1".repeat(20000) + " tail";

    const start = Date.now();
    const result = toSpeakableText(adversarial);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(result).not.toContain("undefined");
  });

  it("stays fast on a source-heading-shaped line padded with '#' characters (S8786)", () => {
    // Regression test for SOURCE_HEADING. This anchored pattern measured as flat/fast even
    // before the fix (single start position due to ^...$), but is bounded for lint compliance
    // and defensively covered here in case the anchoring is ever weakened.
    const adversarial = "#".repeat(20000) + " " + "a".repeat(20000);

    const start = Date.now();
    const result = toSpeakableText(adversarial);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(result).not.toContain("undefined");
  });

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

  it("suppresses everything after a source heading no matter how long its trailing padding is", () => {
    // Regression test: a bounded `\s{0,20}` on the heading's trailing whitespace/colon/marker
    // tail stops recognizing the heading once the padding exceeds the bound, letting the entire
    // citation appendix leak into speech instead of being suppressed (the one guarantee this
    // module exists to enforce). The padding below (25 spaces) deliberately exceeds a 20-char
    // bound but is realistic model-output noise, not an extreme adversarial size.
    const markdown =
      "Answer text here.\n\nSources:" +
      " ".repeat(25) +
      "\n[1]: https://example.invalid/a\nMore citation text that should never be spoken.";

    const spoken = toSpeakableText(markdown);

    expect(spoken).toBe("Answer text here.");
    expect(spoken).not.toContain("More citation text");
  });

  it("strips citation markers with an unusually long digit run", () => {
    // Regression test: a bounded `\d{1,32}` stops matching (and thus stops stripping) a citation
    // marker whose number exceeds 32 digits, leaving the raw bracketed marker to be spoken aloud.
    const longDigits = "1".repeat(33);

    expect(toSpeakableText(`The answer is here [${longDigits}] and that's it.`)).toBe(
      "The answer is here and that's it.",
    );
  });

  it("strips citation markers with an unusually long letter-label prefix", () => {
    // Regression test: a bounded `[A-Za-z]{1,32}` stops matching (and thus stops stripping) a
    // citation marker whose letter prefix exceeds 32 characters, leaving it to be spoken aloud.
    const longLabel = "A".repeat(33);

    expect(toSpeakableText(`The answer is here [${longLabel}-1] and that's it.`)).toBe(
      "The answer is here and that's it.",
    );
  });
});

describe("stripSpaceBeforePunctuation", () => {
  it("stays fast on a long whitespace run with no trailing punctuation (S8786)", () => {
    // Regression test for the /\s+([,.;:!?])/gu pattern used inside normalizeProse: tried in
    // isolation (bypassing the sibling `\s+` -> " " collapse that protects it in normal use),
    // the previous unbounded `\s+` re-backtracked at every offset of this run, which measured
    // as clearly quadratic (~200ms+ at this size, growing ~4x per doubling). Bounding it fixes
    // the pattern itself, independent of its current caller's protective ordering.
    const adversarial = " ".repeat(20000) + "a";

    const start = Date.now();
    const result = stripSpaceBeforePunctuation(adversarial);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(result).toBe(adversarial);
  });

  it("still strips whitespace immediately before punctuation (behaviour equivalence)", () => {
    expect(stripSpaceBeforePunctuation("word ,")).toBe("word,");
    expect(stripSpaceBeforePunctuation("word .")).toBe("word.");
    expect(stripSpaceBeforePunctuation("word   !")).toBe("word!");
    expect(stripSpaceBeforePunctuation("no space here")).toBe("no space here");
  });
});
