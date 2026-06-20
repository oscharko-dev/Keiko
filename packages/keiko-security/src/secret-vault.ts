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
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isSealed, openString, sealString } from "./secretbox.js";

const KEY_BYTES = 32;
const STORE_VERSION = 1;

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

function ensureDirHardened(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort: a parent-owned directory we cannot chmod beats a hard failure.
  }
}

function chmodIfPresent(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort hardening.
  }
}

// The macOS `security` CLI invocation, isolated behind a one-line seam so the keychain reader logic
// (read-hit, read-miss-then-generate, generate-failure) is unit-testable with a fake runner.
export type KeychainCommandRunner = (args: readonly string[]) => string;

function defaultKeychainCommandRunner(args: readonly string[]): string {
  return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

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
  writeFileSync(keyfile, key.toString("base64"), { mode: 0o600 });
  chmodIfPresent(keyfile, 0o600);
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

function readStore(storePath: string): Record<string, string> {
  const resolvedPath = resolve(storePath);
  assertNoSymlinkedPathSegments(resolvedPath);
  if (!existsSync(resolvedPath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch {
    // A non-JSON store is treated as empty so a corrupt index never crashes resolution; the entries
    // it would have held simply resolve to undefined and surface as an honest "missing credential".
    return {};
  }
  return isStoreFile(parsed) ? { ...parsed.entries } : {};
}

// Lists the references held in a sealed store WITHOUT resolving a vault key — a pure read over the
// non-secret index. Used by callers that must reconcile config references against vaulted secrets
// (e.g. preserve-existing persistence and `keiko repair`) without triggering key generation or
// decryption. Returns an empty array for a missing or corrupt store.
export function readLocalVaultReferences(storePath: string): readonly string[] {
  return Object.keys(readStore(storePath));
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
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodIfPresent(tempPath, 0o600);
    renameSync(tempPath, resolvedPath);
    chmodIfPresent(resolvedPath, 0o600);
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
