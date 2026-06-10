// ADR-0013 D4 — resolveUiDbPath precedence: explicit → KEIKO_UI_DATA_DIR/keiko-ui.db → ~/.keiko/keiko-ui.db.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { assertUiDbOutsideProject, resolveUiDbPath, UiStoreError } from "./index.js";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-paths-"));
  cleanup.push(dir);
  return dir;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UiStoreError);
    expect((e as UiStoreError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code}`);
}

describe("resolveUiDbPath", () => {
  it("prefers an explicit path when supplied", () => {
    const dbPath = join(makeTempDir(), "x.db");
    expect(resolveUiDbPath(dbPath, { KEIKO_UI_DATA_DIR: "/ignored" })).toBe(dbPath);
  });

  it("uses KEIKO_UI_DATA_DIR + keiko-ui.db when no explicit value", () => {
    const dataDir = makeTempDir();
    expect(resolveUiDbPath(undefined, { KEIKO_UI_DATA_DIR: dataDir })).toBe(
      join(dataDir, "keiko-ui.db"),
    );
  });

  it("falls back to ~/.keiko/keiko-ui.db when neither is set", () => {
    expect(resolveUiDbPath(undefined, {})).toBe(join(homedir(), ".keiko", "keiko-ui.db"));
  });

  it("treats an empty explicit string as not set", () => {
    const dataDir = makeTempDir();
    expect(resolveUiDbPath("", { KEIKO_UI_DATA_DIR: dataDir })).toBe(join(dataDir, "keiko-ui.db"));
  });

  it("treats an empty env value as not set", () => {
    expect(resolveUiDbPath(undefined, { KEIKO_UI_DATA_DIR: "" })).toBe(
      join(homedir(), ".keiko", "keiko-ui.db"),
    );
  });

  it("rejects a relative explicit path", () => {
    expectCode(() => resolveUiDbPath("keiko-ui.db", {}), "invalid_request");
  });

  it("rejects a relative KEIKO_UI_DATA_DIR value", () => {
    expectCode(() => resolveUiDbPath(undefined, { KEIKO_UI_DATA_DIR: "." }), "invalid_request");
  });

  it("rejects an explicit database path inside the current workspace", () => {
    expectCode(() => resolveUiDbPath(join(process.cwd(), "keiko-ui.db"), {}), "invalid_request");
  });

  it("allows the gitignored workspace .keiko runtime root", () => {
    const runtimeDir = join(process.cwd(), ".keiko", "ui");
    expect(resolveUiDbPath(undefined, { KEIKO_UI_DATA_DIR: runtimeDir })).toBe(
      join(runtimeDir, "keiko-ui.db"),
    );
  });

  it("rejects a symlinked data directory", () => {
    if (process.platform === "win32") return;
    const target = makeTempDir();
    const link = join(makeTempDir(), "data-link");
    symlinkSync(target, link, "dir");
    expectCode(() => resolveUiDbPath(undefined, { KEIKO_UI_DATA_DIR: link }), "invalid_request");
  });

  it("rejects an explicit path containing NUL bytes (CWE-22 parity with memory-vault)", () => {
    expectCode(() => resolveUiDbPath("/tmp/legit\0/etc/passwd", {}), "invalid_request");
  });

  it("rejects a KEIKO_UI_DATA_DIR value containing NUL bytes (CWE-22 parity)", () => {
    expectCode(
      () => resolveUiDbPath(undefined, { KEIKO_UI_DATA_DIR: "/tmp/legit\0/etc" }),
      "invalid_request",
    );
  });
});

describe("assertUiDbOutsideProject", () => {
  it("rejects a UI DB path inside a selected project outside process.cwd()", () => {
    const project = join(makeTempDir(), "repo");
    const dbPath = join(project, "state", "keiko-ui.db");
    expect(project.startsWith(process.cwd())).toBe(false);
    expectCode(() => {
      assertUiDbOutsideProject(dbPath, project);
    }, "invalid_request");
  });

  it("allows a selected project to contain its own .keiko runtime UI DB", () => {
    const project = makeTempDir();
    const dbPath = join(project, ".keiko", "ui", "keiko-ui.db");
    expect(() => {
      assertUiDbOutsideProject(dbPath, project);
    }).not.toThrow();
  });

  it("rejects a selected project inside the UI DB directory", () => {
    const dbPath = join(makeTempDir(), "app-data", "keiko-ui.db");
    const project = join(dirname(dbPath), "repo");
    expectCode(() => {
      assertUiDbOutsideProject(dbPath, project);
    }, "invalid_request");
  });

  it("allows disjoint UI DB and project paths", () => {
    const dbPath = join(makeTempDir(), "app-data", "keiko-ui.db");
    const project = join(makeTempDir(), "repo");
    expect(() => {
      assertUiDbOutsideProject(dbPath, project);
    }).not.toThrow();
  });
});
