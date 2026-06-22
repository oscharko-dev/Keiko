// Local Knowledge store-key policy (Issue #1322, Epic #1319; ADR-0047 D2).
//
// The local, dependency-light glue between the generalized AES-256-GCM key-resolution seam
// (@oscharko-dev/keiko-security/secret-vault) and the Local Knowledge capsule store. It owns the
// env -> macOS Keychain -> 0600-keyfile key namespace that protects extracted text and vector
// content at rest, and adapts it to the store's `KnowledgeStoreKeyProvider` contract.
//
// The namespace is DISTINCT from the credential vault (Issue #1320) and the memory vault
// (ADR-0035): a separate env var, keychain service, and keyfile name. Key separation — not the
// shared AAD — is what prevents a ciphertext sealed for one store from opening with another's key.
//
// The keyfile, when that weakest tier is used, is co-located with the capsule store it protects
// (`dirname(capsules.db)`), so a copied or synced state directory carries only separately-keyed
// ciphertext. The store directory is created and hardened to 0700 by the store before the key is
// resolved; resolveLocalVaultKey additionally hardens it and writes the keyfile at 0600.

import { dirname } from "node:path";
import {
  resolveLocalVaultKey,
  type LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import type {
  KnowledgeStoreKeyProvider,
  KnowledgeStoreKeyProviderContext,
  KnowledgeStoreProtectionOptions,
} from "@oscharko-dev/keiko-local-knowledge";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

const LOCAL_KNOWLEDGE_KEY_ENV = "KEIKO_LOCAL_KNOWLEDGE_KEY";
const LOCAL_KNOWLEDGE_KEYCHAIN_SERVICE = "keiko-local-knowledge-vault";
const LOCAL_KNOWLEDGE_KEYFILE = "local-knowledge-vault.key";

export const LOCAL_KNOWLEDGE_KEY_PROVIDER_ID = "local-knowledge-content-vault";

export interface CreateLocalKnowledgeKeyProviderOptions {
  readonly env: EnvSource;
  // Test/non-darwin seam, mirroring the credential vault: inject a stub to force the keyfile tier
  // deterministically without touching the real login keychain.
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
}

// Builds the key provider keiko-server injects into openKnowledgeStore so production capsule stores
// open encrypted. The key is resolved per store-open from the store's own directory, so different
// namespaces resolve independent keyfiles while sharing the env/keychain tiers.
export function createLocalKnowledgeKeyProvider(
  options: CreateLocalKnowledgeKeyProviderOptions,
): KnowledgeStoreKeyProvider {
  return {
    providerId: LOCAL_KNOWLEDGE_KEY_PROVIDER_ID,
    resolveKey: (context: KnowledgeStoreKeyProviderContext): Uint8Array => {
      const { key } = resolveLocalVaultKey({
        env: options.env,
        vaultDir: dirname(context.dbPath),
        envVarName: LOCAL_KNOWLEDGE_KEY_ENV,
        keychainService: LOCAL_KNOWLEDGE_KEYCHAIN_SERVICE,
        keyfileName: LOCAL_KNOWLEDGE_KEYFILE,
        ...(options.keychainAccess !== undefined ? { keychainAccess: options.keychainAccess } : {}),
      });
      return key;
    },
  };
}

// Builds the store protection options for a store-open call. Returns undefined when no key provider is
// configured (legacy/manual deps) so the store opens plaintext, exactly as before. Keeps the three
// keiko-server store-open sites consistent without each re-deriving the protection shape.
export function localKnowledgeProtectionOptions(
  keyProvider: KnowledgeStoreKeyProvider | undefined,
): KnowledgeStoreProtectionOptions | undefined {
  if (keyProvider === undefined) return undefined;
  return { mode: "encrypted-key-provider", keyProvider };
}
