import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryEvidenceStore,
  createNodeEvidenceStore,
  resolveEvidenceDir,
} from "./store.js";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { EvidenceReadError, EvidenceWriteError, InvalidRunIdError } from "./errors.js";

// A runId whose filename (<runId>.json) would exceed the 255-byte POSIX limit.
// 251 chars + ".json" (5) = 256 > 255. The runId itself passes the assertValidRunId charset check
// (all "a"s, length 251 <= 256) but the resulting filename is too long for the filesystem.
const OVER_LONG_RUN_ID = "a".repeat(251);

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

  it("updates an existing manifest through one serialized callback", () => {
    const store = createInMemoryEvidenceStore();
    store.put("run-1", '["a"]');
    expect(store.update?.("run-1", (existing) => `${existing ?? "[]"}+b`)).toBe("run-1.json");
    expect(store.get("run-1")).toBe('["a"]+b');
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

  it("updates an existing manifest without leaving lock files behind", () => {
    const dir = freshDir();
    const store = createNodeEvidenceStore(dir);
    store.put("run-1", "[1]");
    expect(store.update?.("run-1", (existing) => `${existing ?? "[]"},2`)).toMatch(/run-1\.json$/);
    expect(store.get("run-1")).toBe("[1],2");
    expect(store.list()).toEqual(["run-1"]);
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

  it("rejects a runId whose filename would exceed the POSIX 255-byte limit (CWE-209 regression)", () => {
    // OVER_LONG_RUN_ID (251 chars) passes assertValidRunId charset/length checks but
    // <runId>.json (256 bytes) exceeds the fs limit → must throw InvalidRunIdError
    // with NO absolute path in the message, before any filesystem call occurs.
    const store = createNodeEvidenceStore(freshDir());
    let thrown: unknown;
    try {
      store.get(OVER_LONG_RUN_ID);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidRunIdError);
    const message = (thrown as InvalidRunIdError).message;
    // The message must not contain any path separator — a leaked absolute path would contain "/" or "\"
    expect(message).not.toMatch(/[/\\]/);
  });

  it("throws EvidenceWriteError when the base dir cannot be created under a file", () => {
    const parent = freshDir();
    const filePath = join(parent, "afile");
    writeFileSync(filePath, "x");
    const store = createNodeEvidenceStore(join(filePath, "evidence"));
    expect(() => store.put("run-1", "{}")).toThrow(EvidenceWriteError);
  });

  it("wraps read failures as EvidenceReadError instead of leaking raw filesystem errors", () => {
    const parent = freshDir();
    const filePath = join(parent, "afile");
    writeFileSync(filePath, "x");
    const store = createNodeEvidenceStore(filePath);
    expect(() => store.list()).toThrow(EvidenceReadError);
  });

  it("does not create the evidence directory for read-only list/get operations", () => {
    const parent = freshDir();
    const missing = join(parent, "missing-evidence");
    const store = createNodeEvidenceStore(missing);
    expect(store.list()).toEqual([]);
    expect(store.get("run-1")).toBeUndefined();
    expect(existsSync(missing)).toBe(false);
  });

  it("ignores hardlinked manifest-looking files for list/get/delete", () => {
    const base = freshDir();
    const outside = freshDir();
    const victim = join(outside, "victim.json");
    const hardlink = join(base, "run-1.json");
    writeFileSync(victim, '{"evidenceSchemaVersion":"1"}');
    linkSync(victim, hardlink);
    const store = createNodeEvidenceStore(base);
    expect(store.list()).toEqual([]);
    expect(store.get("run-1")).toBeUndefined();
    expect(() => {
      store.delete("run-1");
    }).not.toThrow();
    expect(readFileSync(victim, "utf8")).toBe('{"evidenceSchemaVersion":"1"}');
    expect(existsSync(hardlink)).toBe(true);
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
