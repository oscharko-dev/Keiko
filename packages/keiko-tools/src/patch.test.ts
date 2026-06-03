import { linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch, renderDryRun, validatePatch } from "./patch.js";
import {
  CommandCancelledError,
  PatchApplyDisabledError,
  PatchApplyError,
  PatchValidationError,
} from "./errors.js";
import { makeWorkspace, recordingWriter } from "./_support.js";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";

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
