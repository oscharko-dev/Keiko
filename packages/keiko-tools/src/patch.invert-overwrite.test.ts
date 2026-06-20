// Issue #1204 — invertPatch (guarded revert proposal) and the allowOverwrite apply option.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch, invertPatch, validatePatch } from "./patch.js";
import { PatchValidationError } from "./errors.js";
import { makeWorkspace } from "./_support.js";
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

const CREATE_DIFF = "--- /dev/null\n+++ b/src/new.test.ts\n@@ -0,0 +1,1 @@\n+created\n";
const MODIFY_DIFF = "--- a/src/x.txt\n+++ b/src/x.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";

describe("invertPatch", () => {
  it("inverts a create into a delete", () => {
    const inverse = invertPatch(CREATE_DIFF);
    expect(inverse).toContain("--- a/src/new.test.ts");
    expect(inverse).toContain("+++ /dev/null");
    expect(inverse).toContain("-created");
  });

  it("inverts a modify by swapping +/- markers", () => {
    const inverse = invertPatch(MODIFY_DIFF);
    expect(inverse).toContain("-TWO");
    expect(inverse).toContain("+two");
    expect(inverse).toContain(" one");
  });

  it("apply(diff) then apply(invert(diff)) restores the original create (round-trip)", () => {
    applyPatch(info, CREATE_DIFF, { applyEnabled: true, signal: liveSignal() });
    expect(read("src/new.test.ts")).toBe("created\n");
    applyPatch(info, invertPatch(CREATE_DIFF), { applyEnabled: true, signal: liveSignal() });
    expect(existsSync(join(root, "src/new.test.ts"))).toBe(false);
  });

  it("apply(diff) then apply(invert(diff)) restores a modified file", () => {
    write("src/x.txt", "one\ntwo\n");
    applyPatch(info, MODIFY_DIFF, { applyEnabled: true, signal: liveSignal() });
    expect(read("src/x.txt")).toBe("one\nTWO\n");
    applyPatch(info, invertPatch(MODIFY_DIFF), { applyEnabled: true, signal: liveSignal() });
    expect(read("src/x.txt")).toBe("one\ntwo\n");
  });
});

describe("allowOverwrite apply option (AC7/AC14)", () => {
  it("rejects a create whose target already exists by default (no silent overwrite)", () => {
    write("src/new.test.ts", "existing\n");
    const v = validatePatch(info, CREATE_DIFF);
    expect(v.ok).toBe(false);
    expect(v.conflicts.map((c) => c.reason)).toContain("create target already exists");
  });

  it("permits the overwrite only when allowOverwrite is set", () => {
    write("src/new.test.ts", "existing\n");
    const v = validatePatch(info, CREATE_DIFF, { allowOverwrite: true });
    expect(v.ok).toBe(true);
  });

  it("applyPatch refuses to overwrite an existing file without confirmation", () => {
    write("src/new.test.ts", "existing\n");
    expect(() =>
      applyPatch(info, CREATE_DIFF, { applyEnabled: true, signal: liveSignal() }),
    ).toThrow(PatchValidationError);
    expect(read("src/new.test.ts")).toBe("existing\n");
  });

  it("applyPatch overwrites an existing file when allowOverwrite is set", () => {
    write("src/new.test.ts", "existing\n");
    applyPatch(info, CREATE_DIFF, {
      applyEnabled: true,
      signal: liveSignal(),
      allowOverwrite: true,
    });
    expect(read("src/new.test.ts")).toBe("created\n");
  });
});
