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

    expect(elapsed).toBeLessThan(2000);
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

    expect(elapsed).toBeLessThan(2000);
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

    expect(elapsed).toBeLessThan(2000);
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

  it("strips markdown links whose URL is longer than 2000 chars (KEIKO-0473)", () => {
    const longUrl = `https://example.invalid/doc?token=${"a".repeat(2200)}`;
    const spoken = toSpeakableText(`See [the source document](${longUrl}) for details.`);
    expect(spoken).toBe("See the source document for details.");
    expect(spoken).not.toContain("[");
    expect(spoken).not.toContain("]");
    expect(spoken).not.toContain("(");
    expect(spoken).not.toContain("token=");
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

  it("strips citation markers with an arbitrarily long digit run -- never leaves the marker unstripped (#2906 round 3)", () => {
    // Regression test: the module's own contract is that citation syntax must never reach TTS,
    // regardless of length. An earlier fix bounded the digit run to `\d{1,100}` for S8786
    // (quadratic-regex) compliance, which "solved" the backtracking but silently stopped
    // RECOGNIZING -- and thus stopped stripping -- any marker whose number exceeded 100 digits,
    // blessing a 101+ character marker being spoken aloud verbatim. The replacement is a linear
    // scanner (stripCitationMarkers), not a bounded quantifier, so it strips a marker far past the
    // old bound while staying fast (still no `[`/`]` in the output, still well under the S8786
    // budget this file's other tests probe).
    const huge = "1".repeat(50_000);
    const start = Date.now();
    const spoken = toSpeakableText(`The answer is here [${huge}] and that's it.`);
    const elapsed = Date.now() - start;

    expect(spoken).toBe("The answer is here and that's it.");
    expect(spoken).not.toContain("[");
    expect(spoken).not.toContain("]");
    expect(elapsed).toBeLessThan(2000);
  });

  it("strips citation markers with an arbitrarily long letter-label prefix -- never leaves the marker unstripped (#2906 round 3)", () => {
    const huge = "A".repeat(50_000);
    const start = Date.now();
    const spoken = toSpeakableText(`The answer is here [${huge}-1] and that's it.`);
    const elapsed = Date.now() - start;

    expect(spoken).toBe("The answer is here and that's it.");
    expect(spoken).not.toContain("[");
    expect(spoken).not.toContain("]");
    expect(elapsed).toBeLessThan(2000);
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

    expect(elapsed).toBeLessThan(2000);
    expect(result).toBe(adversarial);
  });

  it("still strips whitespace immediately before punctuation (behaviour equivalence)", () => {
    expect(stripSpaceBeforePunctuation("word ,")).toBe("word,");
    expect(stripSpaceBeforePunctuation("word .")).toBe("word.");
    expect(stripSpaceBeforePunctuation("word   !")).toBe("word!");
    expect(stripSpaceBeforePunctuation("no space here")).toBe("no space here");
  });
});
