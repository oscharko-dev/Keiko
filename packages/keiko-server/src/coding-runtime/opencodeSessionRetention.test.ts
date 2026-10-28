import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { OPENCODE_PERSISTENCE_SCHEMAS } from "./opencodePersistenceContract.js";
import {
  auditDatabase,
  createRetainedSessionStore,
  RETAINED_SESSION_LIMITS,
  type RetainedSessionLimits,
  retainedSessionKey,
  type RetainedSessionBinding,
  type RetainedSessionSource,
  type RetainedSessionStore,
} from "./opencodeSessionRetention.js";

const SESSION_ID = "ses_retained_1";
const WORKSPACE = "/work/space";
const VERSION = "2.1.4";
const NOW = 1_800_000_000_000;
const WORKSPACE_KEY = createHash("sha256").update("workspace").digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-retained-session-"));
  roots.push(root);
  return root;
}

interface RuntimeDatabaseOptions {
  /** Rows to add to the tables a retained copy must not carry. */
  readonly rows?: Readonly<Record<string, number>>;
  readonly session?: Readonly<Record<string, unknown>>;
  readonly extraSessions?: number;
  readonly messages?: number;
  /** Tables the runtime of this fixture does not have. */
  readonly without?: readonly string[];
  /** Schema changes applied after the runtime's own tables exist (a drift control). */
  readonly alter?: string;
}

/**
 * A database with the pinned runtime's persistence contract: every table and column its
 * migrations create, untyped and unconstrained. The real runtime's own database is audited in
 * `opencodeNativeSessionResume.real.test.ts`.
 */
function runtimeDatabase(path: string, options: RuntimeDatabaseOptions = {}): void {
  const database = new DatabaseSync(path);
  try {
    createTables(database, options.without ?? []);
    if (options.alter !== undefined) database.exec(options.alter);
    insertSession(database, SESSION_ID, options.session ?? {});
    for (let index = 0; index < (options.extraSessions ?? 0); index += 1) {
      insertSession(database, `ses_extra_${String(index)}`, {});
    }
    for (let index = 0; index < (options.messages ?? 3); index += 1) {
      database
        .prepare("INSERT INTO session_message (id, session_id, data) VALUES (?, ?, ?)")
        .run(`msg_${String(index)}`, SESSION_ID, `SECRET-CONVERSATION-${String(index)}`);
    }
    insertRows(database, options.rows ?? {});
  } finally {
    database.close();
  }
}

function createTables(database: DatabaseSync, without: readonly string[]): void {
  const contract = OPENCODE_PERSISTENCE_SCHEMAS[VERSION] ?? {};
  for (const [table, columns] of Object.entries(contract)) {
    if (without.includes(table)) continue;
    database.exec(`CREATE TABLE "${table}" (${columns.map((name) => `"${name}"`).join(", ")})`);
  }
}

function insertRows(database: DatabaseSync, rows: Readonly<Record<string, number>>): void {
  for (const [table, count] of Object.entries(rows)) {
    for (let index = 0; index < count; index += 1) {
      database.prepare(`INSERT INTO "${table}" DEFAULT VALUES`).run();
    }
  }
}

function insertSession(
  database: DatabaseSync,
  id: string,
  overrides: Readonly<Record<string, unknown>>,
): void {
  const row = {
    id,
    directory: WORKSPACE,
    version: VERSION,
    parent_id: null,
    workspace_id: null,
    permission: null,
    revert: null,
    time_archived: null,
    time_suspended: null,
    ...overrides,
  };
  database
    .prepare(
      `INSERT INTO session_v2 (id, directory, version, parent_id, workspace_id, permission, revert,
         time_archived, time_suspended) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.directory,
      row.version,
      row.parent_id as string | null,
      row.workspace_id as string | null,
      row.permission as string | null,
      row.revert as string | null,
      row.time_archived as number | null,
      row.time_suspended as number | null,
    );
}

function binding(overrides: Partial<RetainedSessionBinding> = {}): RetainedSessionBinding {
  return {
    taskId: "task-1",
    workspaceKey: WORKSPACE_KEY,
    runtimeVersion: VERSION,
    maxInputTokens: 24_000,
    ...overrides,
  };
}

interface Fixture {
  readonly root: string;
  readonly storeRoot: string;
  readonly source: string;
  readonly store: RetainedSessionStore;
  clock: { value: number };
}

function fixture(
  database: RuntimeDatabaseOptions = {},
  limits?: Partial<RetainedSessionLimits>,
): Fixture {
  const root = tempRoot();
  const storeRoot = join(root, "retained");
  const source = join(root, "run", "state", "opencode.db");
  mkdirSync(join(root, "run", "state"), { recursive: true });
  runtimeDatabase(source, database);
  const clock = { value: NOW };
  return {
    root,
    storeRoot,
    source,
    clock,
    store: createRetainedSessionStore({ root: storeRoot, now: () => clock.value, limits }),
  };
}

function retain(
  f: Fixture,
  overrides: Partial<RetainedSessionBinding> = {},
): ReturnType<RetainedSessionStore["retain"]> {
  return f.store.retain({
    binding: binding(overrides),
    sessionId: SESSION_ID,
    directory: WORKSPACE,
    sourceDatabase: f.source,
  });
}

function checkout(
  f: Fixture,
  overrides: Partial<RetainedSessionBinding> = {},
  directory = WORKSPACE,
): { readonly destination: string; readonly result: ReturnType<RetainedSessionStore["checkout"]> } {
  const destination = join(f.root, `restored-${String(Math.random()).slice(2)}.db`);
  return {
    destination,
    result: f.store.checkout({
      binding: binding(overrides),
      directory,
      destinationDatabase: destination,
    }),
  };
}

function entryNames(f: Fixture): readonly string[] {
  return existsSync(f.storeRoot) ? readdirSync(f.storeRoot).sort() : [];
}

function entryDirectory(f: Fixture, taskId = "task-1"): string {
  return join(f.storeRoot, retainedSessionKey(taskId));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("retaining a settled run's session state", () => {
  it("keeps a compacted, audited copy bound to the task and reports counts only", () => {
    const f = fixture();

    const result = retain(f);

    expect(result).toMatchObject({ ok: true, messageCount: 3, entryCount: 1, prunedCount: 0 });
    expect(entryNames(f)).toEqual([retainedSessionKey("task-1")]);
    const manifest = JSON.parse(
      readFileSync(join(entryDirectory(f), "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      taskId: "task-1",
      workspaceKey: WORKSPACE_KEY,
      runtimeVersion: VERSION,
      sessionId: SESSION_ID,
      maxInputTokens: 24_000,
      retainedAtMs: NOW,
    });
    expect(manifest.databaseSha256).toBe(sha256(join(entryDirectory(f), "opencode.db")));
    // Nothing of the conversation, the workspace path or an id outside the manifest is in it.
    expect(JSON.stringify(manifest)).not.toContain("SECRET-CONVERSATION");
    expect(JSON.stringify(manifest)).not.toContain(WORKSPACE);
    expect(statSync(entryDirectory(f)).mode & 0o077).toBe(0);
    expect(statSync(join(entryDirectory(f), "opencode.db")).mode & 0o077).toBe(0);
  });

  it("only reads the source database and replaces an existing entry of the task as a whole", () => {
    const f = fixture();
    const before = sha256(f.source);
    expect(retain(f)).toMatchObject({ ok: true });
    const first = sha256(join(entryDirectory(f), "opencode.db"));

    f.clock.value += 1_000;
    runtimeDatabase(join(f.root, "second.db"), { messages: 5 });
    const second = f.store.retain({
      binding: binding(),
      sessionId: SESSION_ID,
      directory: WORKSPACE,
      sourceDatabase: join(f.root, "second.db"),
    });

    expect(sha256(f.source)).toBe(before);
    expect(second).toMatchObject({ ok: true, messageCount: 5, entryCount: 1 });
    expect(entryNames(f)).toHaveLength(1);
    expect(sha256(join(entryDirectory(f), "opencode.db"))).not.toBe(first);
  });

  it("retains what a write-ahead log of a live writer still holds", () => {
    const f = fixture();
    const writer = new DatabaseSync(f.source);
    try {
      writer.exec("PRAGMA journal_mode=WAL");
      writer.exec(
        `INSERT INTO session_message (id, session_id, data) VALUES ('msg_wal', '${SESSION_ID}', 'only in the log')`,
      );

      expect(retain(f)).toMatchObject({ ok: true, messageCount: 4 });
    } finally {
      writer.close();
    }
  });

  it("retains only committed WAL state while another connection holds a write transaction", () => {
    const f = fixture();
    const writer = new DatabaseSync(f.source);
    try {
      writer.exec("PRAGMA journal_mode=WAL");
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare("INSERT INTO session_message (id, session_id, data) VALUES (?, ?, ?)")
        .run("msg_uncommitted", SESSION_ID, "UNCOMMITTED-CONTENT");

      expect(retain(f)).toMatchObject({ ok: true, messageCount: 3 });
      expect(checkout(f).result).toMatchObject({ ok: true, messageCount: 3 });
      writer.exec("COMMIT");
      expect(retain(f)).toMatchObject({ ok: true, messageCount: 4 });
      expect(checkout(f).result).toMatchObject({ ok: true, messageCount: 4 });
    } finally {
      writer.close();
    }
  });

  it("preserves the previous entry on an exclusive database lock and recovers after release", () => {
    const f = fixture();
    expect(retain(f)).toMatchObject({ ok: true });
    const previousDatabase = sha256(join(entryDirectory(f), "opencode.db"));
    const previousManifest = sha256(join(entryDirectory(f), "manifest.json"));
    const writer = new DatabaseSync(f.source);
    try {
      writer.exec("PRAGMA journal_mode=DELETE");
      writer.exec("BEGIN EXCLUSIVE");
      expect(() => retain(f)).toThrow(expect.objectContaining({ errcode: 5 }));
      expect(sha256(join(entryDirectory(f), "opencode.db"))).toBe(previousDatabase);
      expect(sha256(join(entryDirectory(f), "manifest.json"))).toBe(previousManifest);
      expect(entryNames(f)).toEqual([retainedSessionKey("task-1")]);
      expect(checkout(f).result).toMatchObject({ ok: true, messageCount: 3 });
    } finally {
      writer.close();
    }
    expect(retain(f)).toMatchObject({ ok: true, messageCount: 3 });
  });

  it.each([
    ["a saved permission grant", { rows: { permission: 1 } }, "grant-present"],
    [
      "a session permission ruleset",
      { session: { permission: '[{"action":"*"}]' } },
      "grant-present",
    ],
    ["a credential", { rows: { credential: 1 } }, "credential-present"],
    ["an account", { rows: { account: 1 } }, "credential-present"],
    ["a control account", { rows: { control_account: 1 } }, "credential-present"],
    ["a queued input", { rows: { session_pending: 1 } }, "pending-input"],
    ["an inbox entry", { rows: { session_inbox: 1 } }, "pending-input"],
    ["a suspended session", { session: { time_suspended: 5 } }, "pending-input"],
    ["a staged undo", { session: { revert: '{"messageID":"msg_1"}' } }, "revert-staged"],
    ["key-value state", { rows: { kv: 1 } }, "schema-unknown", "kv-rows"],
    ["a remote workspace", { rows: { workspace: 1 } }, "schema-unknown", "workspace-rows"],
    ["another workspace directory", { session: { directory: "/elsewhere" } }, "session-mismatch"],
    ["another runtime version", { session: { version: "2.0.10" } }, "session-mismatch"],
    ["a child session", { session: { parent_id: "ses_parent" } }, "session-mismatch"],
    ["an archived session", { session: { time_archived: 4 } }, "session-mismatch"],
    ["a second session", { extraSessions: 1 }, "session-mismatch"],
    ["an unknown schema", { without: ["permission"] }, "schema-unknown", "audit-unreadable"],
    // #3908 AC4: a schema beyond the producer's persistence contract is state no check examined.
    [
      "a table the runtime does not create, with a row",
      { alter: 'CREATE TABLE "extra_state" ("value"); INSERT INTO "extra_state" VALUES (1);' },
      "schema-unknown",
      "schema-drift",
    ],
    [
      "an empty table the runtime does not create",
      { alter: 'CREATE TABLE "extra_state" ("value");' },
      "schema-unknown",
      "schema-drift",
    ],
    [
      "a session column the runtime does not create",
      { alter: "ALTER TABLE session_v2 ADD COLUMN extra_grant;" },
      "schema-unknown",
      "schema-drift",
    ],
    [
      "a session column the runtime creates removed",
      { alter: "ALTER TABLE session_v2 DROP COLUMN resume_attempts;" },
      "schema-unknown",
      "schema-drift",
    ],
    [
      "a runtime table removed that no other check reads",
      { without: ["instruction_state"] },
      "schema-unknown",
      "schema-drift",
    ],
    [
      "a view",
      { alter: "CREATE VIEW extra_view AS SELECT id FROM session_v2;" },
      "schema-unknown",
      "schema-drift",
    ],
    [
      "a trigger",
      { alter: "CREATE TRIGGER extra_trigger AFTER INSERT ON kv BEGIN SELECT 1; END;" },
      "schema-unknown",
      "schema-drift",
    ],
  ] as const)("refuses a database that carries %s", (_name, database, reason, check?: string) => {
    const f = fixture(database);

    const result = retain(f);

    // A `schema-unknown` refusal names the audit check that failed (#3904), never content.
    expect(result).toEqual({ ok: false, reason, ...(check === undefined ? {} : { check }) });
    expect(entryNames(f)).toEqual([]);
  });

  it("refuses a runtime version without a producer-derived persistence contract", () => {
    const f = fixture({ session: { version: "9.9.9" } });

    expect(retain(f, { runtimeVersion: "9.9.9" })).toEqual({
      ok: false,
      reason: "schema-unknown",
      check: "schema-drift",
    });
    expect(entryNames(f)).toEqual([]);
  });

  it("retains and restores the still-admitted 2.0.10 producer's database", () => {
    const f = fixture({
      session: { version: "2.0.10" },
      alter:
        "ALTER TABLE project DROP COLUMN time_active; ALTER TABLE project DROP COLUMN time_archived;",
    });
    const before = sha256(f.source);

    expect(retain(f, { runtimeVersion: "2.0.10" })).toMatchObject({ ok: true });
    const restored = checkout(f, { runtimeVersion: "2.0.10" });
    expect(restored.result).toMatchObject({ ok: true, sessionId: SESSION_ID });
    expect(sha256(restored.destination)).toBe(sha256(join(entryDirectory(f), "opencode.db")));
    expect(sha256(f.source)).toBe(before);
  });

  it.each([
    ["permission", "grant-present"],
    ["credential", "credential-present"],
  ] as const)("refuses persisted %s in the admitted 2.0.10 schema", (table, reason) => {
    const f = fixture({
      session: { version: "2.0.10" },
      alter:
        "ALTER TABLE project DROP COLUMN time_active; ALTER TABLE project DROP COLUMN time_archived;",
      rows: { [table]: 1 },
    });

    expect(retain(f, { runtimeVersion: "2.0.10" })).toMatchObject({ ok: false, reason });
    expect(entryNames(f)).toEqual([]);
  });

  it("refuses a 2.1.4 schema claiming to be a 2.0.10 session", () => {
    const f = fixture({ session: { version: "2.0.10" } });

    expect(retain(f, { runtimeVersion: "2.0.10" })).toEqual({
      ok: false,
      reason: "schema-unknown",
      check: "schema-drift",
    });
    expect(entryNames(f)).toEqual([]);
  });

  it("refuses an unrelated session id and a database that is not one", () => {
    const f = fixture();
    expect(
      f.store.retain({
        binding: binding(),
        sessionId: "ses_other",
        directory: WORKSPACE,
        sourceDatabase: f.source,
      }),
    ).toEqual({ ok: false, reason: "session-mismatch" });

    writeFileSync(f.source, "this is not a database");
    expect(retain(f)).toEqual({ ok: false, reason: "schema-unknown", check: "copy-unreadable" });
    expect(retain({ ...f, source: join(f.root, "missing.db") })).toEqual({
      ok: false,
      reason: "database-missing",
    });
    expect(entryNames(f)).toEqual([]);
  });

  it("refuses a session longer than the runtime's own history read admits", () => {
    const f = fixture({ messages: 5 }, { maxMessages: 4 });

    expect(retain(f)).toEqual({ ok: false, reason: "database-oversized" });
    expect(entryNames(f)).toEqual([]);
  });

  it("refuses an oversized database and leaves the task's previous entry as it was", () => {
    const f = fixture({}, { maxDatabaseBytes: 100_000 });
    expect(retain(f)).toMatchObject({ ok: true });
    const kept = sha256(join(entryDirectory(f), "opencode.db"));

    runtimeDatabase(join(f.root, "big.db"), { messages: 3 });
    const big = new DatabaseSync(join(f.root, "big.db"));
    big.exec(`UPDATE session_message SET data = '${"x".repeat(200_000)}'`);
    big.close();
    const result = f.store.retain({
      binding: binding(),
      sessionId: SESSION_ID,
      directory: WORKSPACE,
      sourceDatabase: join(f.root, "big.db"),
    });

    expect(result).toEqual({ ok: false, reason: "database-oversized" });
    expect(sha256(join(entryDirectory(f), "opencode.db"))).toBe(kept);
    expect(entryNames(f)).toEqual([retainedSessionKey("task-1")]);
  });

  it.each([
    ["an unsafe task id", { taskId: "../escape" }],
    ["a workspace key that is not a digest", { workspaceKey: "workspace" }],
    ["a malformed version", { runtimeVersion: "2.1" }],
    ["a window of zero", { maxInputTokens: 0 }],
  ])("refuses a binding with %s before touching the disk", (_name, overrides) => {
    const f = fixture();

    expect(retain(f, overrides)).toEqual({ ok: false, reason: "session-mismatch" });
    expect(existsSync(f.storeRoot)).toBe(false);
  });

  it("refuses a store root that is a symbolic link", () => {
    const f = fixture();
    mkdirSync(join(f.root, "elsewhere"));
    symlinkSync(join(f.root, "elsewhere"), f.storeRoot);

    // A store that cannot be trusted is a failure for the caller to record, not a refusal.
    expect(() => retain(f)).toThrow("retained-root-invalid");
    expect(readdirSync(join(f.root, "elsewhere"))).toEqual([]);
  });

  it.runIf(process.platform === "win32")(
    "refuses a Windows directory junction as the store root",
    () => {
      const f = fixture();
      const target = join(f.root, "elsewhere");
      mkdirSync(target);
      symlinkSync(target, f.storeRoot, "junction");

      expect(() => retain(f)).toThrow("retained-root-invalid");
      expect(readdirSync(target)).toEqual([]);
    },
  );

  it.each(["checkout", "prune", "remove"] as const)(
    "refuses a redirected retention root during %s without touching its target",
    (operation) => {
      const f = fixture();
      expect(retain(f)).toMatchObject({ ok: true });
      const target = join(f.root, "redirected");
      renameSync(f.storeRoot, target);
      symlinkSync(target, f.storeRoot, process.platform === "win32" ? "junction" : "dir");
      const entry = join(target, retainedSessionKey("task-1"));
      const databaseBefore = sha256(join(entry, "opencode.db"));
      const manifestBefore = sha256(join(entry, "manifest.json"));

      expect(() => {
        if (operation === "checkout") return checkout(f);
        if (operation === "prune") return f.store.prune(() => false);
        f.store.remove("task-1");
      }).toThrow("retained-root-invalid");
      expect(sha256(join(entry, "opencode.db"))).toBe(databaseBefore);
      expect(sha256(join(entry, "manifest.json"))).toBe(manifestBefore);
      expect(readdirSync(target)).toEqual([retainedSessionKey("task-1")]);
    },
  );

  it("throws, rather than reporting a missing database, when the source cannot be examined", () => {
    const f = fixture();

    expect(() =>
      f.store.retain({
        binding: binding(),
        sessionId: SESSION_ID,
        directory: WORKSPACE,
        sourceDatabase: join(f.root, "x".repeat(5000)),
      }),
    ).toThrow(/ENAMETOOLONG/u);
    expect(existsSync(f.storeRoot) ? entryNames(f) : []).toEqual([]);
  });
});

describe("checking a retained entry out for a resuming run", () => {
  it("places a verified copy and reports the session and its age, never its content", () => {
    const f = fixture();
    retain(f);
    f.clock.value += 5_000;

    const { destination, result } = checkout(f);

    expect(result).toEqual({
      ok: true,
      sessionId: SESSION_ID,
      databaseBytes: statSync(destination).size,
      messageCount: 3,
      ageMs: 5_000,
    });
    expect(sha256(destination)).toBe(sha256(join(entryDirectory(f), "opencode.db")));
    expect(statSync(destination).mode & 0o077).toBe(0);
    // The entry is untouched: another run of the task, or a fork, can take it again.
    expect(checkout(f).result).toMatchObject({ ok: true });
  });

  it("admits a window at least as large as the one the history was built under", () => {
    const f = fixture();
    retain(f);

    expect(checkout(f, { maxInputTokens: 24_000 }).result).toMatchObject({ ok: true });
    expect(checkout(f, { maxInputTokens: 48_000 }).result).toMatchObject({ ok: true });
  });

  it("answers no-retained-state when the task has no entry", () => {
    const f = fixture();

    expect(checkout(f).result).toEqual({ ok: false, reason: "no-retained-state", removed: false });
  });

  it("refuses another task's entry by key and by manifest", () => {
    const f = fixture();
    retain(f);

    expect(checkout(f, { taskId: "task-2" }).result).toMatchObject({
      ok: false,
      reason: "no-retained-state",
    });
    // A manifest naming another task under this task's key is not this task's entry.
    const manifestPath = join(entryDirectory(f), "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, taskId: "task-2" }));
    expect(checkout(f).result).toMatchObject({ ok: false, reason: "integrity-failed" });
  });

  it.each([
    [
      "another workspace",
      { workspaceKey: createHash("sha256").update("other").digest("hex") },
      "workspace-changed",
    ],
    ["another runtime version", { runtimeVersion: "2.1.5" }, "version-changed"],
  ] as const)("refuses %s and removes the entry for good", (_name, overrides, reason) => {
    const f = fixture();
    retain(f);

    const refused = checkout(f, overrides);

    expect(refused.result).toEqual({ ok: false, reason, removed: true });
    expect(existsSync(refused.destination)).toBe(false);
    expect(entryNames(f)).toEqual([]);
    expect(checkout(f).result).toMatchObject({ reason: "no-retained-state" });
  });

  it("refuses a smaller window but keeps the entry for a run that can take it", () => {
    const f = fixture();
    retain(f);

    const refused = checkout(f, { maxInputTokens: 8_000 });

    expect(refused.result).toEqual({ ok: false, reason: "window-shrunk", removed: false });
    expect(existsSync(refused.destination)).toBe(false);
    expect(checkout(f, { maxInputTokens: 24_000 }).result).toMatchObject({ ok: true });
  });

  it("refuses an expired entry without reading its database and removes it", () => {
    const f = fixture();
    retain(f);
    f.clock.value += RETAINED_SESSION_LIMITS.maxAgeMs + 1;

    expect(checkout(f).result).toEqual({ ok: false, reason: "expired", removed: true });
    expect(entryNames(f)).toEqual([]);
  });

  it("refuses a database that changed after it was retained and leaves no copy behind", () => {
    const f = fixture();
    retain(f);
    const database = join(entryDirectory(f), "opencode.db");
    const tampered = new DatabaseSync(database);
    tampered.exec(
      "INSERT INTO session_message (id, session_id, data) VALUES ('msg_forged', 'ses_retained_1', 'forged')",
    );
    tampered.close();

    const refused = checkout(f);

    expect(refused.result).toEqual({ ok: false, reason: "integrity-failed", removed: true });
    expect(existsSync(refused.destination)).toBe(false);
    expect(entryNames(f)).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["an extra field", JSON.stringify({ extra: true })],
  ])("refuses a manifest that is %s", (_name, text) => {
    const f = fixture();
    retain(f);
    writeFileSync(join(entryDirectory(f), "manifest.json"), text);

    expect(checkout(f).result).toMatchObject({ ok: false, reason: "integrity-failed" });
  });

  it("refuses a manifest with an extra field next to the valid ones", () => {
    const f = fixture();
    retain(f);
    const manifestPath = join(entryDirectory(f), "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, authority: "full" }));

    expect(checkout(f).result).toMatchObject({ ok: false, reason: "integrity-failed" });
  });

  it("refuses a manifest larger than the bound and a database that is not a file", () => {
    const f = fixture();
    retain(f);
    writeFileSync(join(entryDirectory(f), "manifest.json"), " ".repeat(5_000));
    expect(checkout(f).result).toMatchObject({ reason: "integrity-failed" });

    retain(f);
    rmSync(join(entryDirectory(f), "opencode.db"));
    mkdirSync(join(entryDirectory(f), "opencode.db"));
    expect(checkout(f).result).toMatchObject({ reason: "integrity-failed" });
  });

  it.each([
    ["a saved grant", "permission", "grant-present"],
    ["a credential", "credential", "credential-present"],
    ["a queued input", "session_inbox", "pending-input"],
  ] as const)(
    "audits the copy it places: an entry whose database now carries %s is refused",
    (_name, table, reason) => {
      const f = fixture();
      retain(f);
      const database = join(entryDirectory(f), "opencode.db");
      const poisoned = new DatabaseSync(database);
      poisoned.exec(`INSERT INTO "${table}" DEFAULT VALUES`);
      poisoned.close();
      // A forged manifest that vouches for the poisoned bytes: the audit still refuses them.
      const manifestPath = join(entryDirectory(f), "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          databaseBytes: statSync(database).size,
          databaseSha256: sha256(database),
        }),
      );

      const refused = checkout(f);

      expect(refused.result).toEqual({ ok: false, reason, removed: true });
      expect(existsSync(refused.destination)).toBe(false);
    },
  );

  it("never overwrites or deletes a file that is already at the destination", () => {
    const f = fixture();
    retain(f);
    const destination = join(f.root, "occupied.db");
    writeFileSync(destination, "someone else's file");

    expect(() =>
      f.store.checkout({
        binding: binding(),
        directory: WORKSPACE,
        destinationDatabase: destination,
      }),
    ).toThrow(/EEXIST/u);
    expect(readFileSync(destination, "utf8")).toBe("someone else's file");
    expect(entryNames(f)).toEqual([retainedSessionKey("task-1")]);
  });

  it("audits against the workspace directory of the asking run", () => {
    const f = fixture();
    retain(f);

    const refused = checkout(f, {}, "/another/root");

    expect(refused.result).toEqual({ ok: false, reason: "session-mismatch", removed: true });
  });
});

// #3903 AC4, #3902 AC3: a fork into a workspace provisioned from the entry's own.
describe("checking a retained entry out into a workspace provisioned from its own", () => {
  const TARGET_KEY = createHash("sha256").update("target").digest("hex");
  const SOURCE: RetainedSessionSource = { workspaceKey: WORKSPACE_KEY, directory: WORKSPACE };

  function forkInto(
    f: Fixture,
    input: { readonly source?: RetainedSessionSource; readonly purpose?: "fork" },
  ): {
    readonly destination: string;
    readonly result: ReturnType<RetainedSessionStore["checkout"]>;
  } {
    const destination = join(f.root, `forked-${String(Math.random()).slice(2)}.db`);
    return {
      destination,
      result: f.store.checkout({
        binding: binding({ workspaceKey: TARGET_KEY }),
        directory: "/target/root",
        destinationDatabase: destination,
        ...input,
      }),
    };
  }

  it("admits a fork from exactly its source and audits the copy where it was retained", () => {
    const f = fixture();
    retain(f);

    const { destination, result } = forkInto(f, { purpose: "fork", source: SOURCE });

    expect(result).toEqual({
      ok: true,
      sessionId: SESSION_ID,
      databaseBytes: statSync(destination).size,
      messageCount: 3,
      ageMs: 0,
      sourceDirectory: WORKSPACE,
    });
    expect(sha256(destination)).toBe(sha256(join(entryDirectory(f), "opencode.db")));
    // The source task keeps its entry: its own workspace can still resume it.
    expect(checkout(f).result).toMatchObject({ ok: true });
    expect(checkout(f).result).not.toHaveProperty("sourceDirectory");
  });

  it("ignores a source a resume names and refuses another source without touching the entry", () => {
    const f = fixture();
    retain(f);

    expect(forkInto(f, { purpose: "fork" }).result).toEqual({
      ok: false,
      reason: "workspace-changed",
      removed: false,
    });
    const elsewhere = { ...SOURCE, workspaceKey: createHash("sha256").update("x").digest("hex") };
    const mismatched = f.store.checkout({
      binding: binding({ workspaceKey: TARGET_KEY }),
      directory: "/target/root",
      destinationDatabase: join(f.root, "mismatched.db"),
      purpose: "fork",
      source: elsewhere,
    });
    expect(mismatched).toEqual({ ok: false, reason: "workspace-changed", removed: false });
    expect(existsSync(join(f.root, "mismatched.db"))).toBe(false);
    expect(entryNames(f)).toEqual([retainedSessionKey("task-1")]);
    // Only a fork may name a source: a resume that does is an ordinary workspace change.
    expect(forkInto(f, { source: SOURCE }).result).toEqual({
      ok: false,
      reason: "workspace-changed",
      removed: true,
    });
  });

  it("refuses a copy whose session is not where its source says it was retained", () => {
    const f = fixture();
    retain(f);

    const { result } = forkInto(f, {
      purpose: "fork",
      source: { ...SOURCE, directory: "/another/root" },
    });

    expect(result).toEqual({ ok: false, reason: "session-mismatch", removed: true });
  });
});

describe("pruning the retained entries", () => {
  it("removes the entry of a task that no longer exists with every retention, not only at startup", () => {
    const f = fixture();
    const live = new Set(["task-live", "task-gone"]);
    const store = createRetainedSessionStore({
      root: f.storeRoot,
      now: () => f.clock.value,
      isLiveTask: (taskId) => live.has(taskId),
    });
    const retainTask = (taskId: string): ReturnType<RetainedSessionStore["retain"]> =>
      store.retain({
        binding: binding({ taskId }),
        sessionId: SESSION_ID,
        directory: WORKSPACE,
        sourceDatabase: f.source,
      });
    retainTask("task-gone");
    retainTask("task-live");
    expect(entryNames(f)).toHaveLength(2);
    live.delete("task-gone");

    const result = retainTask("task-live");

    expect(result).toMatchObject({ ok: true, entryCount: 1, prunedCount: 1 });
    expect(entryNames(f)).toEqual([retainedSessionKey("task-live")]);
  });

  it("removes expired, orphaned and unreadable entries and interrupted staging", () => {
    const f = fixture();
    for (const taskId of ["task-live", "task-old", "task-orphan"]) retain(f, { taskId });
    writeFileSync(join(entryDirectory(f, "task-old"), "manifest.json"), "{}");
    const garbage = join(f.storeRoot, "f".repeat(64));
    mkdirSync(garbage);
    mkdirSync(join(f.storeRoot, `.staging-${"a".repeat(16)}`));
    mkdirSync(join(f.storeRoot, `.replaced-${"b".repeat(16)}`));
    mkdirSync(join(f.storeRoot, "not-ours"));

    const pruned = f.store.prune((taskId) => taskId !== "task-orphan");

    expect(pruned).toEqual({ expired: 0, orphaned: 1, invalid: 2, quota: 0, entryCount: 1 });
    expect(entryNames(f)).toEqual(["not-ours", retainedSessionKey("task-live")].sort());
  });

  it("removes an entry once it is older than the age bound", () => {
    const f = fixture();
    retain(f);
    f.clock.value += RETAINED_SESSION_LIMITS.maxAgeMs + 1;

    expect(f.store.prune()).toMatchObject({ expired: 1, entryCount: 0 });
  });

  it("keeps the newest entries within the count bound and removes the oldest first", () => {
    const f = fixture({}, { maxEntries: 2 });
    for (const taskId of ["task-a", "task-b", "task-c"]) {
      f.clock.value += 1_000;
      retain(f, { taskId });
    }

    expect(entryNames(f)).toEqual(
      [retainedSessionKey("task-b"), retainedSessionKey("task-c")].sort(),
    );
  });

  it("keeps the entries within the total byte bound", () => {
    const f = fixture({}, { maxTotalBytes: 1 });
    f.clock.value += 1_000;
    const result = retain(f);

    // A single entry larger than the whole bound cannot stay.
    expect(result).toMatchObject({ ok: true, entryCount: 0, prunedCount: 1 });
    expect(entryNames(f)).toEqual([]);
  });

  it("answers an absent root with nothing to prune", () => {
    const f = fixture();

    expect(f.store.prune()).toEqual({
      expired: 0,
      orphaned: 0,
      invalid: 0,
      quota: 0,
      entryCount: 0,
    });
  });

  it("removes one task's entry on request and ignores a task without one", () => {
    const f = fixture();
    retain(f);

    f.store.remove("task-without-entry");
    expect(entryNames(f)).toHaveLength(1);
    f.store.remove("task-1");
    expect(entryNames(f)).toEqual([]);
  });
});

describe("auditing a database directly", () => {
  it("reports the message count of the one expected session", () => {
    const root = tempRoot();
    const path = join(root, "a.db");
    runtimeDatabase(path, { messages: 7 });

    expect(
      auditDatabase(path, { sessionId: SESSION_ID, directory: WORKSPACE, version: VERSION }),
    ).toEqual({ ok: true, messageCount: 7 });
  });

  it("treats an unreadable file as an unknown schema rather than a clean one", () => {
    const root = tempRoot();

    expect(
      auditDatabase(join(root, "missing.db"), {
        sessionId: SESSION_ID,
        directory: WORKSPACE,
        version: VERSION,
      }),
    ).toEqual({ ok: false, reason: "schema-unknown", check: "audit-unreadable" });
  });
});
