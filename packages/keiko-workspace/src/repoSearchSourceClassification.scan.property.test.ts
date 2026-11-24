import { describe, expect, it } from "vitest";
import {
  arrayOf,
  checkProperty,
  oneOf,
  propertySettings,
  shrinkRecord,
  shrinkString,
  unicodeString,
  type Generator,
} from "../../../tests/support/property-testing.js";
import {
  repositorySourceLines,
  repositorySourceLinesByCharacter,
} from "./repoSearchSourceClassification.js";

/**
 * #4457: the source scan steps over characters at which no mask can start while no mask is
 * active, and builds each view from masked runs. It must reproduce the character-by-character scan
 * exactly for every syntax, line after line, including the state one line hands to the next:
 * block and nested comments, heredocs, YAML block scalars, Ruby block comments, raw, verbatim,
 * triple-quoted and template strings with expressions, regex literals and Java Unicode escapes.
 */

const PATHS: readonly (string | undefined)[] = [
  undefined,
  "a.ts",
  "a.tsx",
  "a.js",
  "a.py",
  "a.java",
  "a.cs",
  "a.cshtml",
  "a.vue",
  "a.fs",
  "a.rs",
  "a.lua",
  "a.sql",
  "a.sh",
  "a.php",
  "a.rb",
  "a.vb",
  "a.cpp",
  "a.go",
  "a.yaml",
  "a.csproj",
  "Dockerfile",
  "README.md",
];

// Fragments that open, continue and close every mask the scanner knows, plus ordinary text.
const FRAGMENTS: readonly string[] = [
  "//",
  "/*",
  "*/",
  "(*",
  "*)",
  "@*",
  "*@",
  "<!--",
  "-->",
  "--",
  "--[[",
  "--[==[",
  "]]",
  "]==]",
  "#",
  "#[",
  "'",
  '"',
  "`",
  "'''",
  '"""',
  '""""',
  '@"',
  '$@"',
  '""',
  'R"x(',
  ')x"',
  'r#"',
  '"#',
  'br"',
  "${",
  "}",
  "{",
  "\\",
  "\\u002f\\u002a",
  "\\u002a\\u002f",
  "\\u002f\\u002f",
  "x = /a[/]b/g;",
  "return /x/",
  "a / b",
  "rem ",
  "REM x",
  "=begin",
  "=end",
  "<<EOF",
  "<<-'END'",
  "<<<TXT",
  "EOF",
  "key: |",
  "- item: >2",
  "  ",
  "\t",
  "word",
  "code",
  "\u{10400}",
  "\ud800",
];

const fragment: Generator<string> = oneOf<string>(
  (random) => random.pick(FRAGMENTS),
  (random) => random.pick(FRAGMENTS),
  unicodeString(4),
);
const line: Generator<string> = (random) => arrayOf(fragment, 0, 8)(random).join("");

interface ScanCase {
  readonly path: string | undefined;
  readonly text: string;
}

const scanCase: Generator<ScanCase> = (random) => ({
  path: random.pick(PATHS),
  text: arrayOf(line, 1, 8)(random).join(random.pick(["\n", "\r\n"])),
});

describe("repository source scan", () => {
  it("matches the character-by-character scan for every syntax", async () => {
    const name = "skipping source scan equals character scan";
    const { runs } = propertySettings({ name, runs: 3_000 });
    let masked = 0;
    let carried = 0;
    await checkProperty<ScanCase>({
      name,
      runs: 3_000,
      generate: scanCase,
      shrink: shrinkRecord<ScanCase>({ text: shrinkString }),
      property: ({ path, text }) => {
        const expected = repositorySourceLinesByCharacter(text, path);
        expect(repositorySourceLines(text, path)).toEqual(expected);
        if (expected.some((source) => source.structural !== source.raw)) masked += 1;
        const last = expected.at(-1);
        if (last !== undefined && last.raw.length > 0 && last.structural.trim().length === 0) {
          carried += 1;
        }
      },
    });
    // Vacuity: masks must be written, and a mask must cover a whole final line often enough to
    // show that state crosses line boundaries.
    expect(masked).toBeGreaterThan(runs / 2);
    expect(carried).toBeGreaterThan(runs / 20);
  });
});
