import { describe, expect, it } from "vitest";
import { parseSnapshotMetadata } from "./gitChangeSnapshotMetadata.js";

const oldObject = "a".repeat(40);
const newObject = "b".repeat(40);
const modified = `:100644 100644 ${oldObject} ${newObject} M\0file\0`;

describe("snapshot metadata NUL lanes", () => {
  it("joins copy identity with embedded tabs/newlines without splitting filenames", () => {
    const path = "destination\tline\n.txt";
    const raw = `:100644 100755 ${oldObject} ${newObject} C075\0source\0${path}\0`;
    expect(parseSnapshotMetadata(raw, `5\t2\t\0source\0${path}\0`)).toEqual([
      {
        path,
        oldPath: "source",
        change: "copy",
        similarity: 75,
        oldMode: "100644",
        newMode: "100755",
        oldObjectId: oldObject,
        newObjectId: newObject,
        additions: 5,
        deletions: 2,
        binary: false,
      },
    ]);
  });

  it.each([
    [modified.slice(0, -1), "1\t1\tfile\0"],
    [modified, "1\t1\tother\0"],
    [modified + modified, "1\t1\tfile\0"],
    [modified.replace("M\0file", "R101\0old\0file"), "1\t1\t\0old\0file\0"],
    [modified.replace("file", "../escape"), "1\t1\t../escape\0"],
    [modified, "-\t1\tfile\0"],
    [modified, "9007199254740992\t1\tfile\0"],
  ])("rejects malformed, ambiguous, unsafe or mismatched raw/numstat lanes", (raw, numstat) => {
    expect(() => parseSnapshotMetadata(raw, numstat)).toThrow("Git snapshot read failed");
  });
});
