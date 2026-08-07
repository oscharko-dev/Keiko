// Local secret vault — encrypted-at-rest, multi-entry storage for local runtime credentials
// (Issue #1320, Epic #1319).
//
// This is the generalised sibling of the single-value Figma PAT vault (figmaTokenStore.ts) and the
// MemoriaViva memory vault (ADR-0035): all three seal their secrets at rest with the shared
// AES-256-GCM secretbox primitive and resolve a 32-byte key with the same env -> OS-keychain ->
// keyfile precedence. The difference here is cardinality: a model gateway can carry several provider
// credentials, so this store keeps a sealed map of `reference -> sealed(secret)` rather than one
// sealed value. References are opaque, NON-SECRET identifiers held alongside the sealed material; the
// plaintext secret NEVER touches disk, an error message, a log line, or a return value other than
// get().
//
// Key precedence (resolveLocalVaultKey), namespaced per domain so it never collides with another
// vault's key:
//   1. <envVarName>     — base64 of exactly 32 bytes. Explicit operator override; key lives outside
//                         the vault directory entirely (strongest tier).
//   2. macOS Keychain   — generic password under <keychainService>. The OS protects the key.
//   3. Keyfile          — <vaultDir>/<keyfileName>, mode 0600. Weakest tier (key next to store).
//
// Replay across vaults is prevented by key separation, not by the AAD: every vault resolves a
// DISTINCT key (distinct env var, keychain service, and keyfile), so a ciphertext sealed for one
// vault fails GCM authentication when opened with another vault's key regardless of the shared AAD.

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isSealed, openString, sealString } from "./secretbox.js";
// Shared fs-hardening owner [GEN-MAINT-COUPLING-005]: this package now owns the 0o700/0o600 hardening
// pair; import it from the sibling module (relative — we ARE keiko-security).
import { chmodIfPresent, ensureDirHardened, FILE_MODE } from "./fs-hardening.js";
// Shared keychain-spawn bound [GEN-MAINT-COUPLING-006], so the three surfaces cannot drift apart.
import { KEYCHAIN_SPAWN_TIMEOUT_MS } from "./macos-keychain.js";

const KEY_BYTES = 32;
const STORE_VERSION = 1;
const MACOS_SECURITY_EXECUTABLE = "/usr/bin/security";

export type SecretVaultStoreErrorCode =
  "SECRET_VAULT_STORE_INVALID_JSON" | "SECRET_VAULT_STORE_INVALID_SCHEMA";

export class SecretVaultStoreError extends Error {
  readonly code: SecretVaultStoreErrorCode;
  readonly storePath: string;

  constructor(
    code: SecretVaultStoreErrorCode,
    storePath: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SecretVaultStoreError";
    this.code = code;
    this.storePath = storePath;
  }
}

export type LocalVaultKeySource = "env" | "keychain" | "keyfile";

export interface ResolvedLocalVaultKey {
  readonly key: Buffer;
  readonly source: LocalVaultKeySource;
}

// Injectable so tests (and CI, and any non-darwin host) can force the keyfile tier deterministically
// without touching the real login keychain. `undefined` means "this tier is unavailable, fall
// through". Mirrors the Figma vault's keychain seam.
export type LocalVaultKeychainAccess = () => Buffer | undefined;

export const NO_LOCAL_VAULT_KEYCHAIN: LocalVaultKeychainAccess = () => undefined;

export interface ResolveLocalVaultKeyOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly vaultDir: string;
  // Operator override env var, e.g. "KEIKO_PROVIDER_CREDENTIALS_KEY".
  readonly envVarName: string;
  // macOS Keychain generic-password service, e.g. "keiko-provider-credentials-vault".
  readonly keychainService: string;
  // Keyfile basename written under vaultDir, e.g. "provider-credentials-vault.key".
  readonly keyfileName: string;
  // Test/non-darwin seam. Defaults to the real `security` CLI reader scoped to keychainService.
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
}

export interface LocalSecretVault {
  // Returns the decrypted secret for `reference`, or undefined when no entry exists. Throws a
  // SecretboxError when an entry exists but cannot be opened (wrong key or tampered store).
  readonly get: (reference: string) => string | undefined;
  // Seals `secret` under `reference`, replacing any existing entry. Atomic and crash-safe.
  readonly set: (reference: string, secret: string) => void;
  // Replaces the ENTIRE entry set with the supplied references, sealing each value. Removes any
  // reference not present in `entries`. Atomic and crash-safe — used to keep the vault in lockstep
  // with the current provider set on each persist.
  readonly replaceAll: (entries: ReadonlyMap<string, string>) => void;
  // Removes the entry for `reference` if present. Atomic and crash-safe.
  readonly delete: (reference: string) => void;
  readonly has: (reference: string) => boolean;
  // Lists the stored references (NON-SECRET identifiers only; never decrypts).
  readonly list: () => readonly string[];
}

export interface LocalSecretVaultDeps {
  readonly key: Buffer;
  readonly storePath: string;
}

function decodeKeyOrThrow(raw: string): Buffer {
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    // Secret-free message: never echo the (possibly partial) key material.
    throw new Error("secret vault key must be base64 of exactly 32 bytes");
  }
  return decoded;
}

function keyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  envVarName: string,
): Buffer | undefined {
  const raw = env[envVarName];
  if (raw === undefined || raw.length === 0) return undefined;
  return decodeKeyOrThrow(raw);
}

// The macOS `security` CLI invocation, isolated behind a one-line seam so the keychain reader logic
// (read-hit, read-miss-then-generate, generate-failure) is unit-testable with a fake runner.
export type KeychainCommandRunner = (args: readonly string[]) => string;

// The spawn is bounded for the reason the shared owner documents [GEN-MAINT-COUPLING-006]: a locked,
// absent, or policy-withheld keychain makes `security` raise a modal dialog instead of returning, and
// an unbounded call then waits for a human forever. The bound is imported rather than restated so
// all three keychain surfaces share one number. `executable` and `timeoutMs` are test seams only.
export function createKeychainCommandRunner(
  executable = MACOS_SECURITY_EXECUTABLE,
  timeoutMs = KEYCHAIN_SPAWN_TIMEOUT_MS,
): KeychainCommandRunner {
  return (args: readonly string[]): string =>
    execFileSync(executable, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
}

const defaultKeychainCommandRunner = createKeychainCommandRunner();

// Builds the default keychain-backed key access for a service. Exported with an injectable runner so
// the reader/generate branches are deterministically testable without the real login keychain.
export function createKeychainVaultKeyAccess(
  keychainService: string,
  runCommand: KeychainCommandRunner = defaultKeychainCommandRunner,
): LocalVaultKeychainAccess {
  return (): Buffer | undefined => {
    if (process.platform !== "darwin") return undefined;
    const account = userInfo().username;
    try {
      const found = runCommand([
        "find-generic-password",
        "-s",
        keychainService,
        "-a",
        account,
        "-w",
      ]).trim();
      return decodeKeyOrThrow(found);
    } catch {
      return generateKeychainKey(keychainService, account, runCommand);
    }
  };
}

function generateKeychainKey(
  keychainService: string,
  account: string,
  runCommand: KeychainCommandRunner,
): Buffer | undefined {
  const key = randomBytes(KEY_BYTES);
  try {
    runCommand([
      "add-generic-password",
      "-s",
      keychainService,
      "-a",
      account,
      "-w",
      key.toString("base64"),
    ]);
    return key;
  } catch {
    return undefined;
  }
}

function keyFromKeyfile(vaultDir: string, keyfileName: string): Buffer {
  const keyfile = resolve(vaultDir, keyfileName);
  // Refuse to read or write the key through a symlinked path segment so a hostile symlink cannot
  // redirect key material outside the hardened vault directory.
  assertNoSymlinkedPathSegments(keyfile);
  ensureDirHardened(dirname(keyfile));
  assertNoSymlinkedPathSegments(keyfile);
  if (existsSync(keyfile)) {
    return decodeKeyOrThrow(readFileSync(keyfile, "utf8").trim());
  }
  const key = randomBytes(KEY_BYTES);
  writeDurableTextFile(keyfile, key.toString("base64"), FILE_MODE);
  chmodIfPresent(keyfile, FILE_MODE);
  return key;
}

export function resolveLocalVaultKey(options: ResolveLocalVaultKeyOptions): ResolvedLocalVaultKey {
  const fromEnv = keyFromEnv(options.env, options.envVarName);
  if (fromEnv !== undefined) return { key: fromEnv, source: "env" };
  const keychainAccess =
    options.keychainAccess ?? createKeychainVaultKeyAccess(options.keychainService);
  const fromKeychain = keychainAccess();
  if (fromKeychain !== undefined) return { key: fromKeychain, source: "keychain" };
  return { key: keyFromKeyfile(options.vaultDir, options.keyfileName), source: "keyfile" };
}

function assertNoSymlinkedPathSegments(resolvedPath: string): void {
  let current = resolvedPath;
  while (current !== dirname(current)) {
    if (isSymlink(current)) {
      throw new Error("refusing to write secret vault through a symlinked path");
    }
    current = dirname(current);
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

interface StoreFile {
  readonly version: number;
  readonly entries: Record<string, string>;
}

function isStoreFile(value: unknown): value is StoreFile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== STORE_VERSION) return false;
  const entries = record.entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return false;
  return Object.values(entries).every((entry) => typeof entry === "string");
}

function storeUnreadableError(
  code: SecretVaultStoreErrorCode,
  storePath: string,
  cause?: unknown,
): SecretVaultStoreError {
  const reason =
    code === "SECRET_VAULT_STORE_INVALID_JSON"
      ? "not valid JSON"
      : "not a supported secret vault store";
  return new SecretVaultStoreError(
    code,
    storePath,
    `secret vault store is unreadable (${reason}); refusing to treat it as empty`,
    cause,
  );
}

function readStore(storePath: string): Record<string, string> {
  const resolvedPath = resolve(storePath);
  assertNoSymlinkedPathSegments(resolvedPath);
  if (!existsSync(resolvedPath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    throw storeUnreadableError("SECRET_VAULT_STORE_INVALID_JSON", resolvedPath, error);
  }
  if (!isStoreFile(parsed)) {
    throw storeUnreadableError("SECRET_VAULT_STORE_INVALID_SCHEMA", resolvedPath);
  }
  return { ...parsed.entries };
}

// Lists the references held in a sealed store WITHOUT resolving a vault key — a pure read over the
// non-secret index. Used by callers that must reconcile config references against vaulted secrets
// (e.g. preserve-existing persistence and `keiko repair`) without triggering key generation or
// decryption. Returns an empty array only when the store is missing; corrupt/unsupported stores fail
// closed so callers cannot rewrite config from an empty reference set.
export function readLocalVaultReferences(storePath: string): readonly string[] {
  return Object.keys(readStore(storePath));
}

function writeDurableTextFile(path: string, content: string, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, content, 0, "utf8");
    fsyncSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best-effort close after a write/fsync failure.
    }
  }
}

function fsyncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is not available on every filesystem; temp-file fsync remains the key guard.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close only.
      }
    }
  }
}

// Atomic, crash-safe write: a fresh temp file in the same directory is written with 0600 and renamed
// over the target so a reader never observes a partially written store. Mirrors savePrivateJson.
function writeStore(storePath: string, entries: Record<string, string>): void {
  const resolvedPath = resolve(storePath);
  const dir = dirname(resolvedPath);
  // Check both before and after directory creation (mirrors private-json.ts): the first guards an
  // already-symlinked path, the second narrows the window where a parent could be swapped between
  // dir creation and the atomic rename. The atomic temp-then-rename below remains the real guarantee.
  assertNoSymlinkedPathSegments(resolvedPath);
  ensureDirHardened(dir);
  assertNoSymlinkedPathSegments(resolvedPath);
  const payload: StoreFile = { version: STORE_VERSION, entries };
  const tempPath = join(
    dir,
    `.secret-vault.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeDurableTextFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, FILE_MODE);
    chmodIfPresent(tempPath, FILE_MODE);
    renameSync(tempPath, resolvedPath);
    chmodIfPresent(resolvedPath, FILE_MODE);
    fsyncDirectory(dir);
  } finally {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

// Sharded layout (#2616): one sealed file per reference instead of one JSON map for the whole
// vault. Same key, same AES-256-GCM envelope, same namespace — only the placement differs, so a
// caller writing one entry pays for that entry rather than for every entry it has ever written.
// The single-file layout above stays the default: it is right for a handful of long-lived
// credentials, and wrong for an append-heavy store on an interactive path.
const SHARD_PREFIX = "entry-";
const SHARD_EXTENSION = ".sealed";
// Keeps the encoded filename inside the 255-byte limit every supported filesystem guarantees.
const SHARD_REFERENCE_MAX_BYTES = 96;

export interface ShardedLocalSecretVaultDeps {
  readonly key: Buffer;
  // Directory that holds this vault's sealed entry files. It is created hardened on first write.
  readonly storeDir: string;
}

// References are opaque, NON-SECRET identifiers, so the filename may carry one — the single-file
// layout already stores them as plaintext JSON keys. Hex makes a separator or traversal segment
// unrepresentable and lets list() recover the reference.
//
// `undefined` means "no file can represent this reference", which is exactly the set of references
// this vault refuses to store. Both rejections are load-bearing:
//   - over the byte bound, the encoded name would exceed what a filesystem accepts;
//   - not UTF-8 round-trippable (a lone surrogate), `Buffer.from` substitutes U+FFFD, so two
//     DISTINCT references would map onto ONE file and silently serve each other's secret.
// Rejecting on the way in is what keeps the mapping injective, and therefore keeps a stored secret
// reachable only under the reference it was stored with.
function shardFileName(reference: string): string | undefined {
  const encoded = Buffer.from(reference, "utf8");
  if (encoded.length > SHARD_REFERENCE_MAX_BYTES) return undefined;
  const hex = encoded.toString("hex");
  return Buffer.from(hex, "hex").toString("utf8") === reference
    ? `${SHARD_PREFIX}${hex}${SHARD_EXTENSION}`
    : undefined;
}

// Only a filename this vault could itself have written yields a reference, and `shardFileName` is
// the single authority on that. Deciding both directions with one encoder is what keeps `list`,
// `get` and `delete` agreeing: a name that decodes to a reference the vault would store elsewhere —
// or would refuse outright, being over the byte bound or not UTF-8 round-trippable — must not be
// reported, or a caller reconciling against `list()` would name bodies it can never reclaim.
function shardReference(fileName: string): string | undefined {
  if (!fileName.startsWith(SHARD_PREFIX) || !fileName.endsWith(SHARD_EXTENSION)) return undefined;
  const hex = fileName.slice(SHARD_PREFIX.length, fileName.length - SHARD_EXTENSION.length);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(hex)) return undefined;
  const reference = Buffer.from(hex, "hex").toString("utf8");
  return shardFileName(reference) === fileName ? reference : undefined;
}

// Atomic, crash-safe single-entry write. Mirrors writeStore's temp-then-rename discipline; the
// difference is that the temp file holds ONE envelope, so the cost does not grow with the vault.
function writeShard(dir: string, filePath: string, envelope: string): void {
  // Checked twice on purpose, exactly as writeStore does: the first call guards an already
  // symlinked path, the second narrows the window where a parent could be swapped between
  // directory creation and the rename. The atomic temp-then-rename below remains the real
  // guarantee — neither call is redundant.
  assertNoSymlinkedPathSegments(filePath);
  ensureDirHardened(dir);
  assertNoSymlinkedPathSegments(filePath);
  const tempPath = join(
    dir,
    `.secret-vault-shard.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeDurableTextFile(tempPath, envelope, FILE_MODE);
    chmodIfPresent(tempPath, FILE_MODE);
    renameSync(tempPath, filePath);
    chmodIfPresent(filePath, FILE_MODE);
    fsyncDirectory(dir);
  } finally {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

function readShardEnvelope(filePath: string): string | undefined {
  // The symlink refusal is a guarantee and still throws. A read that fails for any other reason
  // (EISDIR, EACCES, EIO) is one unreadable entry, which says nothing about the others — reporting
  // it as absent is what this layout documents, and what `get`/`has` promise their callers.
  assertNoSymlinkedPathSegments(filePath);
  let envelope: string;
  try {
    envelope = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  return isSealed(envelope) ? envelope : undefined;
}

function listShardReferences(dir: string): readonly string[] {
  // The single-file layout's list() reads through readStore, which refuses a symlinked path; the
  // sharded one asserts here so the same hostile redirect cannot make it enumerate a foreign
  // directory's references.
  assertNoSymlinkedPathSegments(dir);
  let names: readonly string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const references: string[] = [];
  for (const name of names) {
    const reference = shardReference(name);
    if (reference !== undefined) references.push(reference);
  }
  return references;
}

/**
 * A {@link LocalSecretVault} whose entries live in one sealed file each, under `storeDir`.
 *
 * Carries {@link createLocalSecretVault}'s protective guarantees unchanged — AES-256-GCM per entry,
 * 0600 files in a 0700 directory, atomic temp-then-rename, symlink-refusing paths, plaintext only
 * ever returned by `get`. The reason to choose it is write cost: `set` and `delete` touch a single
 * entry file, so an append-heavy store stops paying for its own history on every write.
 *
 * Two behaviours deliberately differ, and a caller storing credentials should weigh them:
 *   - a store the layout cannot read reports EMPTY (`list` returns `[]`, `get` returns `undefined`)
 *     where the single-file layout raises `SecretVaultStoreError` rather than treat a damaged store
 *     as empty. Per entry there is nothing to conflate — one unreadable file says nothing about the
 *     others — but a caller that rewrites its own config from `list` must not adopt this layout;
 *   - a reference no filename can represent is refused by `set`, where the single-file layout
 *     accepts any string as a JSON key.
 *
 * `list` reads only filenames and never decrypts, which is what lets a caller reconcile stored
 * bodies against its own index.
 */
export function createShardedLocalSecretVault(deps: ShardedLocalSecretVaultDeps): LocalSecretVault {
  const { key } = deps;
  const storeDir = resolve(deps.storeDir);
  // A reference with no representable filename can hold no entry, so reads and deletes report
  // "absent" rather than throwing — matching the single-file layout, where an unknown reference is
  // never an error. Only storing one is refused, and loudly.
  const readPath = (reference: string): string | undefined => {
    const name = shardFileName(reference);
    return name === undefined ? undefined : join(storeDir, name);
  };
  const writePath = (reference: string): string => {
    const name = shardFileName(reference);
    if (name === undefined) {
      throw new Error("secret vault reference cannot be stored as a sharded entry");
    }
    return join(storeDir, name);
  };

  const remove = (reference: string): void => {
    const filePath = readPath(reference);
    if (filePath === undefined) return;
    assertNoSymlinkedPathSegments(filePath);
    rmSync(filePath, { force: true });
  };

  const replaceAll = (next: ReadonlyMap<string, string>): void => {
    for (const [reference, secret] of next) {
      writeShard(storeDir, writePath(reference), sealString(key, secret));
    }
    for (const reference of listShardReferences(storeDir)) {
      if (!next.has(reference)) remove(reference);
    }
  };

  const envelopeFor = (reference: string): string | undefined => {
    const filePath = readPath(reference);
    return filePath === undefined ? undefined : readShardEnvelope(filePath);
  };

  return {
    get: (reference): string | undefined => {
      const envelope = envelopeFor(reference);
      return envelope === undefined ? undefined : openString(key, envelope);
    },
    set: (reference, secret): void => {
      writeShard(storeDir, writePath(reference), sealString(key, secret));
    },
    replaceAll,
    delete: remove,
    has: (reference): boolean => envelopeFor(reference) !== undefined,
    list: (): readonly string[] => listShardReferences(storeDir),
  };
}

export function createLocalSecretVault(deps: LocalSecretVaultDeps): LocalSecretVault {
  const { key, storePath } = deps;
  const resolvedStorePath = resolve(storePath);

  const get = (reference: string): string | undefined => {
    const envelope = readStore(resolvedStorePath)[reference];
    if (envelope === undefined || !isSealed(envelope)) return undefined;
    return openString(key, envelope);
  };

  const set = (reference: string, secret: string): void => {
    const entries = readStore(resolvedStorePath);
    entries[reference] = sealString(key, secret);
    writeStore(resolvedStorePath, entries);
  };

  const replaceAll = (next: ReadonlyMap<string, string>): void => {
    if (existsSync(resolvedStorePath)) {
      readStore(resolvedStorePath);
    }
    const entries: Record<string, string> = {};
    for (const [reference, secret] of next) {
      entries[reference] = sealString(key, secret);
    }
    if (Object.keys(entries).length === 0) {
      assertNoSymlinkedPathSegments(resolvedStorePath);
      rmSync(resolvedStorePath, { force: true });
      return;
    }
    writeStore(resolvedStorePath, entries);
  };

  const remove = (reference: string): void => {
    const entries = readStore(resolvedStorePath);
    if (!(reference in entries)) return;
    const next: Record<string, string> = {};
    for (const [storedRef, sealed] of Object.entries(entries)) {
      if (storedRef !== reference) {
        next[storedRef] = sealed;
      }
    }
    if (Object.keys(next).length === 0) {
      assertNoSymlinkedPathSegments(resolvedStorePath);
      rmSync(resolvedStorePath, { force: true });
      return;
    }
    writeStore(resolvedStorePath, next);
  };

  const has = (reference: string): boolean => reference in readStore(resolvedStorePath);

  const list = (): readonly string[] => Object.keys(readStore(resolvedStorePath));

  return { get, set, replaceAll, delete: remove, has, list };
}
