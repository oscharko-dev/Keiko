import { describe, expect, it } from "vitest";
import { decodeGitQuotedPath, parseUnifiedDiff, PatchParseError } from "./unified-diff.js";

// A path that holds a space, a quote, a backslash, a control character or a non-ASCII byte is
// written in C-style quotes by the tool that produced the diff. The header used to keep the quotes
// as part of the path, so a patch for such a file named a file that does not exist.
describe("quoted file header paths", () => {
  const body = ["@@ -1 +1 @@", "-a", "+b"].join("\n");

  it.each([
    ['"a/dir with space/x.txt"', "dir with space/x.txt"],
    ['"a/Gr\\303\\266\\303\\237e.txt"', "Größe.txt"],
    ['"a/q\\"uote.txt"', 'q"uote.txt'],
    ['"a/back\\\\slash.txt"', "back\\slash.txt"],
    ['"a/tab\\tname.txt"', "tab\tname.txt"],
  ])("decodes the quoted header path %s", (quoted, expected) => {
    const diff = [`--- ${quoted}\t`, `+++ ${quoted.replace('"a/', '"b/')}\t`, body, ""].join("\n");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.path).toBe(expected);
    expect(parsed.files[0]?.kind).toBe("modify");
  });

  it("keeps /dev/null for a quoted create", () => {
    const diff = [
      "--- /dev/null",
      '+++ "b/Gr\\303\\266\\303\\237e.txt"',
      "@@ -0,0 +1 @@",
      "+x",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff).files[0]).toMatchObject({ kind: "create", path: "Größe.txt" });
  });

  it.each(['"a/bad\\q.txt"', '"a/unterminated.txt', '"a/\\377.txt"'])(
    "rejects the malformed quoted path %s instead of keeping its quotes",
    (quoted) => {
      const diff = [`--- ${quoted}`, `+++ ${quoted}`, body, ""].join("\n");
      expect(() => parseUnifiedDiff(diff)).toThrow(PatchParseError);
    },
  );

  it("decodes quoted paths only when well formed", () => {
    expect(decodeGitQuotedPath('"a b"')).toBe("a b");
    expect(decodeGitQuotedPath('""')).toBe("");
    expect(decodeGitQuotedPath('"')).toBeUndefined();
    expect(decodeGitQuotedPath("plain")).toBeUndefined();
    expect(decodeGitQuotedPath('"\\30"')).toBeUndefined();
  });
});
