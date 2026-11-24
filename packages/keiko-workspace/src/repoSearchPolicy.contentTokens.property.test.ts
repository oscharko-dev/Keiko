import { describe, expect, it } from "vitest";
import {
  checkProperty,
  oneOf,
  propertySettings,
  shrinkString,
  textOf,
  unicodeString,
  type Generator,
  type Random,
} from "../../../tests/support/property-testing.js";
import { contentTokenLookup, contentTokenSet } from "./repoSearchPolicy.js";

/**
 * #4457: content scoring asks whether a few query terms are tokens of a candidate file. The lookup
 * answers that in place, and must agree with the token set it replaced on every text: word runs,
 * camel-case parts, digits, `_` and `$`, astral letters, combining marks, and the two lowercase
 * mappings (U+0130 and the final sigma) that break the alignment of a text with its lowercase.
 */

interface TokenCase {
  readonly text: string;
  readonly term: string;
  readonly caseSensitive: boolean;
}

const WORDS: readonly string[] = [
  "workspace",
  "Index",
  "workspaceIndexStore",
  "HTTPServer",
  "parseURL2Json",
  "snake_case",
  "$scope",
  "Größe",
  "ÄÖÜ",
  "straße",
  "ΣΙΣΥΦΟΣ",
  "σοφός",
  "İstanbul",
  "\u{10400}\u{10428}",
  "x9Y",
  "a1B2c3",
  "été",
  "README",
];

const word: Generator<string> = oneOf<string>(
  (random) => random.pick(WORDS),
  (random) => `${random.pick(WORDS)}${random.pick(WORDS)}`,
  unicodeString(6),
);
const text: Generator<string> = textOf(word, 0, 12);

function folded(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

// Terms come from the token set itself (positives), from arbitrary slices of the folded text
// (prefixes, suffixes and spans across part and run boundaries), and from unrelated words.
function termFor(random: Random, source: string, cs: boolean): string {
  const haystack = folded(source, cs);
  const tokens = [...contentTokenSet(source, cs)];
  if (tokens.length > 0 && random.chance(0.4)) return random.pick(tokens);
  if (haystack.length > 0 && random.chance(0.7)) {
    const start = random.integer(0, haystack.length - 1);
    return haystack.slice(start, start + random.integer(1, 12));
  }
  return folded(random.pick(WORDS), cs);
}

const tokenCase: Generator<TokenCase> = (random) => {
  const source = text(random);
  const caseSensitive = random.chance(0.3);
  return { text: source, term: termFor(random, source, caseSensitive), caseSensitive };
};

function* shrinkTokenCase(value: TokenCase): Iterable<TokenCase> {
  for (const shorter of shrinkString(value.text)) yield { ...value, text: shorter };
  for (const shorter of shrinkString(value.term)) yield { ...value, term: shorter };
}

describe("content token lookup", () => {
  it("answers exactly what the content token set contains", async () => {
    const name = "content token lookup agrees with contentTokenSet";
    const { runs } = propertySettings({ name, runs: 2_000 });
    let members = 0;
    let alignedMisses = 0;
    await checkProperty<TokenCase>({
      name,
      runs: 2_000,
      generate: tokenCase,
      shrink: shrinkTokenCase,
      property: ({ text: source, term, caseSensitive }) => {
        const expected = contentTokenSet(source, caseSensitive).has(term);
        const lookup = contentTokenLookup(source, folded(source, caseSensitive), caseSensitive);
        expect(lookup.has(term)).toBe(expected);
        if (expected) members += 1;
        else if (!/[İΣ]/u.test(source) && folded(source, caseSensitive).includes(term))
          alignedMisses += 1;
      },
    });
    // Vacuity: both answers must occur often, including terms present in the text but not tokens.
    expect(members).toBeGreaterThan(runs / 5);
    expect(alignedMisses).toBeGreaterThan(runs / 10);
  });

  it.each([
    ["workspaceIndexStore", "index", true],
    ["workspaceIndexStore", "workspaceindexstore", true],
    ["workspaceIndexStore", "indexstore", false],
    ["HTTPServer", "server", false],
    ["HTTPServer", "httpserver", true],
    ["parseURL2Json", "json", true],
    ["parseURL2Json", "url2", true],
    ["a.b", "a.b", false],
    ["İndex", "i̇ndex", true],
    ["ΣΟΦΟΣ", "σοφος", true],
  ] as const)("in %s, %s is a token: %s", (source, term, expected) => {
    expect(contentTokenSet(source, false).has(term)).toBe(expected);
    expect(contentTokenLookup(source, source.toLowerCase(), false).has(term)).toBe(expected);
  });
});
