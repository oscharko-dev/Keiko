import { describe, expect, it } from "vitest";
import { translateDiffToWirePatch, type OriginalContentReader } from "./testGenerationPatch.js";

const CREATE_DIFF = [
  "--- /dev/null",
  "+++ b/src/a.test.ts",
  "@@ -0,0 +1,2 @@",
  "+import { it } from 'vitest';",
  "+it('adds', () => {});",
  "",
].join("\n");

const MODIFY_DIFF = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,2 @@",
  " const a = 1;",
  "+const b = 2;",
  "",
].join("\n");

const DELETE_DIFF = ["--- a/src/old.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-gone", ""].join(
  "\n",
);

const NO_ORIGINAL: OriginalContentReader = () => undefined;

describe("translateDiffToWirePatch", () => {
  it("translates a created file into an added change with the full new content", () => {
    const patch = translateDiffToWirePatch(CREATE_DIFF, "pid", NO_ORIGINAL);
    expect(patch).not.toBeUndefined();
    const file = patch?.files[0];
    expect(file?.path).toBe("src/a.test.ts");
    expect(file?.changeKind).toBe("added");
    expect(file?.edits[0]?.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });
    expect(file?.edits[0]?.newText).toContain("it('adds'");
  });

  it("translates a modified file using the injected original content", () => {
    const reader: OriginalContentReader = (path) =>
      path === "src/a.ts" ? "const a = 1;\n" : undefined;
    const patch = translateDiffToWirePatch(MODIFY_DIFF, "pid", reader);
    const file = patch?.files[0];
    expect(file?.changeKind).toBe("modified");
    expect(file?.edits[0]?.newText).toContain("const b = 2;");
    // The replacement spans the whole original; the trailing newline puts the end at the next line.
    expect(file?.edits[0]?.range.end.line).toBe(1);
  });

  it("translates a deleted file into a deleted change with empty new text", () => {
    const reader: OriginalContentReader = () => "gone\n";
    const patch = translateDiffToWirePatch(DELETE_DIFF, "pid", reader);
    expect(patch?.files[0]?.changeKind).toBe("deleted");
    expect(patch?.files[0]?.edits[0]?.newText).toBe("");
  });

  it("omits a modified file whose original cannot be read", () => {
    expect(translateDiffToWirePatch(MODIFY_DIFF, "pid", NO_ORIGINAL)).toBeUndefined();
  });

  it("returns undefined for an unparseable or empty diff", () => {
    expect(translateDiffToWirePatch("not a diff", "pid", NO_ORIGINAL)).toBeUndefined();
    expect(translateDiffToWirePatch("", "pid", NO_ORIGINAL)).toBeUndefined();
  });
});
