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

function create(lines: readonly string[]): PatchFileChange {
  return {
    path: "n",
    kind: "create",
    addedLines: lines.filter((l) => l.startsWith("+")).length,
    removedLines: 0,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }],
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

describe("computeFileContent — final line break (#3873)", () => {
  // `\ No newline at end of file` annotates the body line before it. The engine reads it as Git
  // does: a marked line is the file's last line without a line break, an unmarked line has one,
  // and lines after the last hunk keep the current content's ending.
  const MARKER = String.raw`\ No newline at end of file`;

  it("keeps a missing final line break the patch names on both sides", () => {
    const out = computeFileContent(
      modify([" alpha", "-beta", MARKER, "+gamma", MARKER]),
      "alpha\nbeta",
    );
    expect(out.conflicts).toEqual([]);
    expect(out.content).toBe("alpha\ngamma");
  });

  it("adds the final line break the patch states", () => {
    const out = computeFileContent(modify(["-beta", MARKER, "+beta"], 2), "alpha\nbeta");
    expect(out.content).toBe("alpha\nbeta\n");
  });

  it("removes the final line break the patch states", () => {
    const out = computeFileContent(modify(["-beta", "+beta", MARKER], 2), "alpha\nbeta\n");
    expect(out.content).toBe("alpha\nbeta");
  });

  it("keeps the current ending for lines after the last hunk", () => {
    expect(computeFileContent(modify(["-alpha", "+ALPHA"]), "alpha\nbeta").content).toBe(
      "ALPHA\nbeta",
    );
    expect(computeFileContent(modify(["-alpha", "+ALPHA"]), "alpha\nbeta\n").content).toBe(
      "ALPHA\nbeta\n",
    );
  });

  it("gives an unmarked last line its line break, as Git does", () => {
    const out = computeFileContent(modify([" alpha", "-beta", "+gamma"]), "alpha\nbeta");
    expect(out.content).toBe("alpha\ngamma\n");
  });

  it("removes a marked last line and keeps the line break of the one before it", () => {
    const out = computeFileContent(modify([" alpha", "-beta", MARKER]), "alpha\nbeta");
    expect(out.content).toBe("alpha\n");
  });

  it.each([
    [
      "the current content ends with the line break the marker denies",
      ["-beta", MARKER, "+gamma"],
      "alpha\nbeta\n",
      2,
    ],
    [
      "the marked line is not the current last line",
      ["-alpha", MARKER, "+gamma", " beta"],
      "alpha\nbeta",
      1,
    ],
    [
      "a marked new line is followed by more hunk lines",
      ["-alpha", "+gamma", MARKER, " beta"],
      "alpha\nbeta",
      1,
    ],
    [
      "a marked new line is followed by untouched lines",
      ["-alpha", "+gamma", MARKER],
      "alpha\nbeta",
      1,
    ],
    ["two markers name the new last line", ["-alpha", "+gamma", MARKER, MARKER], "alpha", 1],
    ["the marker follows nothing", [MARKER, "-alpha", "+gamma"], "alpha", 1],
  ])("conflicts when %s", (_name, lines, current, oldStart) => {
    const out = computeFileContent(modify(lines, oldStart), current);
    expect(out.content).toBeNull();
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.reason).toContain("no-newline marker");
  });

  it("conflicts when a marked hunk is followed by another hunk", () => {
    const change: PatchFileChange = {
      path: "x",
      kind: "modify",
      addedLines: 2,
      removedLines: 2,
      hunks: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+A", MARKER] },
        { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-c", "+C"] },
      ],
    };
    const out = computeFileContent(change, "a\nb\nc");
    expect(out.content).toBeNull();
    expect(out.conflicts.map((c) => c.hunkIndex)).toEqual([1]);
  });

  it("creates a file without a final line break when the marker names its last line", () => {
    expect(computeFileContent(create(["+one", "+two", MARKER]), undefined).content).toBe(
      "one\ntwo",
    );
  });

  it.each([
    ["is not on its last line", ["+one", MARKER, "+two"]],
    ["follows nothing", [MARKER, "+one"]],
  ])("conflicts when a created file's marker %s", (_name, lines) => {
    const out = computeFileContent(create(lines), undefined);
    expect(out.content).toBeNull();
    expect(out.conflicts[0]?.reason).toContain("no-newline marker");
  });

  it("deletes a file without a final line break whose pre-image matches", () => {
    const change: PatchFileChange = {
      path: "d",
      kind: "delete",
      addedLines: 0,
      removedLines: 2,
      hunks: [
        { oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ["-one", "-two", MARKER] },
      ],
    };
    expect(computeFileContent(change, "one\ntwo")).toEqual({ content: null, conflicts: [] });
  });
});
