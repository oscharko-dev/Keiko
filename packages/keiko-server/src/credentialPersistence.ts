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

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { LocalVaultKeychainAccess } from "@oscharko-dev/keiko-security/secret-vault";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import { emitServerDiagnostic, type ServerDiagnosticSink } from "./diagnostics-log.js";
import { contentFreeErrorClass } from "@oscharko-dev/keiko-activity-log";
import { savePrivateJson } from "./private-json.js";
import {
  hasPlaintextGatewayCredentials,
  prepareSealedProviderApiKeys,
  pruneProviderCredentialVault,
  secretRefsOfConfig,
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
  // Optional activity-log seam (ADR-0019); the deps.ts/gateway-setup.ts composition roots supply
  // `processServerLogSink()`.
  readonly securityLogSink?: SecurityLogSink | undefined;
  // Optional operator-diagnostic sink (ADR-0173); falls back to the default sink when omitted.
  readonly diagnostics?: ServerDiagnosticSink | undefined;
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

// What a seal may prune: the references the previous version of this config file named (still on
// disk, about to be replaced) minus every reference another config file in the same directory
// names, because references are `cred:<modelId>` and two configs that name one model share one vault
// entry. Anything it cannot read, the previous file or a neighbour, leaves it unable to prove what
// is its own: it prunes nothing, and says so once (closed class, no path).
const NEIGHBOUR_CONFIGS_MAX = 64;
const NEIGHBOUR_CONFIG_BYTES_MAX = 1024 * 1024;

function neighbourSecretRefs(storagePath: string): ReadonlySet<string> {
  const self = basename(storagePath);
  const dir = dirname(storagePath);
  const names = readdirSync(dir).filter((name) => name.endsWith(".json") && name !== self);
  if (names.length > NEIGHBOUR_CONFIGS_MAX) throw new RangeError("too many neighbouring configs");
  return new Set(
    names.sort().flatMap((name) => {
      const path = join(dir, name);
      const info = statSync(path);
      if (!info.isFile()) return [];
      if (info.size > NEIGHBOUR_CONFIG_BYTES_MAX)
        throw new RangeError("neighbouring config too large");
      return secretRefsOfConfig(JSON.parse(readFileSync(path, "utf8")));
    }),
  );
}

function prunableSecretRefs(ctx: SealGatewayConfigContext): readonly string[] {
  try {
    const previous = existsSync(ctx.storagePath)
      ? secretRefsOfConfig(JSON.parse(readFileSync(ctx.storagePath, "utf8")))
      : [];
    if (previous.length === 0) return [];
    const neighbours = neighbourSecretRefs(ctx.storagePath);
    return previous.filter((reference) => !neighbours.has(reference));
  } catch (error) {
    emitServerDiagnostic(ctx.diagnostics, {
      correlationId: randomUUID(),
      timestamp: new Date().toISOString(),
      operation: "credential.previous-config-unreadable",
      source: "credentialPersistence.prunableSecretRefs",
      errorClass: contentFreeErrorClass(error),
      message:
        "The gateway configs in this folder could not all be read; no stored credential is pruned.",
    });
    return [];
  }
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
    securityLogSink: ctx.securityLogSink,
  });
  const withSealedProviders = { ...raw, providers: sealedProviders.providers };
  const withSealedCredentials =
    sealedProviders.reranker === undefined
      ? withSealedProviders
      : { ...withSealedProviders, reranker: sealedProviders.reranker };
  const sealed = stripAndStoreFigmaToken(withSealedCredentials, ctx);
  // Read before the rewrite replaces it: what this config named is what it may give up.
  const previousRefs = prunableSecretRefs(ctx);
  savePrivateJson(ctx.storagePath, sealed);
  pruneProviderCredentialVault(
    {
      env: ctx.env,
      configPath: ctx.storagePath,
      ...(ctx.keychainAccess !== undefined ? { keychainAccess: ctx.keychainAccess } : {}),
      securityLogSink: ctx.securityLogSink,
    },
    sealedProviders.activeSecretRefs,
    previousRefs,
  );
}

export interface MigrateCredentialsOptions {
  readonly configPath: string;
  readonly env: EnvSource;
  readonly evidenceDir: string;
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
  readonly figmaKeychainAccess?: FigmaKeychainAccess | undefined;
  // Optional activity-log seam (ADR-0019); the deps.ts composition root supplies
  // `processServerLogSink()`.
  readonly securityLogSink?: SecurityLogSink | undefined;
  // Optional operator-diagnostic sink (ADR-0173); the deps.ts composition root supplies
  // `options.diagnostics`. Falls back to `defaultServerDiagnosticSink` (via `emitServerDiagnostic`)
  // when omitted, so production never goes silent even when a caller wires nothing in.
  readonly diagnostics?: ServerDiagnosticSink | undefined;
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
      securityLogSink: options.securityLogSink,
      diagnostics: options.diagnostics,
    });
    return { migrated: true };
  } catch (error) {
    // Migration is best-effort: a fault here leaves the plaintext config in place (the atomic write
    // never half-replaces it), the gateway still loads via the legacy plaintext path, and `keiko
    // repair` reports the lingering plaintext so the user can complete the migration deterministically.
    // "Best-effort" must not mean "silent": without this, a plaintext credential configuration can
    // remain in use indefinitely with no operator diagnostic at all. The record is redacted
    // (content-free error class, no config content, no secret material) and correlation-keyed so an
    // operator can find it in the server's activity log.
    emitServerDiagnostic(options.diagnostics, {
      correlationId: randomUUID(),
      timestamp: new Date().toISOString(),
      operation: "credential.migration",
      source: "credentialPersistence.migrateLocalConfigCredentials",
      errorClass: contentFreeErrorClass(error),
      message: "Local credential migration failed; plaintext config remains in place.",
    });
    return { migrated: false };
  }
}
