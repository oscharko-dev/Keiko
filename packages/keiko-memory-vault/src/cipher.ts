// Vault content cipher — resolves a 32-byte AES-256-GCM key once at vault-open and binds it into a
// MemoryContentCipher that the row layer threads through every read/write. The key NEVER appears in
// an error message, event, or persisted row; only sealed envelopes touch SQLite.
//
// Key precedence (highest first), so a deterministic CI/live key always wins and the weakest tier
// is the last resort:
//   1. KEIKO_MEMORY_KEY  — base64 of exactly 32 bytes. Explicit operator override.
//   2. macOS Keychain    — OS-gated generic password "keiko-memory-vault". The OS protects the key.
//   3. Keyfile           — <memoryDir>/vault.key, mode 0600. Documented WEAKER tier: the key sits
//                          next to the DB, so an attacker with the directory has both halves.
//
// The keychain call is the only OS boundary in this module. It is delegated to the shared bounded
// owner in keiko-security: any failure OR non-answer (no `security` binary, locked or absent
// keychain, a keychain that raises a modal prompt instead of returning, non-darwin) falls through to
// the keyfile tier within a bounded time rather than bricking the vault or hanging the boot path.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  isSealed,
  openBytes,
  openString,
  sealBytes,
  sealString,
} from "@oscharko-dev/keiko-security";
import {
  readMacosKeychainSecret,
  writeMacosKeychainSecret,
  type MacosKeychainOptions,
} from "@oscharko-dev/keiko-security/macos-keychain";
import { chmodIfPresent, ensureDirHardened } from "./db.js";
import { MemoryStorageError } from "./errors.js";

const KEY_BYTES = 32;
const KEYFILE_NAME = "vault.key";
const KEYCHAIN_SERVICE = "keiko-memory-vault";

export type VaultKeySource = "env" | "keychain" | "keyfile";

export interface ResolvedVaultKey {
  readonly key: Buffer;
  readonly source: VaultKeySource;
}

// The keychain reader is injectable so tests (and CI, and any non-darwin host) can deterministically
// force the keyfile tier WITHOUT touching the real login keychain. Production passes nothing, getting
// the real `security`-CLI reader; returning undefined means "this tier is unavailable, fall through".
export type KeychainAccess = () => Buffer | undefined;

export interface MemoryContentCipher {
  readonly sealString: (plaintext: string) => string;
  readonly openString: (envelope: string) => string;
  readonly sealBytes: (buf: Buffer) => Buffer;
  readonly openBytes: (envelope: Buffer) => Buffer;
  readonly isSealed: (value: string) => boolean;
}

function decodeKeyOrThrow(raw: string, label: string): Buffer {
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new MemoryStorageError("invalid-input", `${label} must be base64 of exactly 32 bytes.`);
  }
  return decoded;
}

function keyFromEnv(env: Readonly<Record<string, string | undefined>>): Buffer | undefined {
  const raw = env.KEIKO_MEMORY_KEY;
  if (raw === undefined || raw.length === 0) return undefined;
  return decodeKeyOrThrow(raw, "KEIKO_MEMORY_KEY");
}

// macOS Keychain via the shared bounded owner. find→use; on miss, generate+store. A keychain that
// does not answer (`unavailable`) skips the store attempt: it would meet the same wall and spend a
// second timeout on the boot path for nothing. `options` is a test seam only — production calls it
// with none and gets the real `security` CLI and the production bound.
export function keyFromKeychain(options: MacosKeychainOptions = {}): Buffer | undefined {
  const account = userInfo().username;
  const read = readMacosKeychainSecret(KEYCHAIN_SERVICE, account, options);
  if (read.kind === "unavailable") return undefined;
  if (read.kind === "found") {
    try {
      return decodeKeyOrThrow(read.secret, "Keychain key");
    } catch {
      // A stored value we cannot decode is replaced, exactly as before.
    }
  }
  return generateKeychainKey(account, options);
}

function generateKeychainKey(account: string, options: MacosKeychainOptions): Buffer | undefined {
  const key = randomBytes(KEY_BYTES);
  return writeMacosKeychainSecret(KEYCHAIN_SERVICE, account, key.toString("base64"), options)
    ? key
    : undefined;
}

// Read-only keychain lookup for the diagnostic export seam (Wave 4a, epic #3233 §6.2): a plain
// find, never `generateKeychainKey`'s find-or-mint-and-store. A miss (including `unavailable`) is
// reported as "this tier has nothing to offer", not "mint one" — the export path this feeds must
// never write a new secret to the OS keychain any more than it may write a keyfile.
export function keyFromKeychainReadOnly(options: MacosKeychainOptions = {}): Buffer | undefined {
  const account = userInfo().username;
  const read = readMacosKeychainSecret(KEYCHAIN_SERVICE, account, options);
  if (read.kind !== "found") return undefined;
  try {
    return decodeKeyOrThrow(read.secret, "Keychain key");
  } catch {
    return undefined;
  }
}

function keyFromKeyfile(memoryDir: string): Buffer {
  ensureDirHardened(memoryDir);
  const keyfile = join(memoryDir, KEYFILE_NAME);
  if (existsSync(keyfile)) {
    return decodeKeyOrThrow(readFileSync(keyfile, "utf8").trim(), "Vault keyfile");
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyfile, key.toString("base64"), { mode: 0o600 });
  chmodIfPresent(keyfile, 0o600);
  return key;
}

export function resolveVaultKey(
  env: Readonly<Record<string, string | undefined>>,
  memoryDir: string,
  keychainAccess: KeychainAccess = keyFromKeychain,
): ResolvedVaultKey {
  const fromEnv = keyFromEnv(env);
  if (fromEnv !== undefined) return { key: fromEnv, source: "env" };
  const fromKeychain = keychainAccess();
  if (fromKeychain !== undefined) return { key: fromKeychain, source: "keychain" };
  return { key: keyFromKeyfile(memoryDir), source: "keyfile" };
}

// Test/CI seam: an explicit "no keychain" reader so callers can force the keyfile tier.
export const NO_KEYCHAIN: KeychainAccess = () => undefined;

export interface ResolvedVaultKeyReadOnly {
  readonly key: Buffer | undefined;
  readonly source: VaultKeySource | undefined;
}

// Read-only counterpart to `resolveVaultKey` for the diagnostic export seam (Wave 4a, epic #3233
// §6.2/Finding 0): tries env, then a plain keychain lookup, and — unlike `resolveVaultKey` — never
// falls through to the keyfile tier, because that tier's only miss behaviour is minting and
// persisting a brand-new key to the customer's state directory. No `memoryDir` parameter: the
// whole point of this function is that it never touches the filesystem, so it must not carry a
// parameter that invites a future keyfile branch.
export function resolveVaultKeyReadOnly(
  env: Readonly<Record<string, string | undefined>>,
  keychainAccess: KeychainAccess = keyFromKeychainReadOnly,
): ResolvedVaultKeyReadOnly {
  const fromEnv = keyFromEnv(env);
  if (fromEnv !== undefined) return { key: fromEnv, source: "env" };
  const fromKeychain = keychainAccess();
  if (fromKeychain !== undefined) return { key: fromKeychain, source: "keychain" };
  return { key: undefined, source: undefined };
}

export function createMemoryContentCipher(key: Buffer): MemoryContentCipher {
  return {
    sealString: (plaintext: string): string => sealString(key, plaintext),
    // Tolerate legacy plaintext: a value written before encryption (or by the migration's
    // not-yet-swept window) is returned verbatim so reads never fail mid-migration.
    openString: (envelope: string): string =>
      isSealed(envelope) ? openString(key, envelope) : envelope,
    sealBytes: (buf: Buffer): Buffer => sealBytes(key, buf),
    openBytes: (envelope: Buffer): Buffer => openBytes(key, envelope),
    isSealed,
  };
}
