// Sealed gateway-config persistence and one-time credential migration (Issue #1320, Epic #1319).
//
// This module is the single write path that turns a plaintext raw gateway config into the at-rest
// form keiko.config.json is allowed to hold: non-secret provider metadata plus stable secret
// references, with every credential sealed in a local vault. It composes:
//   - the provider-credential vault (credentialVault.ts) for model apiKeys, and
//   - the existing encrypted Figma PAT vault (figmaSnapshotOrchestration.ts) for the connector PAT,
//   - the atomic private-JSON writer (private-json.ts) for the config file itself.
//
// Ordering is crash-aware by construction: secrets are sealed into their vaults FIRST, then the
// config is rewritten atomically without plaintext. If the process dies between the two, the old
// plaintext config remains on disk and the next migration re-runs idempotently (the vault writes
// overwrite), while `keiko repair` flags the lingering plaintext as an incomplete migration.

import { existsSync, readFileSync } from "node:fs";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { LocalVaultKeychainAccess } from "@oscharko-dev/keiko-security/secret-vault";
import { savePrivateJson } from "./private-json.js";
import {
  hasPlaintextGatewayCredentials,
  prepareSealedProviderApiKeys,
  pruneProviderCredentialVault,
} from "./credentialVault.js";
import { figmaTokenStoreFor } from "./qualityIntelligence/figmaSnapshotOrchestration.js";
import type { FigmaKeychainAccess } from "./qualityIntelligence/figma/index.js";

export interface SealGatewayConfigContext {
  readonly env: EnvSource;
  // Where the config file is (and will be) written; the credential vault lives in a sibling dir.
  readonly storagePath: string;
  // Root of the encrypted Figma PAT vault (mirrors the snapshot read path: <evidenceDir>/figma/...).
  readonly evidenceDir: string;
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
  readonly figmaKeychainAccess?: FigmaKeychainAccess | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Seals a Figma PAT carried in the raw config into the encrypted Figma token vault (the same store
// the snapshot flow reads first) and returns the config object with the figma block removed. A
// missing/blank token is a no-op. The vault write happens before the caller rewrites the config.
function stripAndStoreFigmaToken(
  raw: Record<string, unknown>,
  ctx: SealGatewayConfigContext,
): Record<string, unknown> {
  const figma = raw.figma;
  const token =
    isRecord(figma) && typeof figma.accessToken === "string" ? figma.accessToken.trim() : "";
  if (token.length === 0) {
    return raw;
  }
  figmaTokenStoreFor({
    env: ctx.env,
    evidenceDir: ctx.evidenceDir,
    ...(ctx.figmaKeychainAccess !== undefined ? { keychainAccess: ctx.figmaKeychainAccess } : {}),
  }).store(token);
  const withoutFigma: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "figma") {
      withoutFigma[key] = value;
    }
  }
  return withoutFigma;
}

// Seals provider apiKeys + the Figma PAT into their vaults, then atomically writes a credential-free
// keiko.config.json. The in-memory GatewayConfig the caller activates still carries the resolved
// secrets; only the persisted file is stripped to references + non-secret metadata.
export function persistSealedGatewayConfig(
  raw: Record<string, unknown>,
  ctx: SealGatewayConfigContext,
): void {
  const sealedProviders = prepareSealedProviderApiKeys({
    raw,
    env: ctx.env,
    configPath: ctx.storagePath,
    ...(ctx.keychainAccess !== undefined ? { keychainAccess: ctx.keychainAccess } : {}),
  });
  const withSealedProviders = { ...raw, providers: sealedProviders.providers };
  const sealed = stripAndStoreFigmaToken(withSealedProviders, ctx);
  savePrivateJson(ctx.storagePath, sealed);
  pruneProviderCredentialVault(
    {
      env: ctx.env,
      configPath: ctx.storagePath,
      ...(ctx.keychainAccess !== undefined ? { keychainAccess: ctx.keychainAccess } : {}),
    },
    sealedProviders.activeSecretRefs,
  );
}

export interface MigrateCredentialsOptions {
  readonly configPath: string;
  readonly env: EnvSource;
  readonly evidenceDir: string;
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
  readonly figmaKeychainAccess?: FigmaKeychainAccess | undefined;
}

export interface MigrateCredentialsOutcome {
  readonly migrated: boolean;
}

// One-time, idempotent migration of an existing plaintext keiko.config.json: moves plaintext provider
// apiKeys and the Figma PAT into their vaults and rewrites the file with references only. Best-effort
// by contract — any failure leaves the original plaintext config untouched (atomic write) so the next
// startup retries and `keiko repair` can surface an incomplete migration; it never throws into the
// server bootstrap.
export function migrateLocalConfigCredentials(
  options: MigrateCredentialsOptions,
): MigrateCredentialsOutcome {
  try {
    if (!existsSync(options.configPath)) {
      return { migrated: false };
    }
    const parsed: unknown = JSON.parse(readFileSync(options.configPath, "utf8"));
    if (!isRecord(parsed) || !hasPlaintextGatewayCredentials(parsed)) {
      return { migrated: false };
    }
    persistSealedGatewayConfig(parsed, {
      env: options.env,
      storagePath: options.configPath,
      evidenceDir: options.evidenceDir,
      ...(options.keychainAccess !== undefined ? { keychainAccess: options.keychainAccess } : {}),
      ...(options.figmaKeychainAccess !== undefined
        ? { figmaKeychainAccess: options.figmaKeychainAccess }
        : {}),
    });
    return { migrated: true };
  } catch {
    // Migration is best-effort: a fault here leaves the plaintext config in place (the atomic write
    // never half-replaces it), the gateway still loads via the legacy plaintext path, and `keiko
    // repair` reports the lingering plaintext so the user can complete the migration deterministically.
    return { migrated: false };
  }
}
