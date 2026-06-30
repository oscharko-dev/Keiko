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

// True when the environment supplies the exact same effective apiKey, so it must NOT be persisted
// (env credentials stay transient and are never written back to disk). If an env override differs
// from the file value, the file value is still a durable configured credential and must be vaulted so
// behavior survives after the temporary env override is removed.
export function isEnvProvidedApiKey(modelId: string, apiKey: string, env: EnvSource): boolean {
  const perModel = env[`KEIKO_MODEL_${envModelToken(modelId)}_API_KEY`];
  if (perModel !== undefined && perModel.length > 0 && perModel === apiKey) {
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

export interface SealedProviderApiKeys {
  readonly providers: readonly unknown[];
  readonly activeSecretRefs: readonly string[];
}

function existingSecretRef(provider: Record<string, unknown>): string | undefined {
  const value = provider.apiKeySecretRef;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface PlannedProviderCredential {
  readonly provider: unknown;
  readonly activeSecretRef?: string | undefined;
}

function providerWithSecretRef(
  cleaned: Record<string, unknown>,
  reference: string,
): PlannedProviderCredential {
  return { provider: { ...cleaned, apiKeySecretRef: reference }, activeSecretRef: reference };
}

function planPlaintextProviderCredential(
  modelId: string,
  apiKey: string,
  cleaned: Record<string, unknown>,
  configuredRef: string | undefined,
  env: EnvSource,
  vaultedRefs: ReadonlySet<string>,
  toSeal: Map<string, string>,
): PlannedProviderCredential {
  const reference = providerSecretRef(modelId);
  if (!isEnvProvidedApiKey(modelId, apiKey, env)) {
    toSeal.set(reference, apiKey);
    return providerWithSecretRef(cleaned, reference);
  }
  // Env override: preserve the durable vaulted credential + its reference if one already exists.
  const durableRef = configuredRef ?? reference;
  return vaultedRefs.has(durableRef)
    ? providerWithSecretRef(cleaned, durableRef)
    : { provider: cleaned };
}

function planReferenceOnlyProviderCredential(
  modelId: string,
  cleaned: Record<string, unknown>,
  configuredRef: string | undefined,
  vaultedRefs: ReadonlySet<string>,
): PlannedProviderCredential {
  // No plaintext: keep an explicit reference as-is. If the config omitted a reference but a durable
  // vault entry for the model already exists, preserve that entry through a re-save.
  const reference = providerSecretRef(modelId);
  const ref = configuredRef ?? (vaultedRefs.has(reference) ? reference : undefined);
  return ref === undefined ? { provider: cleaned } : providerWithSecretRef(cleaned, ref);
}

// Decides how a single provider is persisted, given the references already present in the vault:
//   - a non-env plaintext key is sealed into the vault and the provider carries its reference;
//   - an env-provided key whose durable credential is ALREADY vaulted keeps its reference and its
//     vaulted value untouched (env is a transient override layered over the durable secret, so the
//     vault entry must survive an env var being later unset — Issue #1320 / review blocker);
//   - a reference-bearing provider with no plaintext (an already-migrated entry) keeps its reference;
//   - a pure-env or referenceless provider is stripped (env stays transient, nothing persists).
// `toSeal` is populated only with new non-env values. Stale refs are pruned only after the config
// rewrite succeeds, so an already reference-only config is never left pointing at deleted vault
// material after a crash.
function planProviderCredential(
  provider: Record<string, unknown>,
  env: EnvSource,
  vaultedRefs: ReadonlySet<string>,
  toSeal: Map<string, string>,
): PlannedProviderCredential {
  const modelId = typeof provider.modelId === "string" ? provider.modelId : "";
  const apiKey = typeof provider.apiKey === "string" ? provider.apiKey : "";
  const cleaned = stripCredentialFields(provider);
  if (modelId.length === 0) {
    return { provider: cleaned };
  }
  const configuredRef = existingSecretRef(provider);
  if (apiKey.length > 0) {
    return planPlaintextProviderCredential(
      modelId,
      apiKey,
      cleaned,
      configuredRef,
      env,
      vaultedRefs,
      toSeal,
    );
  }
  return planReferenceOnlyProviderCredential(modelId, cleaned, configuredRef, vaultedRefs);
}

// Seals each persistable provider apiKey into the credential vault and returns the providers array
// rewritten to carry an `apiKeySecretRef` instead of the plaintext `apiKey`. Vault writes happen
// FIRST (before the caller rewrites the config) so a crash leaves the old plaintext config in place
// and the next migration re-runs idempotently. Pure env credentials are dropped entirely (no
// reference, no vault entry), while env overrides layered over an existing durable vault entry keep
// that reference. Stale refs are pruned only after the config rewrite succeeds, so an already
// reference-only config is never left pointing at deleted vault material after a crash.
export function prepareSealedProviderApiKeys(
  options: SealProviderApiKeysOptions,
): SealedProviderApiKeys {
  const providersRaw: readonly unknown[] = Array.isArray(options.raw.providers)
    ? (options.raw.providers as readonly unknown[])
    : [];
  const vaultedRefs = new Set(readLocalVaultReferences(credentialStorePath(options.configPath)));
  const vaultEntries = new Map<string, string>();
  const activeSecretRefs = new Set<string>();
  const sealedProviders = providersRaw.map((provider) => {
    if (!isRecord(provider)) {
      return provider;
    }
    const planned = planProviderCredential(provider, options.env, vaultedRefs, vaultEntries);
    if (planned.activeSecretRef !== undefined) {
      activeSecretRefs.add(planned.activeSecretRef);
    }
    return planned.provider;
  });
  persistVaultEntries(options, vaultEntries);
  return { providers: sealedProviders, activeSecretRefs: [...activeSecretRefs] };
}

function persistVaultEntries(
  options: SealProviderApiKeysOptions,
  entries: ReadonlyMap<string, string>,
): void {
  if (entries.size === 0) return;
  const vault = openProviderCredentialVault(options);
  for (const [reference, secret] of entries) {
    vault.set(reference, secret);
  }
}

export function pruneProviderCredentialVault(
  options: OpenCredentialVaultOptions,
  activeSecretRefs: readonly string[],
): void {
  const storePath = credentialStorePath(options.configPath);
  if (!existsSync(storePath)) return;
  const active = new Set(activeSecretRefs);
  const vault = openProviderCredentialVault(options);
  for (const reference of vault.list()) {
    if (!active.has(reference)) {
      vault.delete(reference);
    }
  }
}

export function sealProviderApiKeys(options: SealProviderApiKeysOptions): readonly unknown[] {
  const sealed = prepareSealedProviderApiKeys(options);
  return sealed.providers;
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
