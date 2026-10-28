import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { OPENCODE_PERSISTENCE_SCHEMAS } from "./opencodePersistenceContract.js";

/**
 * Server-owned retention of a settled native run's own session state (S02/S03, #3904).
 *
 * A native run keeps its OpenCode database in a private, per-run state directory that is deleted
 * when the run is disposed. To let the next run of the same Coding History task resume the
 * runtime's own session instead of replaying a bounded excerpt of Coding History, a run that
 * settled normally leaves a compacted copy of that database here, bound to the task, the workspace,
 * the pinned runtime version and the model window it was built under. One entry per task; bounded
 * in size, number and age; never inside a workspace.
 *
 * Nothing here is authority. The copy is audited so that it carries no saved permission grant, no
 * credential, no queued input and no staged undo, and a resumed run mints its own authority and
 * capabilities exactly like a fresh one. Anything that does not match the run that asks for it is
 * refused with a closed reason, and the run falls back to a fresh session with Coding History
 * context. The module reads no database content: it counts rows and compares identities.
 */

const MIB = 1024 * 1024;

export interface RetainedSessionLimits {
  readonly maxDatabaseBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
  readonly maxAgeMs: number;
  readonly maxManifestBytes: number;
  /**
   * Messages in the session. The runtime's history read, which every run makes again and again,
   * refuses a longer session, so a longer one is not retained into a run that could not start.
   */
  readonly maxMessages: number;
}

export const RETAINED_SESSION_LIMITS: RetainedSessionLimits = Object.freeze({
  /** One entry's database. A larger runtime database is not retained. */
  maxDatabaseBytes: 128 * MIB,
  /** Every entry together; the oldest entries are removed first. */
  maxTotalBytes: 512 * MIB,
  maxEntries: 32,
  /** An entry older than this is removed unread. */
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxManifestBytes: 4096,
  maxMessages: 3000,
});

const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const DATABASE_FILE = "opencode.db";
const ENTRY_NAME = /^[a-f0-9]{64}$/u;
/** What an interrupted retain leaves behind: a staging directory or an entry moved aside. */
const INTERRUPTED_ENTRY = /^\.(?:staging|replaced)-[a-f0-9]{16}$/u;
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,251}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RUNTIME_VERSION = /^\d+\.\d+\.\d+$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH_CHUNK_BYTES = MIB;

/** The closed vocabulary the Activity Log and the caller use for every refusal. */
export type RetentionRefusal =
  | "database-missing"
  | "database-oversized"
  | "copy-failed"
  | "schema-unknown"
  | "grant-present"
  | "credential-present"
  | "pending-input"
  | "revert-staged"
  | "session-mismatch"
  | "no-retained-state"
  | "integrity-failed"
  | "expired"
  | "version-changed"
  | "workspace-changed"
  | "window-shrunk";

/**
 * Which audit check refused a copy as `schema-unknown`, so a refusal names the table or read that
 * failed without naming any content: rows in a table Keiko does not model, a copy SQLite cannot
 * read, a database or table the audit cannot read as it expects, a count that is not one, or a
 * schema that is not the producer's persistence contract for the session's runtime version.
 */
export type RetentionAuditCheck =
  | "kv-rows"
  | "workspace-rows"
  | "copy-unreadable"
  | "audit-unreadable"
  | "count-invalid"
  | "schema-drift";

/** The workspace a fork's target was provisioned from, and where its session was retained. */
export interface RetainedSessionSource {
  readonly workspaceKey: string;
  readonly directory: string;
}

/** What a retained entry is valid for. A resume must present the same task, workspace and version. */
export interface RetainedSessionBinding {
  readonly taskId: string;
  /** A digest of the workspace identity (id and canonical root); never the root itself. */
  readonly workspaceKey: string;
  readonly runtimeVersion: string;
  /** The input window the history was built under; a smaller window cannot take it back. */
  readonly maxInputTokens: number;
}

export interface RetainedSessionManifest extends RetainedSessionBinding {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly databaseBytes: number;
  readonly databaseSha256: string;
  readonly retainedAtMs: number;
}

export type RetainResult =
  | {
      readonly ok: true;
      readonly databaseBytes: number;
      readonly messageCount: number;
      readonly entryCount: number;
      readonly prunedCount: number;
    }
  | {
      readonly ok: false;
      readonly reason: RetentionRefusal;
      readonly check?: RetentionAuditCheck | undefined;
    };

export type CheckoutResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly databaseBytes: number;
      readonly messageCount: number;
      readonly ageMs: number;
      /** Present when the session was retained at its fork source's location, not the asker's. */
      readonly sourceDirectory?: string;
    }
  | {
      readonly ok: false;
      readonly reason: RetentionRefusal;
      /** The refusal can never become valid, so the entry was removed. */
      readonly removed: boolean;
    };

export interface PruneResult {
  readonly expired: number;
  readonly orphaned: number;
  readonly invalid: number;
  readonly quota: number;
  readonly entryCount: number;
}

export interface RetainedSessionStore {
  /**
   * Copies the run's settled database into the task's entry after auditing the copy. The source is
   * only read; an existing entry of the task is replaced as a whole or left as it was.
   */
  retain(input: {
    readonly binding: RetainedSessionBinding;
    readonly sessionId: string;
    readonly directory: string;
    readonly sourceDatabase: string;
  }): RetainResult;
  /**
   * Validates the task's entry against the run that asks for it and, when it matches, places a
   * verified, audited copy at `destinationDatabase`. The entry itself is never modified.
   */
  checkout(input: {
    readonly binding: RetainedSessionBinding;
    readonly directory: string;
    readonly destinationDatabase: string;
    /** A fork may refuse the asking run's binding without destroying its source task's entry. */
    readonly purpose?: "fork";
    /**
     * A fork into a workspace provisioned from another one (#3903 AC4, #3902 AC3): the entry is
     * admitted when it is bound to exactly this source workspace, and its copy is audited at the
     * source's location. Honoured only with `purpose: "fork"`; nothing else about the binding moves.
     */
    readonly source?: RetainedSessionSource | undefined;
  }): CheckoutResult;
  remove(taskId: string): void;
  /** Removes expired, invalid, orphaned and over-quota entries and any interrupted staging. */
  prune(isLiveTask?: (taskId: string) => boolean): PruneResult;
}

export interface RetainedSessionStoreOptions {
  readonly root: string;
  readonly now?: (() => number) | undefined;
  readonly limits?: Partial<RetainedSessionLimits> | undefined;
  /**
   * Whether a task still exists. Every pruning, the one a retention ends with included, removes the
   * entry of a task that does not.
   */
  readonly isLiveTask?: ((taskId: string) => boolean) | undefined;
}

export function retainedSessionKey(taskId: string): string {
  return createHash("sha256").update(`keiko.retained-session.task.v1\0${taskId}`).digest("hex");
}

export function createRetainedSessionStore(
  options: RetainedSessionStoreOptions,
): RetainedSessionStore {
  const store = new Store(options);
  return {
    retain: (input) => store.retain(input),
    checkout: (input) => store.checkout(input),
    remove: (taskId): void => {
      store.remove(taskId);
    },
    prune: (isLiveTask) => store.prune(isLiveTask),
  };
}

interface AuditExpectation {
  readonly sessionId: string;
  readonly directory: string;
  readonly version: string;
}

type AuditResult =
  | { readonly ok: true; readonly messageCount: number }
  | {
      readonly ok: false;
      readonly reason: RetentionRefusal;
      readonly check?: RetentionAuditCheck | undefined;
    };

class Store {
  private readonly root: string;
  private readonly now: () => number;
  private readonly limits: RetainedSessionLimits;
  private readonly isLiveTask: ((taskId: string) => boolean) | undefined;

  public constructor(options: RetainedSessionStoreOptions) {
    this.root = options.root;
    this.now = options.now ?? Date.now;
    this.isLiveTask = options.isLiveTask;
    this.limits = { ...RETAINED_SESSION_LIMITS, ...options.limits };
  }

  public retain(input: Parameters<RetainedSessionStore["retain"]>[0]): RetainResult {
    if (!validBinding(input.binding) || !SESSION_ID.test(input.sessionId)) {
      return { ok: false, reason: "session-mismatch" };
    }
    const staging = join(this.root, `.staging-${randomBytes(8).toString("hex")}`);
    try {
      this.ensureRoot();
      const staged = this.stage(input, staging);
      if (!staged.ok) return staged;
      this.publish(staging, input.binding.taskId);
      const pruned = this.prune();
      return {
        ok: true,
        databaseBytes: staged.databaseBytes,
        messageCount: staged.messageCount,
        entryCount: pruned.entryCount,
        prunedCount: pruned.expired + pruned.orphaned + pruned.invalid + pruned.quota,
      };
    } finally {
      // A refusal is a result; a filesystem or database failure propagates to the caller, which owns
      // the log port and records it with its frames and causes.
      rmSync(staging, { recursive: true, force: true });
    }
  }

  public checkout(input: Parameters<RetainedSessionStore["checkout"]>[0]): CheckoutResult {
    if (this.existingRoot() === undefined) {
      return { ok: false, reason: "no-retained-state", removed: false };
    }
    const entry = join(this.root, retainedSessionKey(input.binding.taskId));
    if (!existsSync(entry)) return { ok: false, reason: "no-retained-state", removed: false };
    const manifest = this.readManifest(entry);
    const refusal =
      manifest === undefined
        ? ("integrity-failed" as const)
        : this.bindingRefusal(manifest, input.binding, forkSource(input));
    if (
      input.purpose === "fork" &&
      (refusal === "workspace-changed" || refusal === "version-changed")
    ) {
      return { ok: false, reason: refusal, removed: false };
    }
    if (manifest === undefined || refusal !== undefined) {
      return this.refuse(input.binding.taskId, refusal ?? "integrity-failed");
    }
    return this.copyOut(entry, manifest, input);
  }

  public remove(taskId: string): void {
    if (this.existingRoot() === undefined) return;
    rmSync(join(this.root, retainedSessionKey(taskId)), { recursive: true, force: true });
  }

  public prune(
    isLiveTask: ((taskId: string) => boolean) | undefined = this.isLiveTask,
  ): PruneResult {
    const counts = { expired: 0, orphaned: 0, invalid: 0, quota: 0 };
    if (this.existingRoot() === undefined) return { ...counts, entryCount: 0 };
    const entries: PrunableEntry[] = [];
    for (const name of readdirSync(this.root)) {
      if (INTERRUPTED_ENTRY.test(name)) {
        rmSync(join(this.root, name), { recursive: true, force: true });
        continue;
      }
      // A name Keiko did not write is not Keiko's to delete.
      if (!ENTRY_NAME.test(name)) continue;
      const kept = this.pruneEntry(name, isLiveTask, counts);
      if (kept !== undefined) entries.push(kept);
    }
    const remaining = this.evictOverQuota(entries, counts);
    return { ...counts, entryCount: remaining };
  }

  // The steps of a retain, in the order that makes a refusal cost nothing: the compacted copy is
  // made and audited in a private staging directory that only a complete entry ever leaves.
  private stage(
    input: Parameters<RetainedSessionStore["retain"]>[0],
    staging: string,
  ): StageResult {
    const size = fileSize(input.sourceDatabase);
    if (size === undefined) return { ok: false, reason: "database-missing" };
    if (size > this.limits.maxDatabaseBytes) return { ok: false, reason: "database-oversized" };
    mkdirSync(staging, { mode: 0o700 });
    const database = join(staging, DATABASE_FILE);
    if (compactCopy(input.sourceDatabase, database) === "unreadable") {
      return { ok: false, reason: "schema-unknown", check: "copy-unreadable" };
    }
    const audit = auditDatabase(database, {
      sessionId: input.sessionId,
      directory: input.directory,
      version: input.binding.runtimeVersion,
    });
    if (!audit.ok) return audit;
    if (audit.messageCount > this.limits.maxMessages) {
      return { ok: false, reason: "database-oversized" };
    }
    const hashed = hashFile(database);
    if (hashed.bytes > this.limits.maxDatabaseBytes) {
      return { ok: false, reason: "database-oversized" };
    }
    const manifest: RetainedSessionManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      ...input.binding,
      sessionId: input.sessionId,
      databaseBytes: hashed.bytes,
      databaseSha256: hashed.sha256,
      retainedAtMs: this.now(),
    };
    writeFileSync(join(staging, MANIFEST_FILE), JSON.stringify(manifest), { mode: 0o600 });
    return { ok: true, databaseBytes: hashed.bytes, messageCount: audit.messageCount };
  }

  // The previous entry moves aside before the new one is renamed in, so a reader sees one whole
  // entry or none; an interruption in between leaves no entry, and the leftover is pruned.
  private publish(staging: string, taskId: string): void {
    const entry = join(this.root, retainedSessionKey(taskId));
    let aside: string | undefined;
    if (existsSync(entry)) {
      aside = join(this.root, `.replaced-${randomBytes(8).toString("hex")}`);
      renameSync(entry, aside);
    }
    renameSync(staging, entry);
    if (aside !== undefined) rmSync(aside, { recursive: true, force: true });
  }

  private copyOut(
    entry: string,
    manifest: RetainedSessionManifest,
    input: Parameters<RetainedSessionStore["checkout"]>[0],
  ): CheckoutResult {
    const source = join(entry, DATABASE_FILE);
    if (fileSize(source) !== manifest.databaseBytes) {
      return this.refuse(input.binding.taskId, "integrity-failed");
    }
    // Exclusive: a file that is already there is not Keiko's to overwrite, and not to delete either.
    copyFileSync(source, input.destinationDatabase, fsConstants.COPYFILE_EXCL);
    try {
      return this.verifiedCopy(manifest, input);
    } catch (error) {
      rmSync(input.destinationDatabase, { force: true });
      throw error;
    }
  }

  // The copy is what the runtime will open, so the copy is what is verified and audited.
  private verifiedCopy(
    manifest: RetainedSessionManifest,
    input: Parameters<RetainedSessionStore["checkout"]>[0],
  ): CheckoutResult {
    chmodSync(input.destinationDatabase, 0o600);
    const verdict = copyVerdict(manifest, input);
    if (typeof verdict === "string") {
      rmSync(input.destinationDatabase, { force: true });
      return this.refuse(input.binding.taskId, verdict);
    }
    const relocated = retainedAtSource(manifest, input);
    return {
      ok: true,
      sessionId: manifest.sessionId,
      databaseBytes: manifest.databaseBytes,
      messageCount: verdict.messageCount,
      ageMs: Math.max(0, this.now() - manifest.retainedAtMs),
      ...(relocated === undefined ? {} : { sourceDirectory: relocated.directory }),
    };
  }

  // A refusal that cannot become valid removes the entry; one that depends on the asking run only
  // (a smaller window) leaves it for a run that can take it.
  private refuse(taskId: string, reason: RetentionRefusal): CheckoutResult {
    const removed = reason !== "window-shrunk";
    if (removed) this.remove(taskId);
    return { ok: false, reason, removed };
  }

  private bindingRefusal(
    manifest: RetainedSessionManifest,
    binding: RetainedSessionBinding,
    source: RetainedSessionSource | undefined,
  ): RetentionRefusal | undefined {
    if (manifest.taskId !== binding.taskId) return "integrity-failed";
    if (this.now() - manifest.retainedAtMs > this.limits.maxAgeMs) return "expired";
    if (manifest.runtimeVersion !== binding.runtimeVersion) return "version-changed";
    if (
      manifest.workspaceKey !== binding.workspaceKey &&
      manifest.workspaceKey !== source?.workspaceKey
    )
      return "workspace-changed";
    if (binding.maxInputTokens < manifest.maxInputTokens) return "window-shrunk";
    return undefined;
  }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = this.existingRoot();
    if (stat === undefined) throw new Error("retained-root-invalid");
    if ((stat.mode & 0o077) !== 0) chmodSync(this.root, 0o700);
  }

  // Recheck at every public entry: a root accepted during retain may have been redirected since.
  // This rejects an existing link/junction; it is not descriptor-relative protection from races.
  private existingRoot(): Stats | undefined {
    let stat: Stats;
    try {
      stat = lstatSync(this.root);
    } catch (error) {
      if (isAbsentPath(error)) return undefined;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("retained-root-invalid");
    return stat;
  }

  private readManifest(entry: string): RetainedSessionManifest | undefined {
    const path = join(entry, MANIFEST_FILE);
    const size = fileSize(path);
    if (size === undefined || size > this.limits.maxManifestBytes) return undefined;
    try {
      return parseManifest(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch (error) {
      // Text that is not JSON is a manifest that cannot be trusted; an unreadable file is a failure.
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  private pruneEntry(
    name: string,
    isLiveTask: ((taskId: string) => boolean) | undefined,
    counts: { expired: number; orphaned: number; invalid: number },
  ): PrunableEntry | undefined {
    const path = join(this.root, name);
    const manifest = this.readManifest(path);
    const verdict = this.pruneVerdict(name, manifest, isLiveTask);
    if (verdict === "kept" && manifest !== undefined) {
      return { path, bytes: manifest.databaseBytes, retainedAtMs: manifest.retainedAtMs };
    }
    rmSync(path, { recursive: true, force: true });
    if (verdict !== "kept") counts[verdict] += 1;
    return undefined;
  }

  private pruneVerdict(
    name: string,
    manifest: RetainedSessionManifest | undefined,
    isLiveTask: ((taskId: string) => boolean) | undefined,
  ): "kept" | "expired" | "orphaned" | "invalid" {
    if (manifest === undefined || retainedSessionKey(manifest.taskId) !== name) return "invalid";
    if (this.now() - manifest.retainedAtMs > this.limits.maxAgeMs) return "expired";
    return isLiveTask !== undefined && !isLiveTask(manifest.taskId) ? "orphaned" : "kept";
  }

  private evictOverQuota(entries: PrunableEntry[], counts: { quota: number }): number {
    entries.sort((a, b) => a.retainedAtMs - b.retainedAtMs);
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (
      entries.length > 0 &&
      (entries.length > this.limits.maxEntries || total > this.limits.maxTotalBytes)
    ) {
      const oldest = entries.shift();
      if (oldest === undefined) break;
      rmSync(oldest.path, { recursive: true, force: true });
      total -= oldest.bytes;
      counts.quota += 1;
    }
    return entries.length;
  }
}

type StageResult =
  | { readonly ok: true; readonly databaseBytes: number; readonly messageCount: number }
  | {
      readonly ok: false;
      readonly reason: RetentionRefusal;
      readonly check?: RetentionAuditCheck | undefined;
    };

interface PrunableEntry {
  readonly path: string;
  readonly bytes: number;
  readonly retainedAtMs: number;
}

type CheckoutInput = Parameters<RetainedSessionStore["checkout"]>[0];

/** The fork source a checkout names; only a fork may name one. */
function forkSource(input: CheckoutInput): RetainedSessionSource | undefined {
  return input.purpose === "fork" ? input.source : undefined;
}

/** The source the entry was retained at, when it is not the asking run's own workspace. */
function retainedAtSource(
  manifest: RetainedSessionManifest,
  input: CheckoutInput,
): RetainedSessionSource | undefined {
  const source = forkSource(input);
  return manifest.workspaceKey !== input.binding.workspaceKey &&
    manifest.workspaceKey === source?.workspaceKey
    ? source
    : undefined;
}

/** The refusal for a copy that is not the entry's database, or the audit of the copy that is. */
function copyVerdict(
  manifest: RetainedSessionManifest,
  input: CheckoutInput,
): RetentionRefusal | { readonly messageCount: number } {
  if (hashFile(input.destinationDatabase).sha256 !== manifest.databaseSha256) {
    return "integrity-failed";
  }
  // The copy is audited where its session was retained: the asker's location, or the fork source's.
  const audit = auditDatabase(input.destinationDatabase, {
    sessionId: manifest.sessionId,
    directory: retainedAtSource(manifest, input)?.directory ?? input.directory,
    version: input.binding.runtimeVersion,
  });
  return audit.ok ? { messageCount: audit.messageCount } : audit.reason;
}

function validBinding(binding: RetainedSessionBinding): boolean {
  return (
    TASK_ID.test(binding.taskId) &&
    SHA256.test(binding.workspaceKey) &&
    RUNTIME_VERSION.test(binding.runtimeVersion) &&
    Number.isSafeInteger(binding.maxInputTokens) &&
    binding.maxInputTokens > 0
  );
}

const MANIFEST_KEYS = [
  "databaseBytes",
  "databaseSha256",
  "maxInputTokens",
  "retainedAtMs",
  "runtimeVersion",
  "schemaVersion",
  "sessionId",
  "taskId",
  "workspaceKey",
];

// Code-unit order, the order `MANIFEST_KEYS` is written in.
function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function parseManifest(value: unknown): RetainedSessionManifest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort(compareKeys);
  if (keys.length !== MANIFEST_KEYS.length || keys.some((key, i) => key !== MANIFEST_KEYS[i])) {
    return undefined;
  }
  const candidate = value as RetainedSessionManifest;
  return validBinding(candidate) && validManifestEvidence(candidate) ? candidate : undefined;
}

function validManifestEvidence(manifest: RetainedSessionManifest): boolean {
  return (
    typeof manifest.sessionId === "string" &&
    SESSION_ID.test(manifest.sessionId) &&
    Number.isSafeInteger(manifest.databaseBytes) &&
    manifest.databaseBytes > 0 &&
    typeof manifest.databaseSha256 === "string" &&
    SHA256.test(manifest.databaseSha256) &&
    Number.isSafeInteger(manifest.retainedAtMs) &&
    manifest.retainedAtMs > 0
  );
}

function fileSize(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch (error) {
    // Only an absent path is "no file"; a path that cannot be examined is a failure.
    if (isAbsentPath(error)) return undefined;
    throw error;
  }
}

function isAbsentPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function hashFile(path: string): { readonly sha256: string; readonly bytes: number } {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile()) throw new Error("retained-file-invalid");
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      bytes += read;
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    closeSync(fd);
  }
}

/**
 * `VACUUM INTO` writes a consistent, compacted, standalone copy, including what a write-ahead log
 * still holds, and leaves free pages (content of removed sessions) behind.
 */
function compactCopy(source: string, destination: string): "copied" | "unreadable" {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(source, { readOnly: true });
    database.prepare("VACUUM INTO ?").run(destination);
    chmodSync(destination, 0o600);
    return "copied";
  } catch (error) {
    // SQLITE_CORRUPT and SQLITE_NOTADB: the file is not a database Keiko can vouch for. Anything
    // else (a full disk, a permission) is an I/O failure and keeps its own cause.
    if (sqliteErrorCode(error) === 11 || sqliteErrorCode(error) === 26) return "unreadable";
    throw error;
  } finally {
    database?.close();
  }
}

function sqliteErrorCode(error: unknown): number | undefined {
  const code = (error as { readonly errcode?: unknown } | null)?.errcode;
  return typeof code === "number" ? code : undefined;
}

/** Tables the runtime keeps authority or credentials in; a retained copy holds none of their rows. */
const GRANT_TABLES = ["permission"] as const;
const CREDENTIAL_TABLES = ["credential", "account", "account_state", "control_account"] as const;
const PENDING_TABLES = ["session_pending", "session_inbox"] as const;
/** Tables whose content Keiko does not model: any row is a state it cannot vouch for. */
const UNKNOWN_STATE_TABLES = ["kv", "workspace"] as const;
const UNKNOWN_STATE_CHECKS: Readonly<
  Record<(typeof UNKNOWN_STATE_TABLES)[number], RetentionAuditCheck>
> = { kv: "kv-rows", workspace: "workspace-rows" };

interface SessionRow {
  readonly id?: unknown;
  readonly directory?: unknown;
  readonly version?: unknown;
  readonly parent_id?: unknown;
  readonly workspace_id?: unknown;
  readonly permission?: unknown;
  readonly revert?: unknown;
  readonly time_archived?: unknown;
  readonly time_suspended?: unknown;
}

/** The audit could not read what it must: the schema is not the one it knows. */
class AuditRefused extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuditRefused";
  }
}

/** The `code` node:sqlite gives every error SQLite reports (an unopenable file, a missing table). */
const SQLITE_ERROR = "ERR_SQLITE_ERROR";

/**
 * Proves that a database holds exactly one session, the expected one, and no state that could act
 * with authority a later run does not have: saved grants, credentials, queued inputs, a staged undo.
 * An unknown schema is refused rather than guessed at.
 */
export function auditDatabase(path: string, expected: AuditExpectation): AuditResult {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    return auditOpenDatabase(database, expected);
  } catch (error) {
    // A file SQLite cannot open or whose tables are not the ones audited is an unknown schema.
    if (error instanceof AuditRefused) {
      return { ok: false, reason: "schema-unknown", check: "count-invalid" };
    }
    if ((error as { code?: unknown } | undefined)?.code === SQLITE_ERROR) {
      return { ok: false, reason: "schema-unknown", check: "audit-unreadable" };
    }
    throw error;
  } finally {
    database?.close();
  }
}

function auditOpenDatabase(database: DatabaseSync, expected: AuditExpectation): AuditResult {
  const tables: readonly (readonly [readonly string[], RetentionRefusal])[] = [
    [GRANT_TABLES, "grant-present"],
    [CREDENTIAL_TABLES, "credential-present"],
    [PENDING_TABLES, "pending-input"],
  ];
  for (const [names, reason] of tables) {
    for (const name of names) {
      if (rowCount(database, `SELECT COUNT(*) AS n FROM "${name}"`) !== 0) {
        return { ok: false, reason };
      }
    }
  }
  for (const name of UNKNOWN_STATE_TABLES) {
    if (rowCount(database, `SELECT COUNT(*) AS n FROM "${name}"`) !== 0) {
      return { ok: false, reason: "schema-unknown", check: UNKNOWN_STATE_CHECKS[name] };
    }
  }
  if (!matchesPersistenceContract(database, expected.version)) {
    return { ok: false, reason: "schema-unknown", check: "schema-drift" };
  }
  const sessions = database
    .prepare(
      "SELECT id, directory, version, parent_id, workspace_id, permission, revert, time_archived, time_suspended FROM session_v2",
    )
    .all() as SessionRow[];
  const session = sessions[0];
  if (sessions.length !== 1 || session === undefined) {
    return { ok: false, reason: "session-mismatch" };
  }
  const refusal = sessionRefusal(session, expected);
  if (refusal !== undefined) return { ok: false, reason: refusal };
  const messageCount = rowCount(
    database,
    "SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?",
    expected.sessionId,
  );
  return { ok: true, messageCount };
}

interface SchemaObjectRow {
  readonly type?: unknown;
  readonly name?: unknown;
}

/**
 * Whether the database has exactly the tables and columns the producer's own migrations create
 * for the session's runtime version (`opencodePersistenceContract.ts`), and no view or trigger. An
 * added table or column may hold state none of the checks above examined, so it is refused even
 * when empty; a missing one is not the schema the audit knows either. SQLite's own `sqlite_*`
 * tables are the engine's, not the producer's.
 */
function matchesPersistenceContract(database: DatabaseSync, version: string): boolean {
  const contract = Object.hasOwn(OPENCODE_PERSISTENCE_SCHEMAS, version)
    ? OPENCODE_PERSISTENCE_SCHEMAS[version]
    : undefined;
  if (contract === undefined) return false;
  const objects = database
    .prepare(
      String.raw`SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite\_%' ESCAPE '\'`,
    )
    .all() as SchemaObjectRow[];
  const tables = objects.flatMap((row) =>
    row.type === "table" && typeof row.name === "string" ? [row.name] : [],
  );
  if (tables.length !== objects.length || !sameMembers(tables, Object.keys(contract))) {
    return false;
  }
  // Every table is one of the contract's own keys by now, so the lookup cannot reach a prototype.
  return tables.every((table) => sameMembers(columnNames(database, table), contract[table]));
}

function columnNames(database: DatabaseSync, table: string): readonly string[] {
  const rows = database.prepare("SELECT name FROM pragma_table_xinfo(?)").all(table) as {
    readonly name?: unknown;
  }[];
  return rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
}

function sameMembers(actual: readonly string[], expected: readonly string[] | undefined): boolean {
  if (actual.length !== expected?.length) return false;
  const known = new Set(expected);
  return new Set(actual).size === actual.length && actual.every((name) => known.has(name));
}

function sessionRefusal(
  session: SessionRow,
  expected: AuditExpectation,
): RetentionRefusal | undefined {
  if (
    session.id !== expected.sessionId ||
    session.directory !== expected.directory ||
    session.version !== expected.version ||
    session.parent_id !== null ||
    session.workspace_id !== null ||
    session.time_archived !== null
  ) {
    return "session-mismatch";
  }
  if (session.time_suspended !== null) return "pending-input";
  if (session.revert !== null) return "revert-staged";
  return emptyRuleset(session.permission) ? undefined : "grant-present";
}

function emptyRuleset(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed === null || (Array.isArray(parsed) && parsed.length === 0);
  } catch (error) {
    // A ruleset that is not JSON is not provably empty.
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function rowCount(database: DatabaseSync, sql: string, ...parameters: string[]): number {
  const row = database.prepare(sql).get(...parameters) as { readonly n?: unknown } | undefined;
  const count = row?.n;
  if (typeof count === "bigint") return Number(count);
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new AuditRefused("retained-count-invalid");
  }
  return count;
}
