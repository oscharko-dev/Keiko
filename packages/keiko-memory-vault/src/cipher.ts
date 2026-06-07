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
// The keychain call is the only OS boundary in this module, so it is the only place wrapped in
// try/catch: any failure (no `security` binary, locked keychain, non-darwin) falls through to the
// keyfile tier rather than bricking the vault.

import { execFileSync } from "node:child_process";
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

// macOS Keychain via the `security` CLI. find→use; on miss, generate+store. Every spawn is wrapped
// so a hardened/locked/headless keychain degrades to the keyfile tier instead of throwing.
function keyFromKeychain(): Buffer | undefined {
  if (process.platform !== "darwin") return undefined;
  const account = userInfo().username;
  try {
    const found = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return decodeKeyOrThrow(found, "Keychain key");
  } catch {
    return generateKeychainKey(account);
  }
}

function generateKeychainKey(account: string): Buffer | undefined {
  const key = randomBytes(KEY_BYTES);
  try {
    execFileSync(
      "security",
      ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", key.toString("base64")],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    return key;
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
