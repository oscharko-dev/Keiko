import { describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE_SERVICE_LIMITS } from "@oscharko-dev/keiko-contracts";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createDeadlineCancellation } from "./languageCancellation.js";
import type { LanguageProviderContext } from "./languageProvider.js";
import {
  formatByLanguage,
  genericFormatting,
  stripTrailingSpacesAndTabsPerLine,
} from "./builtinLanguageProviders.js";

function ctx(languageId: string, overlayText: string): LanguageProviderContext {
  return {
    fs: nodeWorkspaceFs,
    root: "/workspace",
    overlayPath: "/workspace/src/doc",
    overlayText,
    languageId,
    limits: DEFAULT_LANGUAGE_SERVICE_LIMITS,
    cancellation: createDeadlineCancellation({
      deadlineMs: DEFAULT_LANGUAGE_SERVICE_LIMITS.deadlineMs,
      now: () => 0,
    }),
  };
}

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

describe("formatByLanguage", () => {
  it.each(["css", "scss", "less"] as const)(
    "formats %s through the CSS-like brace/statement formatter",
    (languageId) => {
      const result = formatByLanguage(ctx(languageId, "a{color:red;}"), undefined);
      expect(result).toBe("a{\n  color:red;\n}\n");
    },
  );

  it("formats html through the tag-nesting formatter", () => {
    const result = formatByLanguage(ctx("html", "<div><span>hi</span></div>"), undefined);
    expect(result).toBe("<div>\n  <span>hi</span>\n</div>\n");
  });

  it("KEIKO-0712: indents content nested inside an opening tag whose attribute value contains a literal '>'", () => {
    // opensHtmlIndentScope's previous `^<[^/!][^>]*>$` treated any `>` as tag-end, so this line
    // read as "not an opening tag" and the <span> stayed at depth 0. Quote-aware scanning
    // recognizes the `>` inside `"a > b"` as part of the attribute value.
    const result = formatByLanguage(
      ctx("html", '<div *ngIf="a > b"><span>x</span></div>'),
      undefined,
    );
    expect(result).toBe('<div *ngIf="a > b">\n  <span>x</span>\n</div>\n');
  });

  it("KEIKO-0712-r3: does not split inside a quoted attribute value containing a literal '> <'", () => {
    // Round-3 finding: the pre-split `/>\s*</gu` ran over the WHOLE document before any per-line
    // quote-aware scanning existed, so a quoted attribute value containing a literal "> <" (e.g.
    // `data-value="> <"`) matched the regex exactly like a real tag boundary and was split
    // mid-quote -- corrupting the document before opensHtmlIndentScope ever got a chance to run.
    const result = formatByLanguage(
      ctx("html", '<div data-value="> <"><span>x</span></div>'),
      undefined,
    );
    // The quoted "> <" must survive verbatim on the opening tag's own line, and the nested <span>
    // must still be recognized and indented as a child of that (real) opening tag.
    expect(result).toBe('<div data-value="> <">\n  <span>x</span>\n</div>\n');
  });

  it("KEIKO-0712-r3: does not split inside a single-quoted attribute value containing a literal '> <'", () => {
    const result = formatByLanguage(
      ctx("html", "<div data-value='> <'><span>x</span></div>"),
      undefined,
    );
    expect(result).toBe("<div data-value='> <'>\n  <span>x</span>\n</div>\n");
  });

  it("falls back to trailing-whitespace normalization for other builtin text languages", () => {
    const result = formatByLanguage(ctx("markdown", "Title  \nBody\t\n"), undefined);
    expect(result).toBe("Title\nBody\n");
  });
});

describe("genericFormatting", () => {
  it("emits a full-document edit carrying the language-dispatched formatted text", () => {
    const text = "a{color:red;}";
    const result = genericFormatting(ctx("css", text), undefined);

    expect(result.truncated).toBe(false);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]?.newText).toBe("a{\n  color:red;\n}\n");
  });
});
