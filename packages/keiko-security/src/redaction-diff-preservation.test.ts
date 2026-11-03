import { describe, expect, it } from "vitest";
import { createStreamingRedactor, redact } from "./redaction.js";

const PUBLIC_DIFF = [
  "--- a/src/half.ts",
  "+++ b/src/half.ts",
  "@@ -1 +1 @@",
  "-export const half = (n: number): number => n / 3;",
  "+export const half = (n: number): number => n / 2;",
].join("\n");

describe("unified diff source preservation", () => {
  it.each([false, true])(
    "keeps one private-value scope for nested patch sources (%j)",
    (reverse) => {
      const value = ["synthetic", "nested", "837291"].join("-");
      const inner = `--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const password: string = "${value}";\n+const after = 1;`;
      const lines = inner.split("\n");
      const nested = `--- /dev/null\n+++ b/inner.patch\n@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((line) => "+" + line).join("\n")}`;
      const copy = `--- a/copy.ts\n+++ b/copy.ts\n@@ -1 +1 @@\n-const before = 1;\n+const copy = "${value}";`;
      expect(redact((reverse ? [copy, nested] : [nested, copy]).join("\n"))).not.toContain(value);
    },
  );
  it.each(["preamble", "postamble"])(
    "does not grant raw fallback to private %s material",
    (position) => {
      const value = ["synthetic", "unowned", "82719"].join("-");
      const unowned = `-const config = {"pass\\u0077ord":"${value}"};`;
      const text =
        position === "preamble" ? unowned + "\n" + PUBLIC_DIFF : PUBLIC_DIFF + "\n\n" + unowned;
      expect(redact(text)).not.toContain(value);
      expect(redact(text)).toContain("+export const half = (n: number): number => n / 2;");
    },
  );

  it.each([false, true])(
    "masks known private copies in another file regardless of order (%j)",
    (reverse) => {
      const value = ["synthetic", "multifile", "82719"].join("-");
      const first = `--- a/private.ts\n+++ b/private.ts\n@@ -1 +1 @@\n-const password: string = "${value}";\n+const after = 1;`;
      const second = `--- a/copy.ts\n+++ b/copy.ts\n@@ -1 +1 @@\n-const before = 1;\n+const copy = "${value}";`;
      expect(redact((reverse ? [second, first] : [first, second]).join("\n"))).not.toContain(value);
    },
  );
  it.each([PUBLIC_DIFF, `\`\`\`diff\n${PUBLIC_DIFF}\n\`\`\``])(
    "preserves a valid public unified diff",
    (text) => {
      expect(redact(text)).toBe(text);
    },
  );

  it.each(["\n", "\r\n"])(
    "preserves public function context and original line markers with %j",
    (eol) => {
      const text = PUBLIC_DIFF.replace(
        "@@ -1 +1 @@",
        "@@ -1 +1 @@ export function half(n: number) {",
      ).replaceAll("\n", eol);
      expect(redact(text)).toBe(text);
    },
  );

  it("keeps a YAML document scalar distinct from a patch header", () => {
    expect(redact("--- a/public/path\n")).toBe("--- a/public/path\n");
  });

  it.each(["\n", "\r\n"])(
    "masks decoded copies across old/new images without joining disjoint hunks with %j",
    (eol) => {
      const value = ["synthetic", "diff", "93721"].join("-");
      const text = [
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1 +1 @@",
        `-const password: string = "${value}";`,
        `+const visible = "${value}";`,
        "@@ -100 +100 @@",
        `-const other = "${value}";`,
        "+const after = 1;",
      ].join(eol);
      const safe = redact(text);
      expect(safe).not.toContain(value);
      expect(safe).toContain("+const after = 1;");
      expect(safe.split(eol)).toHaveLength(text.split(eol).length);
      const stream = createStreamingRedactor(redact);
      let published = "";
      for (const character of text) published += stream.push(character);
      expect(published + stream.finish()).toBe(safe);
    },
  );
});
