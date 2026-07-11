// Atlassian connector credential vault domain (Issue #2241, ADR-0128 D2).
//
// A NEW, dedicated instance of keiko-security's local secret vault — its own store file, env var,
// keychain service, and keyfile, so its key is never shared with the provider-credentials vault
// (ADR-0046) or the Figma PAT vault (ADR-0037). Per ADR-0046's key-separation rationale, a
// ciphertext sealed for one vault fails GCM authentication under another vault's key, so no
// cross-domain replay is possible. The store lives in the same hardened `credentials/` directory
// next to keiko.config.json as the provider vault, keeping the whole credential custody domain in
// one 0o700 location that is never part of the UI SQLite database.
//
// Construction is LAZY at the call sites (see wiring.ts): resolving a vault key can generate a
// keychain entry or keyfile, and a deployment that never stores an Atlassian credential must never
// grow one.

import { dirname, join } from "node:path";
import {
  createLocalSecretVault,
  resolveLocalVaultKey,
  type LocalSecretVault,
  type LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

const CREDENTIALS_SUBDIR = "credentials";
const ATLASSIAN_STORE_FILE = "atlassian-connector-credentials.vault";
const ATLASSIAN_KEYFILE = "atlassian-connector-credentials-vault.key";
const ATLASSIAN_KEY_ENV = "KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY";
const ATLASSIAN_KEYCHAIN_SERVICE = "keiko-atlassian-connector-credentials-vault";

export function atlassianCredentialVaultDir(configPath: string): string {
  return join(dirname(configPath), CREDENTIALS_SUBDIR);
}

export function atlassianCredentialStorePath(configPath: string): string {
  return join(atlassianCredentialVaultDir(configPath), ATLASSIAN_STORE_FILE);
}

export interface OpenAtlassianCredentialVaultOptions {
  readonly configPath: string;
  readonly env: EnvSource;
  // Test/non-darwin seam (mirrors the provider vault): inject NO_LOCAL_VAULT_KEYCHAIN to force
  // the keyfile tier deterministically without touching the real login keychain.
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
}

export function openAtlassianCredentialVault(
  options: OpenAtlassianCredentialVaultOptions,
): LocalSecretVault {
  const vaultDir = atlassianCredentialVaultDir(options.configPath);
  const { key } = resolveLocalVaultKey({
    env: options.env,
    vaultDir,
    envVarName: ATLASSIAN_KEY_ENV,
    keychainService: ATLASSIAN_KEYCHAIN_SERVICE,
    keyfileName: ATLASSIAN_KEYFILE,
    ...(options.keychainAccess !== undefined ? { keychainAccess: options.keychainAccess } : {}),
  });
  return createLocalSecretVault({
    key,
    storePath: atlassianCredentialStorePath(options.configPath),
  });
}
