import { describe, expect, it } from "vitest";
import {
  arrayOf,
  checkProperty,
  oneOf,
  propertySettings,
  shrinkArray,
  shrinkString,
  unicodeString,
  type Generator,
} from "../../../tests/support/property-testing.js";
import {
  initialBraceScanState,
  scanBraceCharacter,
  scanBraceLine,
  type BraceLineScan,
  type BraceScanState,
} from "./repoSearchLineSelection.js";

/**
 * #4457: the brace scan jumps to the next character its current state does not ignore. It must
 * reproduce the character-by-character scan exactly, line after line, including the state it hands
 * to the next line: quotes, escapes, doubled quotes, template literals across lines, block comments,
 * line comments, regex literals with character classes, control-paren regex permission and JSX.
 */

// Fragments that move the scanner between states, plus ordinary code and edge characters.
const FRAGMENTS: readonly string[] = [
  "{",
  "}",
  "(",
  ")",
  '"',
  "'",
  "`",
  "\\",
  "/",
  "//",
  "/*",
  "*/",
  "**/",
  "${",
  "[",
  "]",
  "'it''s'",
  '"a\\"b"',
  "x = /a[/]b/g;",
  "if (ok) /re/.test(s)",
  "if (a)",
  "while (b) ",
  "for (;;)",
  "x",
  "return /x{2}/",
  "typeof /y/",
  "a / b / c",
  "</div>",
  "<a.b-c >",
  "const f = () => {",
  "function name(a, b) {",
  "  ",
  "\t",
  " ",
  "　",
  "\u{10400}",
  "\ud800",
  "word",
  ";",
];

const fragment: Generator<string> = oneOf<string>(
  (random) => random.pick(FRAGMENTS),
  (random) => random.pick(FRAGMENTS),
  unicodeString(4),
);
const line: Generator<string> = (random) => arrayOf(fragment, 0, 10)(random).join("");
const lines: Generator<string[]> = arrayOf(line, 1, 8);

function scanByCharacter(text: string, state: BraceScanState): BraceLineScan {
  let delta = 0;
  let sawOpen = false;
  for (let index = 0; index < text.length; index += 1) {
    const scanned = scanBraceCharacter(text, index, state);
    delta += scanned.delta;
    sawOpen = sawOpen || scanned.sawOpen;
    if (scanned.stop) break;
    if (scanned.advance) index += 1;
  }
  if (state.quote !== "`") state.escaped = false;
  state.regexCharacterClass = false;
  state.regexLiteral = false;
  return { delta, sawOpen };
}

function scanAll(
  source: readonly string[],
  scan: (text: string, state: BraceScanState) => BraceLineScan,
): { readonly scans: readonly BraceLineScan[]; readonly state: BraceScanState } {
  const state = initialBraceScanState();
  return { scans: source.map((text) => scan(text, state)), state };
}

function* shrinkLines(value: string[]): Iterable<string[]> {
  yield* shrinkArray(value, shrinkString);
}

describe("brace line scan", () => {
  it("matches the character-by-character scan across consecutive lines", async () => {
    const name = "skipping brace scan equals character scan";
    const { runs } = propertySettings({ name, runs: 3_000 });
    let braces = 0;
    let carriedStates = 0;
    await checkProperty<string[]>({
      name,
      runs: 3_000,
      generate: lines,
      shrink: shrinkLines,
      property: (source) => {
        const expected = scanAll(source, scanByCharacter);
        expect(scanAll(source, scanBraceLine)).toEqual(expected);
        if (expected.scans.some((scan) => scan.sawOpen || scan.delta !== 0)) braces += 1;
        const carried = expected.state;
        if (carried.blockComment || carried.quote !== undefined) carriedStates += 1;
      },
    });
    // Vacuity: braces must be counted, and quote or comment state must reach a following line.
    expect(braces).toBeGreaterThan(runs / 4);
    expect(carriedStates).toBeGreaterThan(runs / 10);
  });
});
