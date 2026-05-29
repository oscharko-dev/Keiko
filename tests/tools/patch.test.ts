import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch, renderDryRun, validatePatch } from "../../src/tools/patch.js";
import {
  CommandCancelledError,
  PatchApplyDisabledError,
  PatchApplyError,
  PatchValidationError,
} from "../../src/tools/errors.js";
import { makeWorkspace, recordingWriter } from "./_support.js";
import type { WorkspaceInfo } from "../../src/workspace/types.js";

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

  it("accepts a valid modify against matching content", () => {
    write("src/x.txt", "one\ntwo\n");
    const v = validatePatch(info, MODIFY_DIFF);
    expect(v.ok).toBe(true);
    expect(v.reasons).toHaveLength(0);
    expect(v.conflicts).toHaveLength(0);
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

  it("throws PatchValidationError on an invalid patch and writes nothing", () => {
    write("src/x.txt", "DIFFERENT\n");
    expect(() =>
      applyPatch(info, MODIFY_DIFF, { applyEnabled: true, signal: liveSignal() }),
    ).toThrow(PatchValidationError);
    expect(read("src/x.txt")).toBe("DIFFERENT\n");
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
});
