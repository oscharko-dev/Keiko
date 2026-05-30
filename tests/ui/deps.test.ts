import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRedactor, buildUiHandlerDeps } from "../../src/ui/deps.js";
import { createInMemoryUiStore } from "../../src/ui/store/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

describe("buildRedactor", () => {
  it("scrubs non-pattern secret values from sensitive environment variables", () => {
    const secret = "CORPSECRET_123456789";
    const redactor = buildRedactor({ KEIKO_DEFAULT_API_KEY: secret });
    expect(redactor({ message: `token=${secret}` })).toEqual({ message: "token=[REDACTED]" });
  });
});

describe("buildUiHandlerDeps — UiStore wiring (ADR-0013)", () => {
  it("uses the injected store unchanged when supplied", () => {
    const store = createInMemoryUiStore();
    const evidenceDir = tmp("ev-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {},
      store,
    });
    expect(deps.store).toBe(store);
  });

  it("creates a node store at uiDbPath when no store is injected", () => {
    const uiDir = tmp("ui-");
    const evidenceDir = tmp("ev-");
    const dbPath = join(uiDir, "keiko-ui.db");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: {},
      uiDbPath: dbPath,
    });
    expect(deps.store).toBeDefined();
    expect(deps.store.listProjects()).toEqual([]);
    deps.store.close();
  });

  it("resolves the DB path via KEIKO_UI_DATA_DIR when no explicit path is supplied", () => {
    const uiDir = tmp("ui-env-");
    const evidenceDir = tmp("ev-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_UI_DATA_DIR: uiDir },
    });
    expect(deps.store).toBeDefined();
    expect(deps.store.listProjects()).toEqual([]);
    deps.store.close();
  });
});
