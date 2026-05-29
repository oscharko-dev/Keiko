import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryEvidenceStore,
  createNodeEvidenceStore,
  resolveEvidenceDir,
} from "../../src/audit/store.js";
import { nodeWorkspaceFs } from "../../src/workspace/fs.js";
import { EvidenceWriteError } from "../../src/audit/errors.js";
import { InvalidRunIdError } from "../../src/audit/errors.js";

describe("resolveEvidenceDir — precedence (C4)", () => {
  it("prefers the explicit value over env and default", () => {
    expect(resolveEvidenceDir("/explicit", { KEIKO_EVIDENCE_DIR: "/env" })).toBe("/explicit");
  });

  it("falls back to KEIKO_EVIDENCE_DIR when no explicit value", () => {
    expect(resolveEvidenceDir(undefined, { KEIKO_EVIDENCE_DIR: "/env" })).toBe("/env");
  });

  it("falls back to the workspace-relative default when neither is set", () => {
    expect(resolveEvidenceDir(undefined, {})).toBe("./.keiko/evidence");
    expect(resolveEvidenceDir(undefined, undefined)).toBe("./.keiko/evidence");
  });
});

describe("createInMemoryEvidenceStore", () => {
  it("round-trips put/get/list/delete deterministically", () => {
    const store = createInMemoryEvidenceStore();
    expect(store.list()).toEqual([]);
    store.put("b-run", '{"v":"b"}');
    store.put("a-run", '{"v":"a"}');
    expect(store.list()).toEqual(["a-run", "b-run"]); // sorted
    expect(store.get("a-run")).toBe('{"v":"a"}');
    expect(store.get("missing")).toBeUndefined();
    store.delete("a-run");
    expect(store.list()).toEqual(["b-run"]);
    expect(() => {
      store.delete("missing");
    }).not.toThrow(); // no-op
  });

  it("rejects an invalid runId on put and delete", () => {
    const store = createInMemoryEvidenceStore();
    expect(() => store.put("../escape", "{}")).toThrow(InvalidRunIdError);
    expect(() => {
      store.delete("a/b");
    }).toThrow(InvalidRunIdError);
  });
});

describe("createNodeEvidenceStore", () => {
  const dirs: string[] = [];
  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "keiko-audit-store-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes atomically and reads back the exact bytes", () => {
    const store = createNodeEvidenceStore(freshDir());
    const path = store.put("run-1", '{"hello":"world"}');
    expect(path.endsWith("run-1.json")).toBe(true);
    expect(store.get("run-1")).toBe('{"hello":"world"}');
    expect(store.list()).toEqual(["run-1"]);
  });

  it("leaves no stray temp files after a put", () => {
    const dir = freshDir();
    const store = createNodeEvidenceStore(dir);
    store.put("run-1", "{}");
    expect(store.list()).toEqual(["run-1"]); // only the final <runId>.json, no *.tmp
  });

  it("rejects an invalid runId before any write", () => {
    const store = createNodeEvidenceStore(freshDir());
    expect(() => store.put("../escape", "{}")).toThrow(InvalidRunIdError);
  });

  it("never follows a symlink in the base dir when listing", () => {
    const dir = freshDir();
    const outside = freshDir();
    const secret = join(outside, "secret.json");
    writeFileSync(secret, '{"secret":true}');
    symlinkSync(secret, join(dir, "link.json"));
    const store = createNodeEvidenceStore(dir);
    // link.json is not a valid runId form anyway; the lister only returns real <runId>.json files.
    expect(store.list()).not.toContain("link");
    expect(store.get("secret")).toBeUndefined();
  });

  it("get returns undefined for an absent runId and an invalid runId throws", () => {
    const store = createNodeEvidenceStore(freshDir());
    expect(store.get("absent")).toBeUndefined();
    expect(() => store.get("../escape")).toThrow(InvalidRunIdError);
  });

  it("throws EvidenceWriteError when the base dir cannot be created under a file", () => {
    const parent = freshDir();
    const filePath = join(parent, "afile");
    writeFileSync(filePath, "x");
    expect(() => createNodeEvidenceStore(join(filePath, "evidence"))).toThrow(EvidenceWriteError);
  });

  it("refuses to write through a pre-planted symlink at the temp path (O_EXCL, L1)", () => {
    const base = freshDir();
    const outside = freshDir();
    const victim = join(outside, "victim.json");
    writeFileSync(victim, "ORIGINAL");
    // A deterministic suffix makes the temp path predictable so an attacker could pre-plant it.
    const store = createNodeEvidenceStore(base, nodeWorkspaceFs, () => "fixed");
    symlinkSync(victim, join(base, "run-1.json.fixed.tmp"));
    // O_EXCL ("wx") refuses to open through the existing symlink → the put fails, never writing out.
    expect(() => store.put("run-1", '{"evil":true}')).toThrow(EvidenceWriteError);
    expect(readFileSync(victim, "utf8")).toBe("ORIGINAL");
  });
});
