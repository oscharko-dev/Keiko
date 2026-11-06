import { describe, expect, it } from "vitest";

import {
  characters,
  checkProperty,
  shrinkString,
  type SeededRandom,
} from "../../../tests/support/seeded-property.js";
import type { PatchChangeKind, PatchFileChange, PatchHunk } from "./tools.js";
import { parseUnifiedDiff, PatchParseError, type UnifiedDiffFileSource } from "./unified-diff.js";

/**
 * #4271: generated patches, rendered the way `git diff` writes them, parse back to exactly the
 * files, hunks and body lines they were made of. Body content deliberately spells what the parser
 * must not mistake for structure: file headers, hunk headers, the signature delimiter, a
 * no-newline marker and carriage returns. Arbitrary text either parses or is refused with a
 * PatchParseError, and every source range the parser publishes names the bytes it describes.
 */

const CONTENT = [
  ...characters("ab z09"),
  "-- ",
  "--- a/x",
  "+++ b/x",
  "@@ -1 +1 @@",
  "\\ No newline",
  "\r",
  "\t",
  "ü",
  "😀",
  '"',
  "\\",
];
const PATH_PARTS = ["src", "a", "b", "dir with space", "Größe", "x.ts", "tab\there", 'q"uote'];
const NO_NEWLINE = "\\ No newline at end of file";

interface GeneratedFile {
  readonly path: string;
  readonly kind: PatchChangeKind;
  readonly hunks: readonly PatchHunk[];
}

function needsQuoting(path: string): boolean {
  return Array.from(path).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code > 0x7e || character === '"' || character === "\\";
  });
}

/** Git's C-style quoting: octal bytes for control and non-ASCII characters, `\"` and `\\`. */
function quotePath(path: string): string {
  if (!needsQuoting(path)) return path;
  const escaped = [...new TextEncoder().encode(path)]
    .map((byte) => {
      if (byte === 0x22) return '\\"';
      if (byte === 0x5c) return "\\\\";
      if (byte < 0x20 || byte > 0x7e) return `\\${byte.toString(8).padStart(3, "0")}`;
      return String.fromCodePoint(byte);
    })
    .join("");
  return `"${escaped}"`;
}

function header(prefix: "a/" | "b/", path: string, absent: boolean): string {
  if (absent) return "/dev/null";
  const quoted = quotePath(`${prefix}${path}`);
  // Git ends a header path holding a space with a tab, so its end is unambiguous.
  return quoted.includes(" ") ? `${quoted}\t` : quoted;
}

function hunkLines(random: SeededRandom, kind: PatchChangeKind): string[] {
  const markers = kind === "create" ? ["+"] : kind === "delete" ? ["-"] : [" ", "+", "-"];
  const lines = random.array(1, 8, () => `${random.pick(markers)}${random.string(CONTENT, 0, 4)}`);
  if (random.boolean(0.2)) lines.push(NO_NEWLINE);
  return lines;
}

function hunk(random: SeededRandom, kind: PatchChangeKind): PatchHunk {
  const lines = hunkLines(random, kind);
  const count = (markers: string): number =>
    lines.filter((line) => markers.includes(line.charAt(0))).length;
  return {
    oldStart: kind === "create" ? 0 : random.integer(1, 500),
    oldLines: count(" -"),
    newStart: kind === "delete" ? 0 : random.integer(1, 500),
    newLines: count(" +"),
    lines,
  };
}

function generatedFile(random: SeededRandom, index: number): GeneratedFile {
  const kind = random.pick<PatchChangeKind>(["create", "modify", "delete"]);
  const path = [...random.array(0, 2, () => random.pick(PATH_PARTS)), `f${String(index)}.txt`].join(
    "/",
  );
  const hunks =
    kind === "modify" ? random.array(1, 3, () => hunk(random, kind)) : [hunk(random, kind)];
  return { path, kind, hunks };
}

function renderCount(start: number, lines: number, random: SeededRandom): string {
  return lines === 1 && random.boolean() ? String(start) : `${String(start)},${String(lines)}`;
}

function render(files: readonly GeneratedFile[], random: SeededRandom): string {
  const out: string[] = [];
  for (const file of files) {
    out.push(`diff --git a/${file.path} b/${file.path}`, "index 0000000..1111111 100644");
    out.push(`--- ${header("a/", file.path, file.kind === "create")}`);
    out.push(`+++ ${header("b/", file.path, file.kind === "delete")}`);
    for (const { oldStart, oldLines, newStart, newLines, lines } of file.hunks) {
      const old = renderCount(oldStart, oldLines, random);
      out.push(`@@ -${old} +${renderCount(newStart, newLines, random)} @@ fn()`, ...lines);
    }
  }
  return `${out.join("\n")}\n`;
}

function expected(file: GeneratedFile): PatchFileChange {
  const body = file.hunks.flatMap((entry) => entry.lines);
  return {
    path: file.path,
    kind: file.kind,
    hunks: file.hunks,
    addedLines: body.filter((line) => line.startsWith("+")).length,
    removedLines: body.filter((line) => line.startsWith("-")).length,
  };
}

function patch(random: SeededRandom): { readonly files: GeneratedFile[]; readonly text: string } {
  const files = random.array(1, 4, () => undefined).map((_, index) => generatedFile(random, index));
  return { files, text: render(files, random) };
}

function expectRangesName(diff: string, sources: readonly UnifiedDiffFileSource[]): void {
  for (const source of sources) {
    expect(diff.slice(source.oldHeader.start, source.oldHeader.end)).toMatch(/^--- /u);
    expect(diff.slice(source.newHeader.start, source.newHeader.end)).toMatch(/^\+\+\+ /u);
    for (const entry of source.hunks) {
      expect(diff.slice(entry.header.start, entry.header.end)).toMatch(/^@@ /u);
      for (const line of entry.lines) {
        expect(diff.charAt(line.start)).toBe(line.marker);
        expect(line.end).toBeLessThanOrEqual(diff.length);
      }
    }
  }
}

describe("parseUnifiedDiff on generated patches", () => {
  it("parses a rendered patch back to exactly its files, hunks and body lines", () => {
    checkProperty(
      patch,
      ({ files, text }) => {
        expect(parseUnifiedDiff(text).files).toEqual(files.map((file) => expected(file)));
      },
      { runs: 400 },
    );
  });

  it("publishes source ranges that name the headers and body lines they describe", () => {
    checkProperty(
      patch,
      ({ files, text }) => {
        let sources: readonly UnifiedDiffFileSource[] = [];
        parseUnifiedDiff(text, (observed) => {
          sources = observed;
        });
        expect(sources).toHaveLength(files.length);
        expectRangesName(text, sources);
      },
      { runs: 200 },
    );
  });

  it("parses arbitrary text or refuses it with a PatchParseError, and nothing else", () => {
    const pieces = [...CONTENT, "\n", "--- a/f", "+++ b/f", "@@ -1,2 +1 @@", " ", "+", "-", "@@"];
    checkProperty(
      (random) => random.string(pieces, 0, 40),
      (text) => {
        try {
          parseUnifiedDiff(text, () => undefined);
        } catch (error) {
          expect(error).toBeInstanceOf(PatchParseError);
        }
      },
      { runs: 2_000, shrink: shrinkString },
    );
  });
});
