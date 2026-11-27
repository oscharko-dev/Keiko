import { decodeGitQuotedPath } from "@oscharko-dev/keiko-contracts/runtime/unified-diff";
import { describe, expect, it } from "vitest";
import {
  assertFrequencyFloor,
  checkProperty,
  propertySettings,
  shrinkString,
  type Generator,
} from "../../../tests/support/property-testing.js";
import { redact } from "./redaction.js";

/**
 * Git spells a path that holds a non-ASCII byte, a control character, a double quote or a
 * backslash as a C-quoted string. The patch redactor must keep such a header line readable, because
 * the line is the file's identity, while it still refuses an escaped literal it cannot classify.
 * The expected spelling is built by the encoder below, which mirrors Git's `quote_c_style`, not by
 * the code under test.
 */

const NAME_CHARACTERS: readonly string[] = [
  ...Array.from("abcXYZ019_-.+=,;!@#$%^&()[]{}'`"),
  " ",
  " ",
  "ä",
  "ö",
  "ß",
  "Ü",
  "é",
  "项",
  "目",
  "😀",
  " ",
  "‮",
  "\t",
  "\n",
  '"',
  "\\",
  ":",
];

const CONTROL_ESCAPES = new Map<number, string>([
  [0x07, "\\a"],
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0b, "\\v"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
]);

function needsQuoting(name: string): boolean {
  return [...new TextEncoder().encode(name)].some(
    (byte) => byte < 0x20 || byte === 0x22 || byte === 0x5c || byte >= 0x7f,
  );
}

/** Git's `quote_c_style` with the default `core.quotepath`. */
function gitQuote(name: string): string {
  const body = [...new TextEncoder().encode(name)]
    .map((byte) => {
      if (byte === 0x22) return '\\"';
      if (byte === 0x5c) return "\\\\";
      const control = CONTROL_ESCAPES.get(byte);
      if (control !== undefined) return control;
      if (byte < 0x20 || byte >= 0x7f) return `\\${byte.toString(8).padStart(3, "0")}`;
      return String.fromCharCode(byte);
    })
    .join("");
  return `"${body}"`;
}

function spelled(prefix: "a/" | "b/", name: string): string {
  return needsQuoting(name) ? gitQuote(`${prefix}${name}`) : `${prefix}${name}`;
}

function modifyPatch(name: string): string {
  const old = spelled("a/", name);
  const next = spelled("b/", name);
  const trailer = name.includes(" ") || needsQuoting(name) ? "\t" : "";
  return [
    `diff --git ${old} ${next}`,
    "index a25fe44..1d003d2 100644",
    `--- ${old}${trailer}`,
    `+++ ${next}${trailer}`,
    "@@ -1,2 +1,2 @@",
    " a",
    "-b",
    "+c",
    "",
  ].join("\n");
}

const fileName: Generator<string> = (random) => {
  const segments = Array.from({ length: random.integer(1, 3) }, () => {
    const length = random.integer(1, 6);
    const text = Array.from({ length }, () => random.pick(NAME_CHARACTERS)).join("");
    // A segment that is empty, `.` or `..` is not a file name; a leading dot keeps the rest legal.
    return /^\.*$/u.test(text) ? `x${text}` : text;
  });
  return `${segments.join("/")}.js`;
};

describe("quoted Git paths in a redacted patch", () => {
  it(
    "keeps the header lines of every legitimate file name byte for byte",
    { timeout: 60_000 },
    async () => {
      const settings = propertySettings({
        name: "quoted patch header survives redaction",
        runs: 60,
      });
      let quoted = 0;
      await checkProperty({
        name: "quoted patch header survives redaction",
        generate: fileName,
        runs: 60,
        shrink: shrinkString,
        property: (name: string): void => {
          const patch = modifyPatch(name);
          if (needsQuoting(name)) {
            quoted += 1;
            expect(decodeGitQuotedPath(spelled("b/", name))).toBe(`b/${name}`);
          }
          const redacted = redact(patch);
          expect(redacted.split("\n").slice(0, 4)).toEqual(patch.split("\n").slice(0, 4));
          expect(redacted.endsWith("+c\n")).toBe(true);
        },
      });
      assertFrequencyFloor({
        what: "a file name Git quotes",
        count: quoted,
        runs: settings.runs,
        share: 0.3,
        validatedRuns: 60,
      });
    },
  );
});

describe("a path header Git would not have written stays refused", () => {
  it.each([
    ["a header whose quoted path is malformed", 'diff --git "a/x\\q" "b/x\\q"\n'],
    ["a header whose quote never closes", 'diff --git "a/x\\303 "b/x\n'],
    ["a header whose octal escapes are not UTF-8", 'diff --git "a/\\377" "b/\\377"\n'],
  ])("masks %s", (_label, preamble) => {
    const patch = `${preamble}index a25fe44..1d003d2 100644\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-b\n+c\n`;
    expect(redact(patch)).not.toContain(preamble.trimEnd());
  });
});
