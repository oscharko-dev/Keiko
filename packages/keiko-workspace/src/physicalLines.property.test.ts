import { describe, expect, it } from "vitest";
import {
  arrayOf,
  checkProperty,
  propertySettings,
  shrinkArray,
  type Generator,
} from "../../../tests/support/property-testing.js";
import { codingRepositoryExcerpt } from "./codingRepositorySearchProjection.js";
import {
  normalizePhysicalLineBreaks,
  physicalLineSpans,
  splitPhysicalLines,
} from "./physicalLines.js";
import { buildWorkspaceIndexLexicalRecord } from "./workspaceIndex.js";

/**
 * #4439: a file with Windows or mixed line endings must yield the same excerpts, ranges and index
 * lines as its LF equivalent. Generated lines mix identifiers, blanks and interior lone "\r"
 * characters (never a line-final one, which would itself spell a CRLF terminator); each line picks
 * its own "\n" or "\r\n" terminator, and the final line may or may not be terminated.
 */

const WORDS = ["alpha", "Beta", "gamma_delta", "fn(", ")", "{", "}", "", " ", "\t", "x1", "\r"];

interface Document {
  readonly lines: readonly string[];
  readonly terminators: readonly ("\n" | "\r\n")[];
  readonly trailing: boolean;
}

const lineOf: Generator<string> = (random) => {
  const words = Array.from({ length: random.integer(0, 5) }, () => random.pick(WORDS));
  const line = words.join(random.pick([" ", ""]));
  return line.endsWith("\r") ? `${line}z` : line;
};

const documentOf: Generator<Document> = (random) => {
  const lines = arrayOf(lineOf, 1, 12)(random);
  return {
    lines,
    terminators: lines.map(() => random.pick(["\n", "\r\n"] as const)),
    trailing: random.chance(0.3),
  };
};

function joined(document: Document, lf: boolean): string {
  return document.lines
    .map((line, index) => {
      const last = index === document.lines.length - 1;
      if (last && !document.trailing) return line;
      return line + (lf ? "\n" : (document.terminators[index] ?? "\n"));
    })
    .join("");
}

function* shrinkDocument(document: Document): Iterable<Document> {
  for (const lines of shrinkArray(document.lines)) {
    if (lines.length === 0) continue;
    yield { ...document, lines, terminators: document.terminators.slice(0, lines.length) };
  }
}

describe("physical line contract properties (#4439)", () => {
  const name = "mixed line endings project exactly like their LF equivalent";
  it(name, async () => {
    let crlfCases = 0;
    await checkProperty({
      name,
      generate: documentOf,
      shrink: shrinkDocument,
      property: (document) => {
        const mixed = joined(document, false);
        const lf = joined(document, true);
        if (mixed.includes("\r\n")) crlfCases += 1;
        expect(splitPhysicalLines(mixed)).toEqual(lf.split("\n"));
        expect(normalizePhysicalLineBreaks(mixed)).toBe(lf);
        const spans = physicalLineSpans(mixed);
        expect(spans.map((span) => mixed.slice(span.start, span.end))).toEqual(lf.split("\n"));
        const lineCount = spans.length;
        for (let start = 1; start <= lineCount; start += 1) {
          const end = Math.min(lineCount + 1, start + 2);
          expect(codingRepositoryExcerpt("a.ts", mixed, start, end, 4096)).toEqual(
            codingRepositoryExcerpt("a.ts", lf, start, end, 4096),
          );
        }
        expect(buildWorkspaceIndexLexicalRecord(mixed, "a.ts")).toEqual(
          buildWorkspaceIndexLexicalRecord(lf, "a.ts"),
        );
      },
    });
    // Vacuity guard: most generated documents must actually carry a CRLF terminator.
    expect(crlfCases).toBeGreaterThan(propertySettings({ name }).runs / 2);
  });
});
