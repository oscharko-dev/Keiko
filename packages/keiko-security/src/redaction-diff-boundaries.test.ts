import { describe, expect, it } from "vitest";
import { createStreamingRedactor, redact } from "./redaction.js";

type BoundaryCase = readonly [
  name: string,
  body: string,
  privateExpected: boolean,
  publicExact: boolean,
];
const value = ["fixture", "diff", "q93"].join("_");
const visible = "PUBLIC_WITNESS";

// Retained independent boundary corpus: fixture inputs predate this repair. Patch construction
// derives physical line counts from the supplied fixture; no redaction expectation is computed.
function patch(
  path: string,
  before: readonly string[],
  after: readonly string[],
  context: readonly string[] = [],
): string {
  return [
    "--- a/" + path,
    "+++ b/" + path,
    `@@ -1,${String(context.length + before.length)} +1,${String(context.length + after.length)} @@`,
    ...context.map((x) => " " + x),
    ...before.map((x) => "-" + x),
    ...after.map((x) => "+" + x),
  ].join("\n");
}
const publicTs = patch(
  "public.ts",
  ["export const half = (n: number): number => n / 3;"],
  ["export const half = (n: number): number => n / 2;"],
);
const cases: readonly BoundaryCase[] = [
  ["public-ts", publicTs, false, true],
  [
    "public-interface",
    patch(
      "public.ts",
      ["interface Input { password: string; }"],
      ["interface Input { password: string; readonly visible: boolean; }"],
    ),
    false,
    true,
  ],
  [
    "public-java",
    patch(
      "Public.java",
      ["public class Public { int half(int n) { return n / 3; } }"],
      ["public class Public { int half(int n) { return n / 2; } }"],
    ),
    false,
    true,
  ],
  ["public-json-array", patch("public.json", ["[1, 2]"], ["[1, 2, 3]"]), false, true],
  ["public-yaml", patch("public.yaml", ["version: 1"], ["version: 2"]), false, true],
  [
    "private-ts-deleted",
    patch("private.ts", [`const password: string = "${value}";`], ["const visible: number = 1;"]),
    true,
    false,
  ],
  [
    "private-ts-added",
    patch("private.ts", ["const visible: number = 1;"], [`const password: string = "${value}";`]),
    true,
    false,
  ],
  [
    "private-ts-astral-offset",
    patch(
      "private.ts",
      [`const label = "😀"; const password: string = "${value}";`],
      ["const visible: number = 1;"],
    ),
    true,
    false,
  ],
  [
    "private-json-escaped",
    patch("private.json", [`{"pass\\u0077ord":"${value}"}`], ['{"visible":1}']),
    true,
    false,
  ],
  [
    "private-java",
    patch(
      "Private.java",
      [`class Private { String password = "${value}"; }`],
      ["class Private { int visible = 1; }"],
    ),
    true,
    false,
  ],
  [
    "private-yaml-context",
    patch("private.yaml", [`  ${value}`], ["  changed"], ["password: >"]),
    true,
    false,
  ],
  [
    "private-context-old-only",
    patch("private.yaml", ["password:"], ["visible:"]) + `\n@@ -2 +2 @@\n   ${value}`,
    true,
    false,
  ],
  [
    "private-multifile",
    publicTs +
      "\n" +
      patch("private.ts", [`const password: string = "${value}";`], ["const visible: number = 1;"]),
    true,
    false,
  ],
  [
    "private-no-final-newline",
    patch("private.ts", [`const password: string = "${value}";`], ["const visible: number = 1;"]) +
      "\n\\ No newline at end of file",
    true,
    false,
  ],
  ["public-no-final-newline", publicTs + "\n\\ No newline at end of file", false, true],
  [
    "public-separate-hunks",
    publicTs + "\n@@ -50 +50 @@\n-export const before = 1;\n+export const after = 2;",
    false,
    true,
  ],
  ["private-preamble", `password=${value}\n` + publicTs, true, false],
  ["private-postamble", publicTs + `\n\npassword=${value}`, true, false],
  [
    "private-incomplete-file",
    `--- a/private.ts\n@@ -1 +1 @@\n-const password: string = "${value}";\n+const visible: number = 1;`,
    true,
    false,
  ],
  [
    "private-truncated-hunk",
    `--- a/private.ts\n+++ b/private.ts\n@@ -2,2 +2,2 @@\n-const password: string = "${value}";`,
    true,
    false,
  ],
  [
    "private-orphan-hunk",
    `@@ -1 +1 @@\n-const password: string = "${value}";\n+const visible: number = 1;`,
    true,
    false,
  ],
  [
    "private-combined-diff",
    `diff --cc private.ts\n--- a/private.ts\n+++ b/private.ts\n@@@ -1 -1 +1 @@@\n--const password: string = "${value}";\n++const visible: number = 1;`,
    true,
    false,
  ],
  [
    "private-disjoint-fragments",
    `--- a/private.ts\n+++ b/private.ts\n@@ -1 +1 @@\n-const password: string =\n+const visible = 0;\n@@ -100 +100 @@\n-"${value}";\n+const next = 1;`,
    true,
    false,
  ],
  [
    "public-git-metadata",
    "diff --git a/public.ts b/public.ts\nindex 1111111..2222222 100644\n" + publicTs,
    false,
    true,
  ],
];

function present(body: string, wrap: string): string {
  if (wrap === "bare") return body;
  const fenced = "```diff\n" + body + "\n```";
  return wrap === "diff-fence" ? fenced : visible + "\n\n" + fenced + "\n\n" + visible;
}

describe("unified diff privacy boundary matrix", () => {
  it.each(cases)(
    "%s preserves privacy, public syntax and streaming",
    (_name, body, privateExpected, publicExact) => {
      for (const eol of ["\n", "\r\n"]) {
        for (const wrap of ["bare", "diff-fence", "prose-fence"]) {
          const input = present(body, wrap).replaceAll("\n", eol);
          const output = redact(input);
          if (privateExpected) expect(output).not.toContain(value);
          if (publicExact) expect(output).toBe(input);
          if (wrap === "prose-fence") expect(output.split(visible)).toHaveLength(3);
          expect(redact(output)).toBe(output);
          const stream = createStreamingRedactor(redact);
          let published = "";
          for (const character of input) published += stream.push(character);
          if (privateExpected) expect(published).not.toContain(value);
          expect(published + stream.finish()).toBe(output);
        }
      }
    },
  );
});
