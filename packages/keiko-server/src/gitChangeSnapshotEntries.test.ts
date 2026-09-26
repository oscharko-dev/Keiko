import { describe, expect, it } from "vitest";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { gitChangeSnapshotEntryIdentityFields } from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import type { GitChangeSnapshotLimits } from "@oscharko-dev/keiko-contracts";
import { snapshotEntries } from "./gitChangeSnapshotEntries.js";
import type { SnapshotFileMetadata } from "./gitChangeSnapshotMetadata.js";

const OLD_OBJECT = "a".repeat(40);
const NEW_OBJECT = "b".repeat(40);

const LIMITS: GitChangeSnapshotLimits = {
  maxFiles: 400,
  maxHunksPerFile: 256,
  maxPatchBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
};

function modifyMeta(overrides: Partial<SnapshotFileMetadata> = {}): SnapshotFileMetadata {
  return {
    path: "file.txt",
    change: "modify",
    oldMode: "100644",
    newMode: "100644",
    oldObjectId: OLD_OBJECT,
    newObjectId: NEW_OBJECT,
    additions: 1,
    deletions: 1,
    binary: false,
    ...overrides,
  };
}

function section(path: string, ...hunkLines: readonly string[]): readonly string[] {
  return [`diff --git a/${path} b/${path}`, ...hunkLines];
}

function patchText(...sections: readonly (readonly string[])[]): string {
  return sections.flatMap((lines) => lines).join("\n");
}

describe("snapshot entries: empty input", () => {
  it("produces no entries, files or bytes for an empty comparison", () => {
    expect(snapshotEntries([], "", false, LIMITS)).toEqual({ entries: [], files: [], bytes: 0 });
  });
});

describe("snapshot entries: boundary caps", () => {
  it("caps entries at limits.maxFiles, dropping the remainder", () => {
    const metadata = [modifyMeta({ path: "a.txt" }), modifyMeta({ path: "b.txt" })];
    const result = snapshotEntries(metadata, "", false, { ...LIMITS, maxFiles: 1 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.pathDigest).toBe(sha256Hex("a.txt"));
  });

  it("caps hunks at limits.maxHunksPerFile and reports the drop as an omission", () => {
    const patch = patchText(
      section("file.txt", "@@ -1,1 +1,1 @@", "-one", "+two", "@@ -3,1 +3,1 @@", "-three", "+four"),
    );
    const result = snapshotEntries([modifyMeta()], patch, false, {
      ...LIMITS,
      maxHunksPerFile: 1,
    });
    const entry = result.entries[0];
    expect(entry?.hunks).toHaveLength(1);
    expect(entry?.omittedHunks).toBe(1);
    expect(entry?.truncated).toBe(false);
    expect(entry?.omission).toBe("byte-cap");
  });

  it("treats a file patch over limits.maxPatchBytes as fully truncated with no retained hunks", () => {
    const patch = patchText(section("file.txt", "@@ -1,1 +1,1 @@", "-one", "+two"));
    const result = snapshotEntries([modifyMeta()], patch, false, { ...LIMITS, maxPatchBytes: 10 });
    const entry = result.entries[0];
    expect(entry?.hunks).toEqual([]);
    expect(entry?.truncated).toBe(true);
    expect(entry?.omission).toBe("byte-cap");
  });
});

describe("snapshot entries: truncated records", () => {
  it("marks only the file whose patch was cut off by process truncation", () => {
    const patch = patchText(
      section("a.txt", "@@ -1,1 +1,1 @@", "-one", "+two"),
      section("b.txt", "@@ -1,1 +1,1 @@", "-three", "+four"),
    );
    const metadata = [modifyMeta({ path: "a.txt" }), modifyMeta({ path: "b.txt" })];
    const result = snapshotEntries(metadata, patch, true, LIMITS);
    expect(result.entries[0]?.truncated).toBe(false);
    expect(result.entries[1]?.truncated).toBe(true);
    expect(result.entries[1]?.omission).toBe("byte-cap");
  });
});

describe("snapshot entries: malformed patch lanes", () => {
  it("refuses two patch sections claiming the same file identity", () => {
    const patch = patchText(
      section("file.txt", "@@ -1,1 +1,1 @@", "-one", "+two"),
      section("file.txt", "@@ -1,1 +1,1 @@", "-a", "+b"),
    );
    expect(() => snapshotEntries([modifyMeta()], patch, false, LIMITS)).toThrow(
      "Git snapshot read failed",
    );
  });

  it("refuses a rename/copy metadata entry missing its paired identity", () => {
    const meta = modifyMeta({ change: "rename" });
    expect(() => snapshotEntries([meta], "", false, LIMITS)).toThrow("Git snapshot read failed");
  });
});

describe("snapshot entries: hostile inputs", () => {
  it("never attributes an untrusted patch-header path to a differently-identified metadata entry", () => {
    const patch = patchText(section("../../etc/passwd", "@@ -1,1 +1,1 @@", "-one", "+two"));
    const result = snapshotEntries([modifyMeta({ path: "safe.txt" })], patch, false, LIMITS);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.pathDigest).toBe(sha256Hex("safe.txt"));
    expect(result.entries[0]?.truncated).toBe(true);
    expect(result.files[0]?.path).toBe("safe.txt");
  });

  it("fails closed when a patch's line statistics disagree with the authoritative numstat lane", () => {
    const patch = patchText(section("file.txt", "@@ -1,1 +1,1 @@", "-one", "+two"));
    const meta = modifyMeta({ additions: 5, deletions: 5 });
    expect(() => snapshotEntries([meta], patch, false, LIMITS)).toThrow("Git snapshot read failed");
  });
});

describe("snapshot entries: entry classification", () => {
  it("derives evidenceId, pathDigest and hunkDigest via the shared identity/digest primitives", () => {
    const meta = modifyMeta();
    const patch = patchText(section("file.txt", "@@ -1,1 +1,1 @@", "-one", "+two"));
    const result = snapshotEntries([meta], patch, false, LIMITS);
    const entry = result.entries[0];
    if (entry === undefined) throw new Error("expected one entry");
    expect(entry.pathDigest).toBe(sha256Hex(meta.path));
    const hunk = entry.hunks[0];
    // The full parsed hunk (with its classified lines) survives separately on `files`, produced
    // by the same `gitDiffParser` call `snapshotEntries` itself makes — so the expected digest is
    // derived from that production output, never a hand-restated line classification.
    const fileHunk = result.files[0]?.hunks[0];
    if (hunk === undefined || fileHunk === undefined) throw new Error("expected one hunk");
    expect(hunk.hunkDigest).toBe(
      sha256Hex(
        canonicalise({
          oldStart: fileHunk.oldStart,
          oldCount: fileHunk.oldCount,
          newStart: fileHunk.newStart,
          newCount: fileHunk.newCount,
          lines: fileHunk.lines,
        }),
      ),
    );
    const { evidenceId, ...withoutEvidence } = entry;
    expect(evidenceId).toBe(
      sha256Hex(canonicalise(gitChangeSnapshotEntryIdentityFields(withoutEvidence))),
    );
    expect(result.files[0]).toEqual({
      evidenceId,
      path: "file.txt",
      hunks: [fileHunk],
    });
  });

  it("marks a binary entry contentless and omits it as binary", () => {
    const meta = modifyMeta({ binary: true, additions: 3, deletions: 2 });
    const result = snapshotEntries([meta], "", false, LIMITS);
    const entry = result.entries[0];
    if (entry === undefined) throw new Error("expected one entry");
    expect(entry.kind).toBe("binary");
    expect(entry.additions).toBe(0);
    expect(entry.deletions).toBe(0);
    expect(entry.hunks).toEqual([]);
    expect(entry.omission).toBe("binary");
    expect(result.files[0]?.hunks).toEqual([]);
  });

  it("classifies a gitlink-mode entry as a submodule even when also flagged binary", () => {
    const meta = modifyMeta({ oldMode: "160000", newMode: "160000", binary: true });
    const result = snapshotEntries([meta], "", false, LIMITS);
    expect(result.entries[0]?.kind).toBe("submodule");
    expect(result.entries[0]?.omission).toBe("submodule");
  });

  it("classifies a same-blob mode-only change with no omission", () => {
    const meta = modifyMeta({
      oldObjectId: OLD_OBJECT,
      newObjectId: OLD_OBJECT,
      newMode: "100755",
    });
    const result = snapshotEntries([meta], "", false, LIMITS);
    expect(result.entries[0]?.kind).toBe("mode-change");
    expect(result.entries[0]?.omission).toBeUndefined();
  });

  it("carries paired rename identity through to the entry", () => {
    const meta = modifyMeta({
      path: "new.txt",
      oldPath: "old.txt",
      change: "rename",
      similarity: 90,
    });
    const patch = patchText([
      "diff --git a/old.txt b/new.txt",
      "rename from old.txt",
      "rename to new.txt",
      "@@ -1,1 +1,1 @@",
      "-one",
      "+two",
    ]);
    const result = snapshotEntries([meta], patch, false, LIMITS);
    const entry = result.entries[0];
    if (entry?.kind !== "rename") throw new Error("expected a rename entry");
    expect(entry.oldPathDigest).toBe(sha256Hex("old.txt"));
    expect(entry.similarity).toBe(90);
  });
});
