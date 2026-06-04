import { describe, expect, it } from "vitest";
import { computeFileContent } from "./patch-content.js";
import type { PatchFileChange } from "./types.js";

function modify(lines: readonly string[], oldStart = 1): PatchFileChange {
  return {
    path: "x",
    kind: "modify",
    addedLines: lines.filter((l) => l.startsWith("+")).length,
    removedLines: lines.filter((l) => l.startsWith("-")).length,
    hunks: [{ oldStart, oldLines: 0, newStart: oldStart, newLines: 0, lines }],
  };
}

describe("computeFileContent — modify", () => {
  it("applies a matching hunk and preserves surrounding lines", () => {
    const out = computeFileContent(modify([" a", "-b", "+B", " c"]), "a\nb\nc\n");
    expect(out.conflicts).toHaveLength(0);
    expect(out.content).toBe("a\nB\nc\n");
  });

  it("reports a conflict when context does not match", () => {
    const out = computeFileContent(modify([" a", "-b", "+B"]), "a\nDIFFERENT\n");
    expect(out.content).toBeNull();
    expect(out.conflicts).toHaveLength(1);
  });

  it("reports a conflict when the target is missing", () => {
    const out = computeFileContent(modify([" a", "+b"]), undefined);
    expect(out.content).toBeNull();
    expect(out.conflicts[0]?.reason).toContain("does not exist");
  });

  it("applies a hunk anchored beyond the first line", () => {
    const out = computeFileContent(modify([" b", "-c", "+C"], 2), "a\nb\nc\n");
    expect(out.content).toBe("a\nb\nC\n");
  });
});

describe("computeFileContent — create / delete", () => {
  it("creates content from added lines when absent", () => {
    const change: PatchFileChange = {
      path: "n",
      kind: "create",
      addedLines: 2,
      removedLines: 0,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+one", "+two"] }],
    };
    const out = computeFileContent(change, undefined);
    expect(out.content).toBe("one\ntwo\n");
  });

  it("conflicts when creating an existing file", () => {
    const change: PatchFileChange = {
      path: "n",
      kind: "create",
      addedLines: 1,
      removedLines: 0,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+x"] }],
    };
    expect(computeFileContent(change, "exists\n").conflicts).toHaveLength(1);
  });

  it("deletes an existing file (null content, no conflict)", () => {
    const change: PatchFileChange = {
      path: "d",
      kind: "delete",
      addedLines: 0,
      removedLines: 1,
      hunks: [],
    };
    const out = computeFileContent(change, "gone\n");
    expect(out.content).toBeNull();
    expect(out.conflicts).toHaveLength(0);
  });

  it("conflicts when deleting a missing file", () => {
    const change: PatchFileChange = {
      path: "d",
      kind: "delete",
      addedLines: 0,
      removedLines: 1,
      hunks: [],
    };
    expect(computeFileContent(change, undefined).conflicts).toHaveLength(1);
  });

  it("deletes when the hunk pre-image matches the current content (C2)", () => {
    const change: PatchFileChange = {
      path: "d",
      kind: "delete",
      addedLines: 0,
      removedLines: 2,
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ["-one", "-two"] }],
    };
    const out = computeFileContent(change, "one\ntwo\n");
    expect(out.content).toBeNull();
    expect(out.conflicts).toHaveLength(0);
  });

  it("conflicts on a STALE delete whose pre-image does not match (C2): file NOT deleted", () => {
    const change: PatchFileChange = {
      path: "d",
      kind: "delete",
      addedLines: 0,
      removedLines: 2,
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ["-one", "-two"] }],
    };
    // Current content differs from the diff's pre-image — a fabricated/stale delete.
    const out = computeFileContent(change, "ACTUAL\nCONTENT\n");
    expect(out.content).toBeNull();
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.reason).toContain("pre-image");
  });
});
