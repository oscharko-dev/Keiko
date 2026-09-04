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
//
//   Two layers make that claim hold for EVERY table, not only the ones listed by hand below:
//   1. The "every table" sweep enumerates the tables from `sqlite_master` after migration and
//      scans every column of every table for the forbidden substrings. A migration that creates
//      a new table cannot escape it, because nothing in this file has to be updated for the sweep
//      to see the table (PR #3394 finding: `github_issue_reader_authorization` shipped with a
//      schema comment citing this test while no assertion here introspected it, so adding
//      `api_key` and `provider_endpoint` columns left the suite green).
//   2. The table inventory and the per-table exact column sets force a conscious review of every
//      new table and column — content-class fields that carry no forbidden substring in their
//      name (`raw_prompt`, `manifest_bytes`) are caught by a human reading this file, not by a
//      pattern.

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
  "grounded_answer_json",
  "grounded_preview_citations_json",
  "assistant_response_versions_json",
  // V12 stores only the scoped digest and lifecycle state of an opaque client turn identity.
  "client_turn_id",
  "client_turn_state",
  "client_turn_content_digest",
]);

const ALLOWED_CODING_RUNTIME_SNAPSHOT_COLUMNS = new Set([
  "run_id",
  "schema_version",
  "state",
  "revision",
  "requested_mode",
  "runtime_source",
  "model_source",
  "failure_code",
  "created_at",
  "updated_at",
  "terminal_at",
  "recovery_acknowledged_at",
  "predecessor_run_id",
  "task_digest",
  "workspace_digest",
  "operator_digest",
  "authority_digest",
  "binding_digest",
  "provenance_digest",
  "tool_call_count",
  "patch_byte_count",
  "model_request_count",
  "recovery_handle",
  "result_status",
  "exit_code",
  "stdout_byte_count",
  "stdout_line_count",
  "stdout_sha256",
  "stdout_truncated",
  "stderr_byte_count",
  "stderr_line_count",
  "stderr_sha256",
  "stderr_truncated",
]);

// V11 (issue #2521) persisted workspace-trust records. Content-free by construction: an opaque
// derived reference, a revision, a closed trust enum, the contract-validated record JSON, and a
// timestamp. No paths, no manifest bytes, no credential-class fields.
const ALLOWED_WORKSPACE_TRUST_COLUMNS = new Set([
  "root_ref",
  "revision",
  "trust",
  "record_json",
  "updated_at",
]);

// V21 (issue #3385, epic #3384) repository-scoped GitHub issue reader authorization. The row is a
// content-free repository identity, a boolean grant, a monotonic revision, and a timestamp. The
// credential keeps coming from the `gh` CLI boundary and never touches this table.
const ALLOWED_GITHUB_ISSUE_READER_AUTHORIZATION_COLUMNS = new Set([
  "repository_id",
  "authorized",
  "revision",
  "updated_at",
]);

// Every user table the migrations create, by name. A migration that adds a table must add it here
// (and, for a credential-adjacent table, an exact column set above) so its columns are reviewed
// consciously. The sweep below does NOT depend on this list — it reads `sqlite_master` — so a
// table missing here still fails the forbidden-substring scan; this pin only guarantees the
// human review happens too.
const EXPECTED_TABLES = new Set([
  "chat_messages",
  "chats",
  "coding_runtime_snapshots",
  "github_issue_reader_authorization",
  "memory_autonomy_policy",
  "projects",
  "relationship_audit_entries",
  "relationship_lifecycle_history",
  "relationships",
  "task_workspace_active_pointer",
  "task_workspace_instances",
  "workspace_manifest_roots",
  "workspace_manifests",
  "workspace_trust_records",
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

interface SqliteMasterRow {
  readonly name: string;
}

// Every user table in the migrated database, read from the catalog rather than from any list in
// this file. SQLite's own bookkeeping tables (`sqlite_sequence`, `sqlite_stat*`) are excluded:
// they are not created by a migration and cannot carry a credential-class column.
function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as SqliteMasterRow[]
  )
    .map((r) => r.name)
    .filter((name) => !name.startsWith("sqlite_"));
}

// Runs every migration through the real store, then reopens the on-disk file read-only so the
// schema is introspected exactly as it exists on disk, not through the store's public surface.
function openMigratedSchema(dbPath: string): DatabaseSync {
  const store = createNodeUiStore(dbPath);
  store.close();
  return new DatabaseSync(dbPath, { readOnly: true });
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

  it("coding runtime snapshots are content-free and have no process or credential fields", () => {
    const dbPath = join(tmpDir, "runtime.db");
    const store = createNodeUiStore(dbPath);
    store.close();
    const inspector = new DatabaseSync(dbPath, { readOnly: true });
    const cols = columnNames(inspector, "coding_runtime_snapshots");
    inspector.close();
    expect(new Set(cols)).toEqual(ALLOWED_CODING_RUNTIME_SNAPSHOT_COLUMNS);
    for (const col of cols) {
      const lower = col.toLowerCase();
      for (const forbidden of [
        ...FORBIDDEN_SUBSTRINGS,
        "prompt",
        "output",
        "diff",
        "path",
        "argv",
        "env",
        "approval",
      ]) {
        expect(lower).not.toContain(forbidden);
      }
    }
  });

  it("workspace trust records are content-free and carry no path, manifest, or credential fields", () => {
    const dbPath = join(tmpDir, "trust.db");
    const store = createNodeUiStore(dbPath);
    store.close();
    const inspector = new DatabaseSync(dbPath, { readOnly: true });
    const cols = columnNames(inspector, "workspace_trust_records");
    inspector.close();
    expect(new Set(cols)).toEqual(ALLOWED_WORKSPACE_TRUST_COLUMNS);
    for (const col of cols) {
      const lower = col.toLowerCase();
      for (const forbidden of [
        ...FORBIDDEN_SUBSTRINGS,
        "prompt",
        "output",
        "diff",
        "manifest",
        "package",
        "argv",
        "env",
      ]) {
        expect(lower).not.toContain(forbidden);
      }
    }
  });

  it("github issue reader authorization rows are content-free and carry no credential, path, or remote fields", () => {
    const dbPath = join(tmpDir, "github-authorization.db");
    const inspector = openMigratedSchema(dbPath);
    const cols = columnNames(inspector, "github_issue_reader_authorization");
    inspector.close();
    expect(new Set(cols)).toEqual(ALLOWED_GITHUB_ISSUE_READER_AUTHORIZATION_COLUMNS);
    for (const col of cols) {
      const lower = col.toLowerCase();
      // `repository_id` is a derived identity: never a path, a remote URL, or an owner/name pair.
      for (const forbidden of [...FORBIDDEN_SUBSTRINGS, "path", "url", "remote", "owner"]) {
        expect(lower).not.toContain(forbidden);
      }
    }
  });
});

describe("forbidden-fields — every table in the migrated store (AC#5 / ADR-0013 D8)", () => {
  it("creates exactly the expected tables, so a new table is reviewed before it ships", () => {
    const dbPath = join(tmpDir, "inventory.db");
    const inspector = openMigratedSchema(dbPath);
    const tables = tableNames(inspector);
    inspector.close();
    expect(new Set(tables)).toEqual(EXPECTED_TABLES);
  });

  it("has no credential-class column in any table enumerated from sqlite_master", () => {
    const dbPath = join(tmpDir, "sweep.db");
    const inspector = openMigratedSchema(dbPath);
    const tables = tableNames(inspector);
    // A sweep over zero tables would be vacuously green; the store must have migrated something.
    expect(tables.length).toBeGreaterThan(0);

    // Collect `<table>.<column>` for every offending column so a failure names every leak at once
    // rather than stopping at the first one. Column names are schema identifiers, not content.
    const offenders = tables.flatMap((table) =>
      columnNames(inspector, table)
        .filter((col) => FORBIDDEN_SUBSTRINGS.some((f) => col.toLowerCase().includes(f)))
        .map((col) => `${table}.${col}`),
    );
    inspector.close();
    expect(offenders).toEqual([]);
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
