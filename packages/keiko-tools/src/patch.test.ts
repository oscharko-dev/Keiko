import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  applyPatch,
  inspectPatch,
  projectValidatedPatch,
  renderDryRun,
  type PatchInspection,
  type PatchInspectionFile,
  validatePatch,
} from "./patch.js";
import {
  CommandCancelledError,
  PatchApplyDisabledError,
  PatchApplyError,
  PatchValidationError,
} from "./errors.js";
import { makeWorkspace, recordingWriter } from "./_support.js";
import type { WorkspaceFs, WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

let root: string;
let info: WorkspaceInfo;

beforeEach(() => {
  ({ root, info } = makeWorkspace());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

// A modify diff turning "one\ntwo\n" into "one\nTWO\n".
const MODIFY_DIFF = "--- a/src/x.txt\n+++ b/src/x.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
const CREATE_DIFF = "--- /dev/null\n+++ b/src/new.txt\n@@ -0,0 +1,1 @@\n+created\n";
const DELETE_DIFF = "--- a/src/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old\n";
const SOURCE_FILE_MAX_BYTES = 1_000_000;
const SOURCE_TOTAL_MAX_BYTES = 4_000_000;

function modifyFirstLineDiff(path: string, before = "old", after = "new"): string {
  return `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-${before}\n+${after}\n`;
}

function sourceWithByteLength(bytes: number): string {
  const prefix = "old\n";
  return `${prefix}${"x".repeat(bytes - Buffer.byteLength(prefix, "utf8"))}`;
}

function withFs(overrides: Partial<WorkspaceFs>): WorkspaceFs {
  return { ...nodeWorkspaceFs, ...overrides };
}

function requiredInspectionFile(inspection: PatchInspection, path: string): PatchInspectionFile {
  const file = inspection.files?.find((candidate) => candidate.change.path === path);
  if (file === undefined) throw new Error("expected inspected patch file");
  return file;
}

function requiredSourceVersion(
  file: PatchInspectionFile,
): NonNullable<PatchInspectionFile["sourceVersion"]> {
  if (file.sourceVersion === undefined) throw new Error("expected inspected source version");
  return file.sourceVersion;
}

describe("inspectPatch", () => {
  it("returns one coherent safe snapshot per distinct create, modify, and delete source", () => {
    write("src/x.txt", "one\ntwo\n");
    write("src/old.txt", "old\n");
    const reads: string[] = [];
    const fs = withFs({
      readFileUtf8: (absolutePath): string => {
        reads.push(absolutePath);
        return nodeWorkspaceFs.readFileUtf8(absolutePath);
      },
    });

    const inspection = inspectPatch(info, MODIFY_DIFF + CREATE_DIFF + DELETE_DIFF, { fs });
    const modified = requiredInspectionFile(inspection, "src/x.txt");
    const created = requiredInspectionFile(inspection, "src/new.txt");
    const deleted = requiredInspectionFile(inspection, "src/old.txt");
    const modifiedVersion = requiredSourceVersion(modified);

    expect(inspection.validation.ok).toBe(true);
    expect(reads).toEqual([join(root, "src/x.txt"), join(root, "src/old.txt")]);
    expect(modified.original).toBe("one\ntwo\n");
    expect(modified.outcome).toEqual({ content: "one\nTWO\n", conflicts: [] });
    expect(modified.sourceContentHash).toBe(sha256Hex("one\ntwo\n"));
    expect(modifiedVersion).toMatchObject({
      sizeBytes: 8,
      contentHash: sha256Hex("one\ntwo\n"),
    });
    expect(modifiedVersion.modifiedAt).toBe(nodeWorkspaceFs.stat(join(root, "src/x.txt")).mtimeMs);
    expect(created).toMatchObject({
      original: undefined,
      outcome: { content: "created\n", conflicts: [] },
      sourceContentHash: sha256Hex(""),
    });
    expect(created.sourceVersion).toBeUndefined();
    expect(deleted.original).toBe("old\n");
    expect(deleted.outcome).toEqual({ content: null, conflicts: [] });
  });

  it("reads a duplicated source path only once", () => {
    write("src/x.txt", "one\ntwo\n");
    const reads: string[] = [];
    const fs = withFs({
      readFileUtf8: (absolutePath): string => {
        reads.push(absolutePath);
        return nodeWorkspaceFs.readFileUtf8(absolutePath);
      },
    });

    const inspection = inspectPatch(info, MODIFY_DIFF + MODIFY_DIFF, { fs });

    expect(inspection.files).toHaveLength(2);
    expect(reads).toEqual([join(root, "src/x.txt")]);
  });

  it("returns no source snapshots for denied and oversized sources without reading them", () => {
    const oversizedPath = "src/oversized.txt";
    write(oversizedPath, sourceWithByteLength(SOURCE_FILE_MAX_BYTES + 1));
    const reads: string[] = [];
    const fs = withFs({
      readFileUtf8: (absolutePath): string => {
        reads.push(absolutePath);
        return nodeWorkspaceFs.readFileUtf8(absolutePath);
      },
    });

    const denied = inspectPatch(info, modifyFirstLineDiff(".env"), { fs });
    const oversized = inspectPatch(info, modifyFirstLineDiff(oversizedPath), { fs });

    expect(denied.files).toBeNull();
    expect(denied.validation.reasons[0]?.code).toBe("path-denied");
    expect(oversized.files).toBeNull();
    expect(oversized.validation.reasons[0]?.code).toBe("size-limit");
    expect(reads).toEqual([]);
  });

  it("does not let a successful inspection bypass fresh apply validation", () => {
    write("src/x.txt", "one\ntwo\n");
    expect(inspectPatch(info, MODIFY_DIFF).validation.ok).toBe(true);
    write("src/x.txt", "one\nsix\n");

    expect(() =>
      applyPatch(info, MODIFY_DIFF, { applyEnabled: true, signal: liveSignal() }),
    ).toThrow(PatchValidationError);
    expect(read("src/x.txt")).toBe("one\nsix\n");
  });
});

describe("validatePatch — rejections", () => {
  it("rejects an out-of-workspace target path", () => {
    const diff = "--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("path-unsafe");
  });

  it("rejects a denied target path (.env)", () => {
    const diff = "--- /dev/null\n+++ b/.env\n@@ -0,0 +1,1 @@\n+SECRET=1\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("path-denied");
  });

  it("rejects an oversized diff", () => {
    const v = validatePatch(info, CREATE_DIFF, {
      limits: { maxPatchBytes: 5, maxChangedLines: 9, maxFilesChanged: 9 },
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("size-limit");
  });

  it("rejects a git binary patch", () => {
    const diff = "--- a/x\n+++ b/x\nGIT binary patch\nliteral 0\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("binary");
  });

  it("rejects too many changed lines", () => {
    const v = validatePatch(info, CREATE_DIFF, {
      limits: { maxPatchBytes: 9_999, maxChangedLines: 0, maxFilesChanged: 9 },
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("line-limit");
  });

  it("rejects too many files changed", () => {
    const diff = CREATE_DIFF + "--- /dev/null\n+++ b/src/two.txt\n@@ -0,0 +1,1 @@\n+x\n";
    const v = validatePatch(info, diff, {
      limits: { maxPatchBytes: 9_999, maxChangedLines: 99, maxFilesChanged: 1 },
    });
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("file-limit");
  });

  it("accepts source files exactly at the per-file and aggregate byte caps", () => {
    const paths = ["src/a.txt", "src/b.txt", "src/c.txt", "src/d.txt"];
    for (const path of paths) {
      write(path, sourceWithByteLength(SOURCE_FILE_MAX_BYTES));
    }

    const validation = validatePatch(info, paths.map((path) => modifyFirstLineDiff(path)).join(""));

    expect(SOURCE_FILE_MAX_BYTES * paths.length).toBe(SOURCE_TOTAL_MAX_BYTES);
    expect(validation.ok).toBe(true);
    expect(validation.reasons).toEqual([]);
  });

  it("rejects a source file one byte over the per-file cap before reading it", () => {
    const path = "src/x.txt";
    const reads: string[] = [];
    write(path, sourceWithByteLength(SOURCE_FILE_MAX_BYTES + 1));
    const fs = withFs({
      readFileUtf8: (absolutePath: string): string => {
        reads.push(absolutePath);
        return nodeWorkspaceFs.readFileUtf8(absolutePath);
      },
    });

    const validation = validatePatch(info, modifyFirstLineDiff(path), { fs });

    expect(validation.ok).toBe(false);
    expect(validation.reasons).toEqual([
      {
        code: "size-limit",
        message: "source file exceeds the per-file byte limit",
        path,
      },
    ]);
    expect(reads).toEqual([]);
  });

  it("rejects aggregate source bytes one byte over the cap before the excess read", () => {
    const cappedPaths = ["src/a.txt", "src/b.txt", "src/c.txt", "src/d.txt"];
    const excessPath = "src/e.txt";
    const reads: string[] = [];
    for (const path of cappedPaths) {
      write(path, sourceWithByteLength(SOURCE_FILE_MAX_BYTES));
    }
    write(excessPath, "x");
    const fs = withFs({
      readFileUtf8: (absolutePath: string): string => {
        reads.push(absolutePath);
        return nodeWorkspaceFs.readFileUtf8(absolutePath);
      },
    });
    const diff = [
      ...cappedPaths.map((path) => modifyFirstLineDiff(path)),
      modifyFirstLineDiff(excessPath, "x", "y"),
    ].join("");

    const validation = validatePatch(info, diff, { fs });

    expect(validation.ok).toBe(false);
    expect(validation.reasons).toEqual([
      {
        code: "size-limit",
        message: "source files exceed the aggregate byte limit",
        path: excessPath,
      },
    ]);
    expect(reads).not.toContain(join(root, excessPath));
  });

  it("rejects a non-regular source without reading it", () => {
    const path = "src/x.txt";
    const target = join(root, path);
    let reads = 0;
    write(path, "old\n");
    const fs = withFs({
      stat: (absolutePath) =>
        absolutePath === target
          ? { size: 4, isFile: false, isDirectory: true, isSymbolicLink: false, hardLinkCount: 1 }
          : nodeWorkspaceFs.stat(absolutePath),
      readFileUtf8: (absolutePath: string): string => {
        reads += 1;
        return nodeWorkspaceFs.readFileUtf8(absolutePath);
      },
    });

    const validation = validatePatch(info, modifyFirstLineDiff(path), { fs });

    expect(validation.ok).toBe(false);
    expect(validation.reasons).toEqual([
      { code: "path-denied", message: "source target is not a regular file", path },
    ]);
    expect(reads).toBe(0);
  });

  it("rejects a source that grows after stat with a fixed content-free result", () => {
    const path = "src/x.txt";
    const target = join(root, path);
    write(path, "old\nWORKSPACE_ONLY_SECRET");
    const fs = withFs({
      stat: (absolutePath) => {
        const stat = nodeWorkspaceFs.stat(absolutePath);
        return absolutePath === target ? { ...stat, size: stat.size - 1 } : stat;
      },
    });

    const validation = validatePatch(info, modifyFirstLineDiff(path), { fs });

    expect(validation.ok).toBe(false);
    expect(validation.reasons).toEqual([
      { code: "path-denied", message: "source file changed during validation", path },
    ]);
    expect(JSON.stringify(validation)).not.toContain(root);
    expect(JSON.stringify(validation)).not.toContain("WORKSPACE_ONLY_SECRET");
  });

  it("rejects a source that shrinks after stat with the same fixed rejection", () => {
    const path = "src/x.txt";
    const target = join(root, path);
    write(path, "old\nWORKSPACE_ONLY_SECRET");
    const fs = withFs({
      readFileUtf8: (absolutePath: string): string =>
        absolutePath === target ? "old\n" : nodeWorkspaceFs.readFileUtf8(absolutePath),
    });

    const validation = validatePatch(info, modifyFirstLineDiff(path), { fs });

    expect(validation.ok).toBe(false);
    expect(validation.reasons).toEqual([
      { code: "path-denied", message: "source file changed during validation", path },
    ]);
    expect(JSON.stringify(validation)).not.toContain(root);
    expect(JSON.stringify(validation)).not.toContain("WORKSPACE_ONLY_SECRET");
  });

  it("redacts stat and read failures behind fixed source rejection messages", () => {
    const path = "src/x.txt";
    const target = join(root, path);
    write(path, "old\n");
    const statFailure = validatePatch(info, modifyFirstLineDiff(path), {
      fs: withFs({
        stat: (absolutePath) => {
          if (absolutePath === target) throw new Error(`STAT_SECRET ${absolutePath}`);
          return nodeWorkspaceFs.stat(absolutePath);
        },
      }),
    });
    const readFailure = validatePatch(info, modifyFirstLineDiff(path), {
      fs: withFs({
        readFileUtf8: (absolutePath: string): string => {
          throw new Error(`READ_SECRET ${absolutePath}`);
        },
      }),
    });

    expect(statFailure.reasons).toEqual([
      { code: "path-denied", message: "source file could not be inspected safely", path },
    ]);
    expect(readFailure.reasons).toEqual([
      { code: "path-denied", message: "source file could not be read safely", path },
    ]);
    expect(JSON.stringify([statFailure, readFailure])).not.toContain(root);
    expect(JSON.stringify([statFailure, readFailure])).not.toContain("SECRET");
  });

  it("reports a context-mismatch conflict", () => {
    write("src/x.txt", "DIFFERENT\ncontent\n");
    const v = validatePatch(info, MODIFY_DIFF);
    expect(v.ok).toBe(false);
    expect(v.conflicts).toHaveLength(1);
    expect(v.conflicts[0]?.path).toBe("src/x.txt");
  });

  it("reports a conflict for creating an existing file", () => {
    write("src/new.txt", "already here\n");
    const v = validatePatch(info, CREATE_DIFF);
    expect(v.ok).toBe(false);
    expect(v.conflicts[0]?.reason).toContain("already exists");
  });

  it("returns malformed for an unparseable hunk header", () => {
    const diff = "--- a/x\n+++ b/x\n@@ this is not a hunk header @@\n+y\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("malformed");
  });

  it("rejects non-diff text that does not change any file", () => {
    const v = validatePatch(info, "// no unified diff here");
    expect(v.ok).toBe(false);
    expect(v.files).toHaveLength(0);
    expect(v.reasons.map((r) => r.code)).toContain("malformed");
  });

  it("rejects escaped newline artifacts inside diff body lines", () => {
    const diff =
      "--- /dev/null\n+++ b/tests/x.test.js\n@@\n+it('x', () => {\\n+  expect(1).toBe(1);\\n+});\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("malformed");
    expect(v.reasons[0]?.message).toContain("escaped newline");
  });

  it("accepts a valid modify against matching content", () => {
    write("src/x.txt", "one\ntwo\n");
    const v = validatePatch(info, MODIFY_DIFF);
    expect(v.ok).toBe(true);
    expect(v.reasons).toHaveLength(0);
    expect(v.conflicts).toHaveLength(0);
  });

  it("normalizes an LLM shorthand create hunk before validation", () => {
    const diff =
      '--- /dev/null\n+++ b/tests/generated.test.js\n@@\n+import { it } from "vitest";\n+it("runs", () => {});\n';
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(true);
    expect(v.normalizedDiff).toContain("@@ -0,0 +1,2 @@");
    expect(v.files[0]?.path).toBe("tests/generated.test.js");
    expect(v.files[0]?.addedLines).toBe(2);
  });

  it("normalizes a create-only modify diff for a missing file", () => {
    const diff =
      '--- a/tests/generated.test.js\n+++ b/tests/generated.test.js\n@@ -0,0 +1,1 @@\n+it("runs", () => {});\n';
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(true);
    expect(v.files[0]?.kind).toBe("create");
    expect(v.normalizedDiff).toContain("--- /dev/null");
  });

  it("normalizes stale hunk counts but still requires matching context", () => {
    write("src/x.txt", "one\ntwo\n");
    const diff = "--- a/src/x.txt\n+++ b/src/x.txt\n@@ -1,99 +1,99 @@\n one\n-two\n+TWO\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(true);
    expect(v.normalizedDiff).toContain("@@ -1,2 +1,2 @@");
  });

  it("normalizes LLM blank context lines inside hunks", () => {
    write("src/x.txt", "one\n\ntwo\n");
    const diff =
      "--- a/src/x.txt\n+++ b/src/x.txt\n@@ -1,3 +1,4 @@ context\n one\n\n two\n+three\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(true);
    expect(v.normalizedDiff).toContain(" one\n \n two");
    expect(v.normalizedDiff).toContain("@@ -1,3 +1,4 @@");
  });

  it("anchors an LLM shorthand modify hunk by exact unique preimage", () => {
    write("src/x.txt", "header\none\ntwo\nfooter\n");
    const diff = "--- a/src/x.txt\n+++ b/src/x.txt\n@@\n one\n-two\n+TWO\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(true);
    expect(v.normalizedDiff).toContain("@@ -2,2 +2,2 @@");
    expect(v.conflicts).toHaveLength(0);
  });

  it("re-anchors a stale modify hunk by exact unique preimage", () => {
    write("src/x.txt", "header\none\ntwo\nfooter\n");
    const diff = "--- a/src/x.txt\n+++ b/src/x.txt\n@@ -50,2 +50,2 @@ stale\n one\n-two\n+TWO\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(true);
    expect(v.normalizedDiff).toContain("@@ -2,2 +2,2 @@");
    expect(v.conflicts).toHaveLength(0);
  });

  it("keeps an ambiguous shorthand modify hunk rejected", () => {
    write("src/x.txt", "one\ntwo\none\ntwo\n");
    const diff = "--- a/src/x.txt\n+++ b/src/x.txt\n@@\n one\n-two\n+TWO\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(false);
    expect(v.reasons[0]?.code).toBe("malformed");
    expect(v.reasons[0]?.message).toContain("no unique anchor");
  });

  it("does not normalize already valid hunks that contain header-like body lines", () => {
    write("doc.md", "context\n-- removed dashes\n");
    const diff =
      "--- a/doc.md\n" +
      "+++ b/doc.md\n" +
      "@@ -1,2 +1,2 @@\n" +
      " context\n" +
      "--- removed dashes\n" +
      "+++ added dashes\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(true);
    expect(v.normalizedDiff).toBeUndefined();
  });

  it("rejects an in-workspace symlink alias before it can rewrite the real target", () => {
    write("src/add.ts", "export const add = () => 1;\n");
    symlinkSync(join(root, "src"), join(root, "tests"));
    const diff =
      "--- a/tests/add.ts\n+++ b/tests/add.ts\n@@ -1,1 +1,2 @@\n export const add = () => 1;\n+export const injected = true;\n";
    const validation = validatePatch(info, diff);
    expect(validation.ok).toBe(false);
    expect(validation.reasons.map((reason) => reason.code)).toContain("path-denied");
    expect(JSON.stringify(validation)).not.toContain(root);
    expect(() => applyPatch(info, diff, { applyEnabled: true, signal: liveSignal() })).toThrow(
      PatchValidationError,
    );
    expect(read("src/add.ts")).toBe("export const add = () => 1;\n");
  });

  it("rejects a hard-linked alias before it can rewrite a denied workspace target", () => {
    write(".env", "SECRET=1\n");
    mkdirSync(join(root, "src"), { recursive: true });
    linkSync(join(root, ".env"), join(root, "src", "alias.env"));
    const diff =
      "--- a/src/alias.env\n+++ b/src/alias.env\n@@ -1,1 +1,1 @@\n-SECRET=1\n+SECRET=2\n";
    const validation = validatePatch(info, diff);
    expect(validation.ok).toBe(false);
    expect(validation.reasons.map((reason) => reason.code)).toContain("path-denied");
    expect(() => applyPatch(info, diff, { applyEnabled: true, signal: liveSignal() })).toThrow(
      PatchValidationError,
    );
    expect(read(".env")).toBe("SECRET=1\n");
  });

  it("rejects a hard-linked alias before it can rewrite an out-of-workspace target", () => {
    const outside = makeWorkspace();
    try {
      writeFileSync(join(outside.root, "victim.txt"), "one\ntwo\n", "utf8");
      mkdirSync(join(root, "src"), { recursive: true });
      linkSync(join(outside.root, "victim.txt"), join(root, "src", "alias.txt"));
      const diff =
        "--- a/src/alias.txt\n+++ b/src/alias.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+PWNED\n";
      const validation = validatePatch(info, diff);
      expect(validation.ok).toBe(false);
      expect(validation.reasons.map((reason) => reason.code)).toContain("path-denied");
      expect(() => applyPatch(info, diff, { applyEnabled: true, signal: liveSignal() })).toThrow(
        PatchValidationError,
      );
      expect(readFileSync(join(outside.root, "victim.txt"), "utf8")).toBe("one\ntwo\n");
    } finally {
      rmSync(outside.root, { recursive: true, force: true });
    }
  });
});

describe("renderDryRun", () => {
  it("previews an OK patch and writes nothing", () => {
    write("src/x.txt", "one\ntwo\n");
    const before = read("src/x.txt");
    const preview = renderDryRun(validatePatch(info, MODIFY_DIFF));
    expect(preview).toContain("PATCH OK");
    expect(preview).toContain("modify src/x.txt");
    expect(read("src/x.txt")).toBe(before);
  });

  it("previews a rejected patch with the reason", () => {
    const preview = renderDryRun(
      validatePatch(info, "--- /dev/null\n+++ b/.env\n@@ -0,0 +1,1 @@\n+S=1\n"),
    );
    expect(preview).toContain("PATCH REJECTED");
    expect(preview).toContain("path-denied");
  });
});

describe("projectValidatedPatch", () => {
  it("renders only the selected files from a fully validated patch", () => {
    write("src/a.txt", "A0\n");
    write("src/b.txt", "B0\n");
    const diffA = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-A0\n+A1\n";
    const diffB = "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1 +1 @@\n-B0\n+B1\n";
    const validation = validatePatch(info, diffA + diffB);

    const projected = projectValidatedPatch(validation, ["./src/b.txt"]);

    expect(projected).not.toContain("src/a.txt");
    expect(projected).toContain("src/b.txt");
    expect(validatePatch(info, projected).ok).toBe(true);
  });

  it("fails closed for invalid source validation and invalid selections", () => {
    write("src/a.txt", "A0\n");
    const diff = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-A0\n+A1\n";
    const validation = validatePatch(info, diff);
    const invalid = validatePatch(info, "not a patch");

    expect(() => projectValidatedPatch(invalid, ["src/a.txt"])).toThrow(PatchValidationError);
    expect(() => projectValidatedPatch(validation, [])).toThrow(PatchValidationError);
    expect(() => projectValidatedPatch(validation, ["src/missing.txt"])).toThrow(
      PatchValidationError,
    );
    expect(() => projectValidatedPatch(validation, ["src/a.txt", "./src/a.txt"])).toThrow(
      PatchValidationError,
    );
  });
});

describe("applyPatch — fail-closed", () => {
  it("throws PatchApplyDisabledError and writes nothing when applyEnabled is false", () => {
    write("src/x.txt", "one\ntwo\n");
    const before = read("src/x.txt");
    expect(() =>
      applyPatch(info, MODIFY_DIFF, { applyEnabled: false, signal: liveSignal() }),
    ).toThrow(PatchApplyDisabledError);
    expect(read("src/x.txt")).toBe(before);
  });

  it("applies a valid modify and reports changed files when enabled", () => {
    write("src/x.txt", "one\ntwo\n");
    const result = applyPatch(info, MODIFY_DIFF, { applyEnabled: true, signal: liveSignal() });
    expect(result.changedFiles).toEqual(["src/x.txt"]);
    expect(read("src/x.txt")).toBe("one\nTWO\n");
  });

  it("creates a new file", () => {
    const result = applyPatch(info, CREATE_DIFF, { applyEnabled: true, signal: liveSignal() });
    expect(result.created).toEqual(["src/new.txt"]);
    expect(read("src/new.txt")).toBe("created\n");
  });

  it("applies normal create, modify, and delete changes in one transaction", () => {
    write("src/x.txt", "one\ntwo\n");
    write("src/old.txt", "old\n");

    const result = applyPatch(info, MODIFY_DIFF + CREATE_DIFF + DELETE_DIFF, {
      applyEnabled: true,
      signal: liveSignal(),
    });

    expect(result.changedFiles).toEqual(["src/x.txt", "src/new.txt", "src/old.txt"]);
    expect(result.created).toEqual(["src/new.txt"]);
    expect(result.deleted).toEqual(["src/old.txt"]);
    expect(read("src/x.txt")).toBe("one\nTWO\n");
    expect(read("src/new.txt")).toBe("created\n");
    expect(existsSync(join(root, "src/old.txt"))).toBe(false);
  });

  it("throws PatchValidationError on an invalid patch and writes nothing", () => {
    write("src/x.txt", "DIFFERENT\n");
    expect(() =>
      applyPatch(info, MODIFY_DIFF, { applyEnabled: true, signal: liveSignal() }),
    ).toThrow(PatchValidationError);
    expect(read("src/x.txt")).toBe("DIFFERENT\n");
  });

  it("preserves conflict details on PatchValidationError", () => {
    write("src/x.txt", "DIFFERENT\n");
    try {
      applyPatch(info, MODIFY_DIFF, { applyEnabled: true, signal: liveSignal() });
      throw new Error("applyPatch should reject the conflicting patch");
    } catch (error) {
      expect(error).toBeInstanceOf(PatchValidationError);
      expect((error as PatchValidationError).conflicts).toHaveLength(1);
      expect((error as PatchValidationError).conflicts[0]?.path).toBe("src/x.txt");
    }
  });

  it("throws PatchValidationError with conflicts for a conflict-only failure", () => {
    write("src/new.txt", "already here\n");
    let caught: unknown;
    try {
      applyPatch(info, CREATE_DIFF, { applyEnabled: true, signal: liveSignal() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PatchValidationError);
    expect((caught as PatchValidationError).reasons).toHaveLength(0);
    expect((caught as PatchValidationError).conflicts).toHaveLength(1);
    expect((caught as PatchValidationError).conflicts[0]?.path).toBe("src/new.txt");
  });

  it("refuses to write after abort (no partial state)", () => {
    write("src/x.txt", "one\ntwo\n");
    const ctrl = new AbortController();
    ctrl.abort();
    expect(() =>
      applyPatch(info, MODIFY_DIFF, { applyEnabled: true, signal: ctrl.signal }),
    ).toThrow(CommandCancelledError);
    expect(read("src/x.txt")).toBe("one\ntwo\n");
  });

  it("rolls back already-written files when the signal aborts mid-apply", () => {
    write("src/a.txt", "A0\n");
    write("src/b.txt", "B0\n");
    const diffA = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,1 +1,1 @@\n-A0\n+A1\n";
    const diffB = "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,1 +1,1 @@\n-B0\n+B1\n";
    const ctrl = new AbortController();
    const writes: string[] = [];
    const writer = {
      writeFileUtf8: (abs: string, content: string): void => {
        writes.push(`${abs}:${content}`);
        if (abs.endsWith("a.txt")) {
          ctrl.abort();
        }
        writeFileSync(abs, content, "utf8");
      },
      mkdirp: (): void => {
        // The files already exist for this regression.
      },
      remove: (abs: string): void => {
        writes.push(`rm:${abs}`);
        rmSync(abs, { force: true });
      },
      rename: (): void => {
        // Not used by applyPatch.
      },
    };
    expect(() =>
      applyPatch(info, diffA + diffB, {
        applyEnabled: true,
        signal: ctrl.signal,
        writer,
      }),
    ).toThrow(CommandCancelledError);
    expect(read("src/a.txt")).toBe("A0\n");
    expect(read("src/b.txt")).toBe("B0\n");
    expect(writes).toContain(`${join(root, "src/a.txt")}:A1\n`);
    expect(writes).toContain(`${join(root, "src/a.txt")}:A0\n`);
    expect(writes.some((line) => line === `${join(root, "src/b.txt")}:B1\n`)).toBe(false);
  });
});

describe("applyPatch — multi-file atomicity (rollback)", () => {
  it("rolls back the first write when a later write fails", () => {
    write("src/a.txt", "A0\n");
    write("src/b.txt", "B0\n");
    const diffA = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,1 +1,1 @@\n-A0\n+A1\n";
    const diffB = "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,1 +1,1 @@\n-B0\n+B1\n";
    const failOn = join(root, "src/b.txt");
    const rec = recordingWriter(failOn);
    expect(() =>
      applyPatch(info, diffA + diffB, {
        applyEnabled: true,
        signal: liveSignal(),
        writer: rec.writer,
      }),
    ).toThrow(PatchApplyError);
    // a.txt was restored to its original buffered content during rollback.
    const restoredA = rec.writes().filter((w) => w.path === join(root, "src/a.txt"));
    expect(restoredA.at(-1)?.content).toBe("A0\n");
  });

  it("rolls back and stops when cancellation is requested during the write phase", () => {
    write("src/a.txt", "A0\n");
    write("src/b.txt", "B0\n");
    const diffA = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,1 +1,1 @@\n-A0\n+A1\n";
    const diffB = "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,1 +1,1 @@\n-B0\n+B1\n";
    const ctrl = new AbortController();
    const writes: { path: string; content: string }[] = [];
    const writer = {
      writeFileUtf8: (absPath: string, content: string): void => {
        writes.push({ path: absPath, content });
        if (absPath === join(root, "src/a.txt") && content === "A1\n") {
          ctrl.abort();
        }
      },
      mkdirp: (absPath: string): void => {
        writes.push({ path: absPath, content: "mkdir" });
      },
      remove: (absPath: string): void => {
        writes.push({ path: absPath, content: "remove" });
      },
      rename: (fromAbsolute: string, toAbsolute: string): void => {
        writes.push({ path: fromAbsolute, content: `rename:${toAbsolute}` });
      },
    };

    expect(() =>
      applyPatch(info, diffA + diffB, {
        applyEnabled: true,
        signal: ctrl.signal,
        writer,
      }),
    ).toThrow(CommandCancelledError);
    expect(writes.map((w) => [w.path, w.content])).toEqual([
      [join(root, "src"), "mkdir"],
      [join(root, "src/a.txt"), "A1\n"],
      [join(root, "src/a.txt"), "A0\n"],
    ]);
  });
});
