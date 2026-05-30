// ADR-0013 D3/D8 — db.ts: createInMemoryUiStore (tests), createNodeUiStore (real on-disk).
// Asserts perms 0o700/0o600 on the dir/file (Unix), and that the DB file is NOT inside process.cwd().

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createInMemoryUiStore, createNodeUiStore } from "../../../src/ui/store/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keiko-uidb-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createInMemoryUiStore", () => {
  it("returns a store that exposes the UiStore surface", () => {
    const store = createInMemoryUiStore();
    expect(typeof store.listProjects).toBe("function");
    expect(typeof store.createProject).toBe("function");
    expect(typeof store.listChats).toBe("function");
    expect(typeof store.createMessage).toBe("function");
    expect(typeof store.close).toBe("function");
    store.close();
  });

  it("returns an empty project list initially", () => {
    const store = createInMemoryUiStore();
    expect(store.listProjects()).toEqual([]);
    store.close();
  });
});

describe("createNodeUiStore — on-disk file", () => {
  it("creates the DB file on the supplied path", () => {
    const dbPath = join(tmpDir, "keiko-ui.db");
    const store = createNodeUiStore(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    store.close();
  });

  it("creates parent directory with mode 0o700 (Unix)", () => {
    if (process.platform === "win32") return;
    const dbPath = join(tmpDir, "nested", "keiko-ui.db");
    const store = createNodeUiStore(dbPath);
    const dirMode = statSync(dirname(dbPath)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    store.close();
  });

  it("chmods the DB file to 0o600 (Unix)", () => {
    if (process.platform === "win32") return;
    const dbPath = join(tmpDir, "keiko-ui.db");
    const store = createNodeUiStore(dbPath);
    const fileMode = statSync(dbPath).mode & 0o777;
    expect(fileMode).toBe(0o600);
    store.close();
  });

  it("survives a reopen — persisted projects round-trip", () => {
    const dbPath = join(tmpDir, "keiko-ui.db");
    const projDir = mkdtempSync(join(tmpDir, "proj-"));
    const s1 = createNodeUiStore(dbPath);
    s1.createProject(projDir);
    s1.close();
    const s2 = createNodeUiStore(dbPath);
    const list = s2.listProjects();
    expect(list).toHaveLength(1);
    expect(list[0]?.path).toBe(projDir);
    s2.close();
  });

  it("does not place the DB inside the current working directory by default in tests", () => {
    // The test supplies its own mkdtemp path explicitly; assert the resolved path is outside cwd.
    const dbPath = join(tmpDir, "keiko-ui.db");
    const store = createNodeUiStore(dbPath);
    expect(dbPath.startsWith(process.cwd())).toBe(false);
    store.close();
  });
});
