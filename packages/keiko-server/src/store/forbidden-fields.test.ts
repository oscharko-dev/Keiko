// B.2 — AC#5: Provider details and secrets are structurally absent from the SQLite schema.
//
// WHY this test exists:
//   ADR-0013 D8 states that the UI-local SQLite store persists only UI state (project paths, chat
//   metadata, message content, run status). It must NEVER persist API keys, base URLs, provider
//   names, deployment identifiers, or any form of credential. The store uses STRICT tables with a
//   fixed column list, making forbidden fields structurally impossible to add without a migration.
//
//   This test is the machine-readable proof of that invariant. It introspects the real on-disk DB
//   via `PRAGMA table_info` after `createNodeUiStore` runs all migrations, asserts the EXACT
//   allowed column set for each table (from schema.ts), and then asserts that none of the
//   forbidden substrings appear in any column name.
//
//   MUTATION ROBUSTNESS: if any migration adds an `api_key`, `base_url`, `provider`,
//   `deployment`, `secret`, `token`, `endpoint`, `azure`, or `credential` column to any table,
//   this test will fail. The exact-column-set assertions also catch unexpected column additions
//   even when the column name does not match a forbidden substring pattern.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeUiStore } from "./index.js";

// ── Allowed column sets (source of truth: src/ui/store/schema.ts) ──────────
// These sets are intentionally replicated verbatim from the schema rather than
// derived at runtime so that a schema change that adds a column forces this test
// to be updated consciously — not silently accepted.

const ALLOWED_PROJECTS_COLUMNS = new Set([
  "path",
  "name",
  "favorite",
  "created_at",
  "last_opened_at",
]);

const ALLOWED_CHATS_COLUMNS = new Set([
  "id",
  "project_path",
  "title",
  "selected_model",
  "branch_label",
  "status",
  // V3 adds connected_scope_paths + connected_scope_at (issue #184 additive migration).
  "connected_scope_paths",
  "connected_scope_at",
  // Issue #200 persists the local knowledge scope selection on the chat row.
  "local_knowledge_scope_json",
  "created_at",
  "updated_at",
]);

// V2 adds task_type (issue #66 additive migration).
const ALLOWED_CHAT_MESSAGES_COLUMNS = new Set([
  "id",
  "chat_id",
  "role",
  "content",
  "timestamp",
  "run_id",
  "workflow_id",
  "workflow_status",
  "short_result",
  "task_type",
]);

// ── Forbidden substring patterns (case-insensitive) ─────────────────────────
// Any column whose name contains one of these substrings leaks a credential-class
// field into the UI DB in violation of ADR-0013 D8.
const FORBIDDEN_SUBSTRINGS = [
  "api_key",
  "apikey",
  "base_url",
  "baseurl",
  "provider",
  "deployment",
  "secret",
  "token",
  "endpoint",
  "azure",
  "credential",
] as const;

interface PragmaRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as PragmaRow[]).map(
    (r) => r.name,
  );
}

let tmpDir: string;
let projDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keiko-forbidden-"));
  projDir = mkdtempSync(join(tmpDir, "proj-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("forbidden-fields — schema column set (AC#5 / ADR-0013 D8)", () => {
  it("projects table has exactly the allowed columns and no forbidden ones", () => {
    const dbPath = join(tmpDir, "test.db");
    const store = createNodeUiStore(dbPath);
    store.close();

    // Open a separate read-only DatabaseSync to introspect the on-disk schema without going
    // through the store's public surface (which does not expose PRAGMA).
    const inspector = new DatabaseSync(dbPath, { readOnly: true });

    const cols = columnNames(inspector, "projects");
    inspector.close();

    // Exact set assertion — unexpected columns fail this test even if they're not forbidden.
    expect(new Set(cols)).toEqual(ALLOWED_PROJECTS_COLUMNS);

    // Forbidden-substring assertion — belt-and-suspenders.
    for (const col of cols) {
      const lower = col.toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(lower).not.toContain(forbidden);
      }
    }
  });

  it("chats table has exactly the allowed columns and no forbidden ones", () => {
    const dbPath = join(tmpDir, "test.db");
    const store = createNodeUiStore(dbPath);
    store.close();

    const inspector = new DatabaseSync(dbPath, { readOnly: true });
    const cols = columnNames(inspector, "chats");
    inspector.close();

    expect(new Set(cols)).toEqual(ALLOWED_CHATS_COLUMNS);

    for (const col of cols) {
      const lower = col.toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(lower).not.toContain(forbidden);
      }
    }
  });

  it("chat_messages table has exactly the allowed columns and no forbidden ones", () => {
    const dbPath = join(tmpDir, "test.db");
    const store = createNodeUiStore(dbPath);
    store.close();

    const inspector = new DatabaseSync(dbPath, { readOnly: true });
    const cols = columnNames(inspector, "chat_messages");
    inspector.close();

    expect(new Set(cols)).toEqual(ALLOWED_CHAT_MESSAGES_COLUMNS);

    for (const col of cols) {
      const lower = col.toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(lower).not.toContain(forbidden);
      }
    }
  });
});

describe("forbidden-fields — Chat object shape (AC#5 / ADR-0013 D8)", () => {
  // Proves that the Chat TypeScript object returned by the store's public surface carries
  // no credential-class properties — even if a future code change incorrectly mapped a
  // stored column to a camelCase credential key.
  it("createChat returns a Chat with no forbidden camelCase properties", () => {
    const dbPath = join(tmpDir, "shape.db");
    const store = createNodeUiStore(dbPath);

    store.createProject(projDir);
    const chat = store.createChat(projDir, "Secret test", "example-chat-model-fast");
    store.close();

    const chatKeys = Object.keys(chat);

    const forbiddenCamelCase = [
      "apiKey",
      "baseUrl",
      "provider",
      "deployment",
      "secret",
      "token",
      "endpoint",
      "azure",
      "credential",
    ];
    for (const forbidden of forbiddenCamelCase) {
      expect(chatKeys).not.toContain(forbidden);
    }
  });

  it("selectedModel on a reloaded Chat is the bare registry id, not a provider-enriched object", () => {
    // A regression guard: if selectedModel were ever changed to store a JSON blob containing
    // {id, provider, apiKey, ...}, this test would catch the type-level drift before it ships.
    const dbPath = join(tmpDir, "model.db");
    const s1 = createNodeUiStore(dbPath);

    s1.createProject(projDir);
    s1.createChat(projDir, "Model check", "example-chat-model-fast");
    s1.close();

    const s2 = createNodeUiStore(dbPath);
    const chats = s2.listChats(projDir);
    s2.close();

    expect(chats).toHaveLength(1);
    const reloadedChat = chats[0];
    // selectedModel must be the plain string registry id — a JSON-encoded object would start with '{'.
    expect(typeof reloadedChat?.selectedModel).toBe("string");
    expect(reloadedChat?.selectedModel).toBe("example-chat-model-fast");
    expect(reloadedChat?.selectedModel.startsWith("{")).toBe(false);
  });
});
