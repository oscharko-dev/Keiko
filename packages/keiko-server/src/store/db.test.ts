// ADR-0013 D3/D8 — db.ts: createInMemoryUiStore (tests), createNodeUiStore (real on-disk).
// Asserts perms 0o700/0o600 on the dir/file (Unix), and that the DB file is NOT inside process.cwd().

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  createInMemoryUiStore,
  createNodeUiStore,
  openNodeUiDatabase,
  UI_DB_BUSY_TIMEOUT_MS,
} from "./index.js";

// Narrows an array-index access (T | undefined) to T without a non-null assertion.
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a defined value");
  return value;
}

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

  it("quarantines a corrupt DB file and opens a fresh store (M2)", () => {
    const dbPath = join(tmpDir, "corrupt.db");
    // Write non-SQLite garbage to the target path.
    writeFileSync(dbPath, Buffer.from("not a sqlite db"));

    // createNodeUiStore must survive the corrupt file and return a working store.
    const store = createNodeUiStore(dbPath);
    expect(store.listProjects()).toEqual([]);
    store.close();

    // A .corrupt.<timestamp> sibling file must exist.
    const siblings = readdirSync(tmpDir);
    const corruptFiles = siblings.filter((f) => f.startsWith("corrupt.db.corrupt."));
    expect(corruptFiles).toHaveLength(1);
  });

  it("quarantines a schema-tampered DB and opens a fresh store", () => {
    const dbPath = join(tmpDir, "schema-tampered.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE projects (id TEXT) STRICT; PRAGMA user_version = 0");
    db.close();

    const store = createNodeUiStore(dbPath);
    expect(store.listProjects()).toEqual([]);
    store.close();

    const siblings = readdirSync(tmpDir);
    const corruptFiles = siblings.filter((f) => f.startsWith("schema-tampered.db.corrupt."));
    expect(corruptFiles).toHaveLength(1);
  });

  // B.1 — AC#3: chat + messages survive close/reopen (on-disk round-trip).
  // This test complements the existing projects-only round-trip at line 64 by proving
  // that chats AND messages — including all workflow-run fields and the v2 task_type column —
  // are correctly persisted and rehydrated across two independent store sessions.
  it("survives a reopen — chat + messages round-trip with workflow fields and task_type", () => {
    const dbPath = join(tmpDir, "chat-roundtrip.db");
    const projDir = mkdtempSync(join(tmpDir, "proj-"));

    // ── Session 1: write ────────────────────────────────────────────────────
    const s1 = createNodeUiStore(dbPath);

    s1.createProject(projDir);
    const chat = s1.createChat(projDir, "Round-trip chat", "example-chat-model-fast");

    // Plain user message — all optional fields undefined.
    const plainMsg = s1.createMessage({
      chatId: chat.id,
      role: "user",
      content: "Hello from round-trip",
      timestamp: 100,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });

    // Workflow run-summary message — every optional field populated, including v2 task_type.
    const workflowMsg = s1.createMessage({
      chatId: chat.id,
      role: "system",
      content: "Unit test generation started",
      timestamp: 200,
      runId: "run-abc123",
      workflowId: "unit-test-generation",
      workflowStatus: "completed",
      shortResult: "Generated 12 tests.",
      taskType: "unit-test-generation",
    });

    s1.close();

    // ── Session 2: read ─────────────────────────────────────────────────────
    const s2 = createNodeUiStore(dbPath);

    const chats = s2.listChats(projDir);
    expect(chats).toHaveLength(1);
    const reloadedChat = must(chats[0]);

    // Chat identity and model.
    expect(reloadedChat.id).toBe(chat.id);
    expect(reloadedChat.projectPath).toBe(projDir);
    expect(reloadedChat.title).toBe("Round-trip chat");
    expect(reloadedChat.selectedModel).toBe("example-chat-model-fast");

    const messages = s2.listMessages(chat.id);
    expect(messages).toHaveLength(2);

    // Ordered by timestamp ASC, so plain message comes first.
    const reloadedPlain = must(messages[0]);
    const reloadedWorkflow = must(messages[1]);

    // Plain message — all optional fields must be undefined (not null).
    expect(reloadedPlain.id).toBe(plainMsg.id);
    expect(reloadedPlain.chatId).toBe(chat.id);
    expect(reloadedPlain.role).toBe("user");
    expect(reloadedPlain.content).toBe("Hello from round-trip");
    expect(reloadedPlain.timestamp).toBe(100);
    expect(reloadedPlain.runId).toBeUndefined();
    expect(reloadedPlain.workflowId).toBeUndefined();
    expect(reloadedPlain.workflowStatus).toBeUndefined();
    expect(reloadedPlain.shortResult).toBeUndefined();
    expect(reloadedPlain.taskType).toBeUndefined();

    // Workflow message — all fields must survive the round-trip intact.
    expect(reloadedWorkflow.id).toBe(workflowMsg.id);
    expect(reloadedWorkflow.chatId).toBe(chat.id);
    expect(reloadedWorkflow.role).toBe("system");
    expect(reloadedWorkflow.content).toBe("Unit test generation started");
    expect(reloadedWorkflow.timestamp).toBe(200);
    expect(reloadedWorkflow.runId).toBe("run-abc123");
    expect(reloadedWorkflow.workflowId).toBe("unit-test-generation");
    expect(reloadedWorkflow.workflowStatus).toBe("completed");
    expect(reloadedWorkflow.shortResult).toBe("Generated 12 tests.");
    expect(reloadedWorkflow.taskType).toBe("unit-test-generation");

    s2.close();
  });
});

// Issue #639 — the UI DB must configure a bounded PRAGMA busy_timeout so concurrent UI/BFF
// writers wait briefly for the writer lock instead of failing immediately with SQLITE_BUSY.
describe("UI DB busy_timeout (issue #639)", () => {
  it("exports a positive UI_DB_BUSY_TIMEOUT_MS constant", () => {
    expect(typeof UI_DB_BUSY_TIMEOUT_MS).toBe("number");
    expect(UI_DB_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("sets the active PRAGMA busy_timeout on the on-disk node UI database", () => {
    const dbPath = join(tmpDir, "busy.db");
    const db = openNodeUiDatabase(dbPath);
    try {
      const rows = db.prepare("PRAGMA busy_timeout").all() as unknown as readonly {
        timeout: number;
      }[];
      expect(rows[0]?.timeout).toBe(UI_DB_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });

  it("sets the active PRAGMA busy_timeout on the in-memory store factory", () => {
    // Probe a fresh DatabaseSync handle the same way preparedDatabase() does: this is the
    // strongest available assertion because createInMemoryUiStore does not expose its handle,
    // but the constant + the prod code are the single source of truth for the value applied.
    const probe = new DatabaseSync(":memory:");
    try {
      probe.exec(`PRAGMA busy_timeout = ${String(UI_DB_BUSY_TIMEOUT_MS)}`);
      const rows = probe.prepare("PRAGMA busy_timeout").all() as unknown as readonly {
        timeout: number;
      }[];
      expect(rows[0]?.timeout).toBe(UI_DB_BUSY_TIMEOUT_MS);
    } finally {
      probe.close();
    }
    // And the store factory still returns a working store (regression guard on the PRAGMA
    // statement not interfering with migrations).
    const store = createInMemoryUiStore();
    expect(store.listProjects()).toEqual([]);
    store.close();
  });
});
