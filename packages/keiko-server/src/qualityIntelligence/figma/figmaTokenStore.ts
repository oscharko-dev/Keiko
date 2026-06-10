// Figma PAT vault — encrypted-at-rest storage for the read-only Personal Access Token
// (Epic #750, Issue #758).
//
// The PAT is a single, server-side, READ-ONLY token. This module seals it at rest with the
// shared AES-256-GCM secretbox primitive (@oscharko-dev/keiko-security) — the same cipher that
// protects the MemoriaViva memory vault — and never writes plaintext to disk. The plaintext token
// NEVER appears in an error message, log line, return value other than read(), or persisted
// artifact: only the `kv1.` sealed envelope touches the filesystem.
//
// Lifecycle for a non-refreshable PAT (a PAT cannot be refreshed):
//   - store(token)  rotation-by-replacement — overwrites the single sealed entry in place.
//   - read()        decrypts the stored entry, or undefined when none exists.
//   - revoke()      operator removal — deletes the stored entry.
//
// Key precedence mirrors the memory-vault seam (resolveVaultKey), namespaced so it never collides
// with the memory key:
//   1. KEIKO_FIGMA_KEY  — base64 of exactly 32 bytes. Explicit operator override.
//   2. macOS Keychain   — generic password "keiko-figma-vault". The OS protects the key.
//   3. Keyfile          — <vaultDir>/figma-vault.key, mode 0600. Weakest tier (key next to store).

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { isSealed, openString, sealString } from "@oscharko-dev/keiko-security";
import { FigmaConnectorError } from "./figmaConnectorErrors.js";

const KEY_BYTES = 32;
const KEYFILE_NAME = "figma-vault.key";
const KEYCHAIN_SERVICE = "keiko-figma-vault";

export type FigmaVaultKeySource = "env" | "keychain" | "keyfile";

export interface ResolvedFigmaVaultKey {
  readonly key: Buffer;
  readonly source: FigmaVaultKeySource;
}

// Injectable so tests (and CI, and any non-darwin host) can force the keyfile tier deterministically
// without touching the real login keychain. undefined means "this tier is unavailable, fall through".
export type FigmaKeychainAccess = () => Buffer | undefined;

export interface FigmaTokenStore {
  readonly store: (token: string) => void;
  readonly read: () => string | undefined;
  readonly revoke: () => void;
}

export interface FigmaTokenStoreDeps {
  readonly key: Buffer;
  readonly storePath: string;
}

function decodeKeyOrThrow(raw: string): Buffer {
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== KEY_BYTES) {
    // Coded, secret-free: a misconfigured key surfaces as FIGMA_INTERNAL and never echoes the
    // (possibly partial) key material in the message.
    throw new FigmaConnectorError("FIGMA_INTERNAL");
  }
  return decoded;
}

function keyFromEnv(env: Readonly<Record<string, string | undefined>>): Buffer | undefined {
  const raw = env.KEIKO_FIGMA_KEY;
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

function keyFromKeychain(): Buffer | undefined {
  if (process.platform !== "darwin") return undefined;
  const account = userInfo().username;
  try {
    const found = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return decodeKeyOrThrow(found);
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

function keyFromKeyfile(vaultDir: string): Buffer {
  ensureDirHardened(vaultDir);
  const keyfile = join(vaultDir, KEYFILE_NAME);
  if (existsSync(keyfile)) {
    return decodeKeyOrThrow(readFileSync(keyfile, "utf8").trim());
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyfile, key.toString("base64"), { mode: 0o600 });
  chmodIfPresent(keyfile, 0o600);
  return key;
}

function chmodIfPresent(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort hardening.
  }
}

export const NO_FIGMA_KEYCHAIN: FigmaKeychainAccess = () => undefined;

export function resolveFigmaVaultKey(
  env: Readonly<Record<string, string | undefined>>,
  vaultDir: string,
  keychainAccess: FigmaKeychainAccess = keyFromKeychain,
): ResolvedFigmaVaultKey {
  const fromEnv = keyFromEnv(env);
  if (fromEnv !== undefined) return { key: fromEnv, source: "env" };
  const fromKeychain = keychainAccess();
  if (fromKeychain !== undefined) return { key: fromKeychain, source: "keychain" };
  return { key: keyFromKeyfile(vaultDir), source: "keyfile" };
}

export function createFigmaTokenStore(deps: FigmaTokenStoreDeps): FigmaTokenStore {
  const { key, storePath } = deps;

  const store = (token: string): void => {
    ensureDirHardened(dirname(storePath));
    writeFileSync(storePath, sealString(key, token), { mode: 0o600 });
    chmodIfPresent(storePath, 0o600);
  };

  const read = (): string | undefined => {
    if (!existsSync(storePath)) return undefined;
    const envelope = readFileSync(storePath, "utf8").trim();
    if (envelope.length === 0 || !isSealed(envelope)) return undefined;
    return openString(key, envelope);
  };

  const revoke = (): void => {
    rmSync(storePath, { force: true });
  };

  return { store, read, revoke };
}
