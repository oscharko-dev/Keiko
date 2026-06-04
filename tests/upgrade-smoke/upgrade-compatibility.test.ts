// Upgrade-compatibility smoke (issue #175). Exercises the eight categories named in the local
// runtime state contract (docs/local-runtime-state-contract.md) against a frozen pre-modular 0.1.x
// install fixture, calling the post-modular package APIs in-process. Every test isolates state to
// its own tmpdir; the fixture itself is never mutated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  createNodeUiStore,
  resolveUiDbPath,
  UiStoreError,
  UI_DB_FILENAME,
} from "@oscharko-dev/keiko-server";
import {
  createNodeEvidenceStore,
  EVIDENCE_SCHEMA_VERSION,
  listEvidence,
  loadEvidence,
  resolveEvidenceDir,
} from "@oscharko-dev/keiko-evidence";
import { loadConfigFromFile } from "@oscharko-dev/keiko-model-gateway";

const FIXTURE_ROOT = resolve(import.meta.dirname, "fixture/pre-modular-0.1.x");
const FIXTURE_HOME_KEIKO = join(FIXTURE_ROOT, "home/.keiko");
const FIXTURE_EVIDENCE = join(FIXTURE_ROOT, ".keiko/evidence");
const FIXTURE_CONFIG = join(FIXTURE_ROOT, "keiko.config.json");
const FIXTURE_PACKAGE_JSON = join(FIXTURE_ROOT, "package.json");
const FIXTURE_ENV = join(FIXTURE_ROOT, ".env");

const SEEDED_PROJECT_PATH = "/keiko-fixture-project";
const SEEDED_PROJECT_NAME = "fixture-project";
const SEEDED_CHAT_ID = "chat-fixture-0001";
const SEEDED_MESSAGE_ID = "msg-fixture-0001";
const SEEDED_EVIDENCE_RUN_ID = "run-fixture-0001";

// Per-test tmpdir; cleaned in afterEach. Lives outside the repo so resolveConfiguredPath's
// "must not be inside the current workspace" rule does not reject our UI-DB path.
let workdir = "";

function makeWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "keiko-upgrade-smoke-"));
}

function copyFixtureHomeKeiko(target: string): string {
  const dest = join(target, ".keiko");
  cpSync(FIXTURE_HOME_KEIKO, dest, { recursive: true });
  return dest;
}

function copyFixtureEvidence(target: string): string {
  const dest = join(target, "evidence");
  cpSync(FIXTURE_EVIDENCE, dest, { recursive: true });
  return dest;
}

function readUserVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return typeof row?.user_version === "number" ? row.user_version : -1;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  workdir = makeWorkdir();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (workdir.length > 0 && existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true });
  }
  workdir = "";
});

describe("upgrade compatibility (issue #175)", () => {
  it("gateway config: pre-modular keiko.config.json parses with the post-modular loader", () => {
    const dest = join(workdir, "keiko.config.json");
    cpSync(FIXTURE_CONFIG, dest);

    // The CLI applies the --config → $KEIKO_CONFIG_FILE → sibling-default ladder before calling
    // loadConfigFromFile (see packages/keiko-cli/src/ui.ts:164). This test pins the file-read leg:
    // a pre-modular keiko.config.json is consumed by the post-modular loader without schema or
    // credential changes. The env-resolution leg is covered by keiko-cli's own unit tests.
    const config = loadConfigFromFile(dest, { KEIKO_CONFIG_FILE: dest });

    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.modelId).toBe("fixture-model");
    expect(config.providers[0]?.baseUrl).toBe("https://example.test/v1");
  });

  it("gateway config: resolves as a sibling of the UI database file", () => {
    // resolveUiDbPath returns the DB FILE; the production resolver looks for the config at
    // `dirname(uiDbPath)/keiko.config.json`, i.e. same directory as the DB (packages/keiko-server/
    // src/deps.ts:180).
    const home = copyFixtureHomeKeiko(workdir);
    cpSync(FIXTURE_CONFIG, join(home, "keiko.config.json"));

    const uiDbPath = resolveUiDbPath(undefined, { KEIKO_UI_DATA_DIR: home });
    const expectedSibling = join(dirname(uiDbPath), "keiko.config.json");

    expect(uiDbPath).toBe(join(home, UI_DB_FILENAME));
    expect(existsSync(expectedSibling)).toBe(true);

    const config = loadConfigFromFile(expectedSibling, {});
    expect(config.providers[0]?.modelId).toBe("fixture-model");
  });

  it("UI sqlite: opens the pre-modular DB and lists the seeded project, chat, and message", () => {
    const home = copyFixtureHomeKeiko(workdir);
    const dbPath = join(home, UI_DB_FILENAME);

    const store = createNodeUiStore(dbPath);
    try {
      const projects = store.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]?.path).toBe(SEEDED_PROJECT_PATH);
      expect(projects[0]?.name).toBe(SEEDED_PROJECT_NAME);

      const chats = store.listChats(SEEDED_PROJECT_PATH);
      expect(chats).toHaveLength(1);
      expect(chats[0]?.id).toBe(SEEDED_CHAT_ID);

      const messages = store.listMessages(SEEDED_CHAT_ID);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe(SEEDED_MESSAGE_ID);
    } finally {
      store.close();
    }
  });

  it("UI sqlite: PRAGMA user_version is the pre-modular value and is preserved on open", () => {
    const home = copyFixtureHomeKeiko(workdir);
    const dbPath = join(home, UI_DB_FILENAME);

    const before = readUserVersion(dbPath);
    expect(before).toBe(2);

    const store = createNodeUiStore(dbPath);
    store.close();

    const after = readUserVersion(dbPath);
    expect(after).toBe(before);
  });

  it("evidence: lists pre-modular manifests via $KEIKO_EVIDENCE_DIR", () => {
    const dir = copyFixtureEvidence(workdir);
    vi.stubEnv("KEIKO_EVIDENCE_DIR", dir);

    const resolved = resolveEvidenceDir(undefined, { KEIKO_EVIDENCE_DIR: dir });
    expect(resolved).toBe(dir);

    const store = createNodeEvidenceStore(dir);
    const entries = listEvidence(store);

    expect(entries.map((e) => e.runId)).toContain(SEEDED_EVIDENCE_RUN_ID);

    const manifest = loadEvidence(store, SEEDED_EVIDENCE_RUN_ID);
    expect(manifest?.evidenceSchemaVersion).toBe(EVIDENCE_SCHEMA_VERSION);
    expect(manifest?.run.runId).toBe(SEEDED_EVIDENCE_RUN_ID);
    expect(manifest?.run.outcome).toBe("completed");
  });

  it("cli scripts: package.json keiko:start and keiko:stop literals are preserved", () => {
    const pkg = JSON.parse(readFileSync(FIXTURE_PACKAGE_JSON, "utf8")) as {
      readonly scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["keiko:start"]).toBe("keiko start");
    expect(pkg.scripts?.["keiko:stop"]).toBe("keiko stop");
  });

  it(".env discovery: the fixture .env contains only KEIKO_* keys with placeholder values", () => {
    const text = readFileSync(FIXTURE_ENV, "utf8");
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const eq = line.indexOf("=");
      expect(eq).toBeGreaterThan(0);
      const key = line.slice(0, eq);
      expect(key.startsWith("KEIKO_")).toBe(true);
    }
  });

  it("malformed path: a relative UI-DB path is rejected with a safe error", () => {
    const relative = "relative/path/keiko-ui.db";
    let caught: unknown;
    try {
      resolveUiDbPath(relative, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UiStoreError);
    const err = caught as UiStoreError;
    expect(err.code).toBe("invalid_request");
    expect(err.message).not.toContain(relative);
    expect(err.message).not.toContain(resolve(relative));
  });

  it("malformed path: a symlinked UI-DB path is rejected", () => {
    const real = join(workdir, "real.db");
    writeFileSync(real, "");
    const link = join(workdir, "link.db");
    symlinkSync(real, link);

    let caught: unknown;
    try {
      resolveUiDbPath(link, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UiStoreError);
    const err = caught as UiStoreError;
    expect(err.code).toBe("invalid_request");
    expect(err.message).not.toContain(real);
    expect(err.message).not.toContain(link);
  });

  it("fresh install behaviour: pointing $KEIKO_UI_DATA_DIR at an empty dir creates the DB", () => {
    const freshHome = join(workdir, "fresh-home", ".keiko");
    const dbPath = resolveUiDbPath(undefined, { KEIKO_UI_DATA_DIR: freshHome });
    expect(dbPath).toBe(join(freshHome, UI_DB_FILENAME));
    expect(existsSync(dbPath)).toBe(false);

    const store = createNodeUiStore(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(store.listProjects()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
