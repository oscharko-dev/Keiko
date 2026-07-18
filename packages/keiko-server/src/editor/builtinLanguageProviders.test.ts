import { describe, expect, it } from "vitest";
import { stripTrailingSpacesAndTabsPerLine } from "./builtinLanguageProviders.js";

describe("stripTrailingSpacesAndTabsPerLine", () => {
  it("strips trailing spaces and tabs from each line", () => {
    const input = "line one   \nline two\t\t\nline three";
    expect(stripTrailingSpacesAndTabsPerLine(input)).toBe("line one\nline two\nline three");
  });

  it("leaves lines with no trailing whitespace unchanged", () => {
    const input = "a\nb\nc";
    expect(stripTrailingSpacesAndTabsPerLine(input)).toBe("a\nb\nc");
  });

  it("preserves internal whitespace, stripping only the trailing run", () => {
    const input = "foo   bar   ";
    expect(stripTrailingSpacesAndTabsPerLine(input)).toBe("foo   bar");
  });

  it("strips trailing spaces before a CRLF line ending, matching /[ \\t]+$/gmu", () => {
    // A JS regex `$` under the `m` flag matches immediately before a lone "\r" too (it is its
    // own LineTerminator code point), so the original `/[ \t]+$/gmu` strips the space here:
    //   "text \r\nnext".replace(/[ \t]+$/gmu, "") === "text\r\nnext"
    // A naive `split("\n")` scan leaves the "\r" glued to the end of the line and never
    // recognizes the space before it as trailing whitespace -- this must not regress.
    const input = "text \r\nnext";
    expect(stripTrailingSpacesAndTabsPerLine(input)).toBe("text\r\nnext");
  });

  it("strips trailing spaces before a lone CR (no following LF)", () => {
    const input = "text \rnext";
    expect(stripTrailingSpacesAndTabsPerLine(input)).toBe("text\rnext");
  });

  it("strips trailing spaces before each terminator in consecutive CRLF lines", () => {
    const input = "a  \r\nb  \r\nc  ";
    expect(stripTrailingSpacesAndTabsPerLine(input)).toBe("a\r\nb\r\nc");
  });

  it("handles empty lines and an empty string", () => {
    expect(stripTrailingSpacesAndTabsPerLine("")).toBe("");
    expect(stripTrailingSpacesAndTabsPerLine("\n\n")).toBe("\n\n");
  });

  // Regression for S8786: the old `/[ \t]+$/gmu` pattern has no `^` anchor, so a single "line"
  // (no `\n` at all — e.g. minified CSS/YAML content) consisting of a long run of space/tab
  // characters that never reaches a real match forces an O(n) backtrack retry at every one of
  // the O(n) positions — quadratic in the line length (measured over a second at 20,000
  // characters in local timing). The per-line scan is linear; this must stay comfortably under
  // budget even at 20,000 characters.
  it("stays well within a tight time budget for one pathologically long non-matching line", () => {
    const adversarialLine = " \t".repeat(10_000) + "X"; // 20,000 ws chars, then a non-ws char
    const start = Date.now();
    const result = stripTrailingSpacesAndTabsPerLine(adversarialLine);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1500);
    expect(result).toBe(adversarialLine);
  });
});
