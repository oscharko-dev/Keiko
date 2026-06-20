// Provider-credential vault policy (Issue #1320, Epic #1319).
//
// This is the local, dependency-light glue between the generic AES-256-GCM secret vault
// (@oscharko-dev/keiko-security/secret-vault) and the Model Gateway config. It owns:
//   - the stable, NON-SECRET reference scheme persisted in keiko.config.json (`cred:<modelId>`),
//   - where the encrypted provider-credential store lives (a `credentials/` dir next to the config),
//   - the env -> keychain -> keyfile key namespace for that store,
//   - the read-side resolver the gateway/CLI inject to turn a reference back into a real apiKey,
//   - the write-side transform that seals provider apiKeys and strips plaintext from the config.
//
// It deliberately imports nothing heavy (no server barrel, no SQLite, no Figma orchestration) so the
// offline `keiko run` and `keiko repair` commands can resolve/detect credentials without loading the
// full BFF runtime. Figma PAT routing and the migration orchestration live in credentialPersistence.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createLocalSecretVault,
  readLocalVaultReferences,
  resolveLocalVaultKey,
  type LocalSecretVault,
  type LocalVaultKeychainAccess,
} from "@oscharko-dev/keiko-security/secret-vault";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";

// Structurally identical to the gateway's ProviderSecretResolver (kept local so keiko-server does not
// force a new name onto the gateway's barrel surface, which the root product package re-exports).
export type ProviderSecretResolver = (reference: string) => string | undefined;

const CREDENTIALS_SUBDIR = "credentials";
const CREDENTIALS_STORE_FILE = "provider-credentials.vault";
const CREDENTIALS_KEYFILE = "provider-credentials-vault.key";
const CREDENTIALS_KEY_ENV = "KEIKO_PROVIDER_CREDENTIALS_KEY";
const CREDENTIALS_KEYCHAIN_SERVICE = "keiko-provider-credentials-vault";

// The reference prefix is an opaque, NON-SECRET marker stored in plaintext config alongside the
// (separately keyed) sealed material. It is derived from the provider modelId — already present in
// the same config entry — so it is stable across re-saves and migrations and leaks nothing new.
export const PROVIDER_SECRET_REF_PREFIX = "cred:";

export function providerSecretRef(modelId: string): string {
  return `${PROVIDER_SECRET_REF_PREFIX}${modelId}`;
}

// The credential store lives next to keiko.config.json so a copied or synced config directory carries
// only its separately-keyed ciphertext — never plaintext, and never the key when env/keychain tiers
// are in use.
export function credentialVaultDir(configPath: string): string {
  return join(dirname(configPath), CREDENTIALS_SUBDIR);
}

export function credentialStorePath(configPath: string): string {
  return join(credentialVaultDir(configPath), CREDENTIALS_STORE_FILE);
}

export interface OpenCredentialVaultOptions {
  readonly configPath: string;
  readonly env: EnvSource;
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
}

export function openProviderCredentialVault(options: OpenCredentialVaultOptions): LocalSecretVault {
  const vaultDir = credentialVaultDir(options.configPath);
  const { key } = resolveLocalVaultKey({
    env: options.env,
    vaultDir,
    envVarName: CREDENTIALS_KEY_ENV,
    keychainService: CREDENTIALS_KEYCHAIN_SERVICE,
    keyfileName: CREDENTIALS_KEYFILE,
    ...(options.keychainAccess !== undefined ? { keychainAccess: options.keychainAccess } : {}),
  });
  return createLocalSecretVault({ key, storePath: credentialStorePath(options.configPath) });
}

// A crypto-free resolver for the gateway/CLI: maps `cred:<modelId>` to its plaintext secret. It is
// store-existence-gated so a config without vaulted credentials (env-only or legacy plaintext) never
// triggers key generation, and degrades to undefined on any vault fault so a locked/tampered vault
// surfaces as the gateway's honest "apiKey must be set" config error rather than a crash.
export function createProviderSecretResolver(
  options: OpenCredentialVaultOptions,
): ProviderSecretResolver {
  const storePath = credentialStorePath(options.configPath);
  let vault: LocalSecretVault | undefined;
  return (reference: string): string | undefined => {
    if (!existsSync(storePath)) return undefined;
    try {
      vault ??= openProviderCredentialVault(options);
      return vault.get(reference);
    } catch {
      return undefined;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envModelToken(modelId: string): string {
  return modelId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

// True when the environment already supplies this provider's apiKey, so it must NOT be persisted
// (env credentials stay transient and are never written back to disk). The two cases mirror the
// gateway's resolution precedence exactly:
//   - a per-model env override always wins at load, regardless of what the config stores;
//   - the default env key only governs when it equals the effective value (otherwise a distinct
//     setup-submitted key must be vaulted so it is not silently shadowed by the default env key).
export function isEnvProvidedApiKey(modelId: string, apiKey: string, env: EnvSource): boolean {
  const perModel = env[`KEIKO_MODEL_${envModelToken(modelId)}_API_KEY`];
  if (perModel !== undefined && perModel.length > 0) {
    return true;
  }
  const defaultKey = env.KEIKO_DEFAULT_API_KEY;
  return defaultKey !== undefined && defaultKey.length > 0 && defaultKey === apiKey;
}

function stripCredentialFields(provider: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(provider)) {
    if (key !== "apiKey" && key !== "apiKeySecretRef") {
      out[key] = value;
    }
  }
  return out;
}

export interface SealProviderApiKeysOptions {
  readonly raw: Record<string, unknown>;
  readonly env: EnvSource;
  readonly configPath: string;
  readonly keychainAccess?: LocalVaultKeychainAccess | undefined;
}

function existingRef(provider: Record<string, unknown>): string | undefined {
  const ref = provider.apiKeySecretRef;
  return typeof ref === "string" && ref.length > 0 ? ref : undefined;
}

// Decides how a single provider is persisted, given the references already present in the vault:
//   - a non-env plaintext key is sealed into the vault and the provider carries its reference;
//   - an env-provided key whose durable credential is ALREADY vaulted keeps its reference and its
//     vaulted value untouched (env is a transient override layered over the durable secret, so the
//     vault entry must survive an env var being later unset — Issue #1320 / review blocker);
//   - a reference-bearing provider with no plaintext (an already-migrated entry) keeps its reference;
//   - a pure-env or referenceless provider is stripped (env stays transient, nothing persists).
// `toSeal` is populated only with NEW non-env values; the vault is merged (never wholesale-replaced),
// so no previously-vaulted credential is ever deleted by a re-save.
function planProviderCredential(
  provider: Record<string, unknown>,
  env: EnvSource,
  vaultedRefs: ReadonlySet<string>,
  toSeal: Map<string, string>,
): unknown {
  const modelId = typeof provider.modelId === "string" ? provider.modelId : "";
  const apiKey = typeof provider.apiKey === "string" ? provider.apiKey : "";
  const cleaned = stripCredentialFields(provider);
  if (modelId.length === 0) {
    return cleaned;
  }
  const reference = providerSecretRef(modelId);
  if (apiKey.length > 0) {
    if (!isEnvProvidedApiKey(modelId, apiKey, env)) {
      toSeal.set(reference, apiKey);
      return { ...cleaned, apiKeySecretRef: reference };
    }
    // Env override: preserve the durable vaulted credential + its reference if one already exists.
    return vaultedRefs.has(reference) ? { ...cleaned, apiKeySecretRef: reference } : cleaned;
  }
  // No plaintext: keep a reference only if it resolves to a real vaulted entry.
  const ref = existingRef(provider) ?? reference;
  return vaultedRefs.has(ref) ? { ...cleaned, apiKeySecretRef: ref } : cleaned;
}

// Seals each persistable provider apiKey into the credential vault and returns the providers array
// rewritten to carry an `apiKeySecretRef` instead of the plaintext `apiKey`. Vault writes happen
// FIRST (before the caller rewrites the config) so a crash leaves the old plaintext config in place
// and the next migration re-runs idempotently. The vault is MERGED, never wholesale-replaced: a
// re-save updates the providers it owns and leaves every other (incl. env-overridden) entry intact.
export function sealProviderApiKeys(options: SealProviderApiKeysOptions): readonly unknown[] {
  const providersRaw: readonly unknown[] = Array.isArray(options.raw.providers)
    ? (options.raw.providers as readonly unknown[])
    : [];
  const vaultedRefs = new Set(readLocalVaultReferences(credentialStorePath(options.configPath)));
  const toSeal = new Map<string, string>();
  const sealedProviders = providersRaw.map((provider) =>
    isRecord(provider)
      ? planProviderCredential(provider, options.env, vaultedRefs, toSeal)
      : provider,
  );
  if (toSeal.size > 0) {
    const vault = openProviderCredentialVault(options);
    for (const [reference, secret] of toSeal) {
      vault.set(reference, secret);
    }
  }
  return sealedProviders;
}

// Structural detector for an UNMIGRATED or partially migrated config: any provider still carrying a
// plaintext apiKey, or a figma block still carrying a plaintext accessToken. Pure and read-only —
// `keiko repair` uses it to flag an incomplete credential migration without opening any vault.
export function hasPlaintextGatewayCredentials(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  const providerHasPlaintext = providers.some(
    (provider) =>
      isRecord(provider) && typeof provider.apiKey === "string" && provider.apiKey.length > 0,
  );
  const figma = raw.figma;
  const figmaHasPlaintext =
    isRecord(figma) && typeof figma.accessToken === "string" && figma.accessToken.trim().length > 0;
  return providerHasPlaintext || figmaHasPlaintext;
}
