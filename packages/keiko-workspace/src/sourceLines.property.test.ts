// Properties of the shared source-line rule (#4439), drawn from seeded generators.
//
// A file saved with Windows line endings must read exactly like its LF copy: the same lines, the
// same Coding excerpt and line range, the same index record. The generator builds one document
// from lines and gives every terminator independently LF or CRLF, so mixed endings are covered.
// A failure prints the seed and a shrunk counterexample; see `tests/support/property-testing.ts`.

import { describe, expect, it } from "vitest";

import {
  arrayOf,
  checkProperty,
  propertySettings,
  shrinkArray,
  type Generator,
} from "../../../tests/support/property-testing.js";

import { codingRepositoryExcerpt } from "./codingRepositorySearchProjection.js";
import { normalizeSourceLineEndings, splitSourceLines } from "./sourceLines.js";
import { buildWorkspaceIndexLexicalRecord } from "./workspaceIndex.js";

interface SourceCase {
  readonly lines: readonly string[];
  readonly crlf: readonly boolean[];
  readonly startLine: number;
  readonly endLine: number;
  readonly maxBytes: number;
}

const TOKENS = [
  "const",
  "value",
  "=",
  "{",
  "}",
  "return",
  "handler()",
  ";",
  " ",
  "\t",
  "\r",
  "// note",
  "ü",
  "export function search",
] as const;

const lineGenerator: Generator<string> = (random) => {
  const line = arrayOf((r) => r.pick(TOKENS), 0, 6)(random).join("");
  // A line ending in a lone CR is indistinguishable from a CRLF terminator in the LF copy.
  return line.endsWith("\r") ? `${line}x` : line;
};

const caseGenerator: Generator<SourceCase> = (random) => {
  const lines = arrayOf(lineGenerator, 1, 12)(random);
  const crlf = lines.map(() => random.chance(0.6));
  const startLine = random.integer(1, lines.length);
  return {
    lines,
    crlf,
    startLine,
    endLine: random.integer(startLine, lines.length + 2),
    maxBytes: random.integer(8, 512),
  };
};

function shrinkCase(value: SourceCase): Iterable<SourceCase> {
  const shrunk: SourceCase[] = [];
  for (const lines of shrinkArray(value.lines)) {
    if (lines.length === 0) continue;
    const startLine = Math.min(value.startLine, lines.length);
    shrunk.push({
      ...value,
      lines,
      crlf: value.crlf.slice(0, lines.length),
      startLine,
      endLine: Math.max(startLine, Math.min(value.endLine, lines.length)),
    });
  }
  return shrunk;
}

function documents(value: SourceCase): { readonly lf: string; readonly crlf: string } {
  const join = (terminator: (index: number) => string): string =>
    value.lines
      .map((line, index) => (index < value.lines.length - 1 ? line + terminator(index) : line))
      .join("");
  return {
    lf: join(() => "\n"),
    crlf: join((index) => (value.crlf[index] === true ? "\r\n" : "\n")),
  };
}

describe("source line endings (#4439)", () => {
  it("splits a CRLF copy into exactly the lines of its LF copy", async () => {
    const name = "source-lines:crlf-split-parity";
    let mixed = 0;
    await checkProperty({
      name,
      generate: caseGenerator,
      shrink: shrinkCase,
      property: (value) => {
        const { lf, crlf } = documents(value);
        if (lf !== crlf) mixed += 1;
        expect(splitSourceLines(crlf)).toEqual(value.lines);
        expect(splitSourceLines(normalizeSourceLineEndings(crlf))).toEqual(value.lines);
        expect(normalizeSourceLineEndings(crlf)).toBe(lf);
      },
    });
    expect(mixed).toBeGreaterThan(propertySettings({ name }).runs / 2);
  });

  it("projects the same Coding excerpt and range for a CRLF copy", async () => {
    const name = "source-lines:coding-excerpt-parity";
    // Each case runs the canonical redactor twice (about 20 ms); KEIKO_PROPERTY_RUNS widens it.
    const runs = 40;
    let compared = 0;
    await checkProperty({
      name,
      runs,
      generate: caseGenerator,
      shrink: shrinkCase,
      property: (value) => {
        const { lf, crlf } = documents(value);
        if (lf === crlf) return;
        compared += 1;
        const fromLf = codingRepositoryExcerpt(
          "src/a.ts",
          lf,
          value.startLine,
          value.endLine,
          value.maxBytes,
        );
        const fromCrlf = codingRepositoryExcerpt(
          "src/a.ts",
          crlf,
          value.startLine,
          value.endLine,
          value.maxBytes,
        );
        expect(fromCrlf).toEqual(fromLf);
        expect(fromCrlf.snippet).not.toContain("\r\n");
      },
    });
    expect(compared).toBeGreaterThan(propertySettings({ name, runs }).runs / 2);
  });

  it("builds the same lexical index record for a CRLF copy", async () => {
    const name = "source-lines:index-record-parity";
    let compared = 0;
    await checkProperty({
      name,
      generate: caseGenerator,
      shrink: shrinkCase,
      property: (value) => {
        const { lf, crlf } = documents(value);
        if (lf === crlf) return;
        compared += 1;
        expect(buildWorkspaceIndexLexicalRecord(crlf, "src/a.ts")).toEqual(
          buildWorkspaceIndexLexicalRecord(lf, "src/a.ts"),
        );
      },
    });
    expect(compared).toBeGreaterThan(propertySettings({ name }).runs / 2);
  });
});
