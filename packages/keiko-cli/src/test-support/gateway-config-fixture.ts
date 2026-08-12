// Shared test-only fixture builder for CLI tests that need a gateway.json + provider
// credential-vault pair. Extracted from six near-duplicate copies across the CLI test suite
// (audit KEIKO-0130): gateway-config.test.ts, evaluate.test.ts, gen-tests.test.ts,
// investigate.test.ts, models.test.ts, and run-config.test.ts each independently re-wrote the
// same reference-only-config shape with a differently-filled PROVIDER_CREDENTIALS_KEY. A single
// place now owns the schema — a future change to the vault index or the apiKeySecretRef field
// takes one edit instead of six.
//
// This module is deliberately outside the package's public export surface: tsconfig excludes
// `src/test-support/**` from the build and `src/index.ts` does not re-export from here, so it
// never reaches `dist/` and cannot ship in the published tarball.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultChatCapability } from "@oscharko-dev/keiko-model-gateway";
import { openProviderCredentialVault } from "@oscharko-dev/keiko-server/credential-vault";

// The vault key is intentionally reused across every test suite that consumes this fixture. The
// six prior copies filled 32 bytes with 0x31..0x36 to keep their vault files disjoint per file;
// each call still writes to a unique temp dir, so a single filler byte is sufficient.
const CREDENTIALS_KEY_FILLER = 0x30;
const CREDENTIALS_KEY_BYTES = 32;

/** The base64 KEIKO_PROVIDER_CREDENTIALS_KEY every fixture consumer passes to runCli/openVault. */
export const PROVIDER_CREDENTIALS_KEY = Buffer.alloc(
  CREDENTIALS_KEY_BYTES,
  CREDENTIALS_KEY_FILLER,
).toString("base64");

/** A tmpdir with symlinks resolved once — vault path guards refuse any ancestor symlink. */
export const REAL_TMPDIR = realpathSync(tmpdir());

/**
 * A single provider capability. Built via the production `createDefaultChatCapability` factory,
 * then overridden with the scenario-specific fields the test files rely on (`structuredOutput`
 * derived from the "-unstructured" naming convention, cost/latency class from the "-fast"
 * suffix, and Test-flavoured metadata). PR-review follow-up on KEIKO-0130: importing the
 * factory means a change to the capability contract or its defaults propagates automatically
 * instead of leaving this fixture behind — the exact fixture-drift class §7 forbids.
 */
function defaultCapability(modelId: string): Record<string, unknown> {
  const base = createDefaultChatCapability(modelId);
  return {
    ...base,
    structuredOutput: !modelId.includes("unstructured"),
    costClass: modelId.endsWith("-fast") ? "low" : "high",
    latencyClass: modelId.endsWith("-fast") ? "fast" : "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["Test"],
    knownLimitations: [],
  };
}

/** The default plaintext api-key used by every test fixture; NOT a real secret. */
export const FIXTURE_API_KEY = "test-config-secret-value-1234567890";

export interface GatewayConfigOptions {
  /** Provider modelIds to include. */
  readonly modelIds: readonly string[];
  /** Base URL for each provider (defaults to a stable example). */
  readonly baseUrl?: string;
  /** Plaintext api-key value (defaults to FIXTURE_API_KEY). */
  readonly apiKey?: string;
  /**
   * Per-provider capability strategy. Defaults to `"per-provider"`, which attaches
   * `defaultCapability(modelId)` under each provider so tests that need explicit chat capability
   * do not depend on the built-in registry. Pass `"omit"` when the test wants the CLI to fall
   * back to the built-in registry (e.g. asserting that `text-embedding-3-large` is rejected as
   * embedding-only). Pass `"top-level"` to emit a top-level `capabilities` array instead.
   */
  readonly capabilityMode?: "per-provider" | "omit" | "top-level";
  /** Explicit capabilities to emit at the top level (only used with `capabilityMode: "top-level"`). */
  readonly capabilities?: readonly Record<string, unknown>[];
  /** Per-provider timeoutMs (defaults to 30_000). */
  readonly timeoutMs?: number;
  /** Per-provider maxRetries (defaults to 0). */
  readonly maxRetries?: number;
}

function providerRecord(modelId: string, options: GatewayConfigOptions): Record<string, unknown> {
  const mode = options.capabilityMode ?? "per-provider";
  const record: Record<string, unknown> = {
    modelId,
    baseUrl: options.baseUrl ?? "https://provider.example/v1",
    apiKey: options.apiKey ?? FIXTURE_API_KEY,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxRetries: options.maxRetries ?? 0,
    retryBaseDelayMs: 500,
  };
  if (mode === "per-provider") {
    record.capability = defaultCapability(modelId);
  }
  return record;
}

/**
 * Serialises a plaintext-apiKey gateway.json body (no file written). Callers that want a written
 * file can compose with `writeGatewayConfig`.
 */
export function serializeGatewayConfig(options: GatewayConfigOptions): string {
  const body: Record<string, unknown> = {
    providers: options.modelIds.map((modelId) => providerRecord(modelId, options)),
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
  if (options.capabilityMode === "top-level" && options.capabilities !== undefined) {
    body.capabilities = options.capabilities;
  }
  return JSON.stringify(body);
}

/**
 * Writes a plaintext-apiKey gateway.json inside `dir` (fixture must exist) and returns the file
 * path. `filename` defaults to `gateway.json`.
 */
export function writeGatewayConfig(
  dir: string,
  options: GatewayConfigOptions & { readonly filename?: string },
): string {
  const path = join(dir, options.filename ?? "gateway.json");
  writeFileSync(path, serializeGatewayConfig(options), "utf8");
  return path;
}

/**
 * Migrates EVERY provider in an already-written gateway.json from a plaintext apiKey to an
 * apiKeySecretRef, and seeds the on-disk provider credential vault at that path so the CLI's
 * config loader resolves each ref back to the given (or FIXTURE_API_KEY) secret. Exists so callers
 * that maintain their own writeGatewayConfig shape (e.g. evaluate.test.ts's top-level capabilities
 * variant) do not have to repeat the delete/setRef/openVault/set dance six times.
 *
 * PR-review follow-up (KfQ threads 3771064025 + 3771064056): migrates every provider, not just
 * the head, and refuses to overwrite a pre-existing apiKeySecretRef so a caller that already
 * hand-migrated one entry does not lose their ref binding.
 */
export function migrateGatewayConfigToReferenceOnly(
  configPath: string,
  apiKey: string = FIXTURE_API_KEY,
): string {
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
    providers: Record<string, unknown>[];
  };
  if (parsed.providers.length === 0) {
    throw new Error("test fixture must include at least one provider");
  }
  const refsToSeed: { readonly ref: string; readonly key: string }[] = [];
  for (const provider of parsed.providers) {
    const modelId = provider.modelId;
    if (typeof modelId !== "string") {
      throw new TypeError("test fixture provider must have a string modelId");
    }
    if (typeof provider.apiKeySecretRef === "string" && provider.apiKeySecretRef.length > 0) {
      // Caller already established a ref for this provider — do not overwrite; skip the
      // migration for this entry and leave its ref binding untouched.
      continue;
    }
    delete provider.apiKey;
    const ref = `cred:${modelId}`;
    provider.apiKeySecretRef = ref;
    refsToSeed.push({ ref, key: apiKey });
  }
  writeFileSync(configPath, JSON.stringify(parsed), "utf8");
  const vault = openProviderCredentialVault({
    configPath,
    env: { KEIKO_PROVIDER_CREDENTIALS_KEY: PROVIDER_CREDENTIALS_KEY },
  });
  for (const seed of refsToSeed) vault.set(seed.ref, seed.key);
  return configPath;
}

/**
 * Writes an apiKeySecretRef gateway.json inside `dir` AND seeds the on-disk provider credential
 * vault at that path so the CLI's config loader resolves every provider's ref back to
 * `FIXTURE_API_KEY`. All providers are migrated to the reference-only shape; a caller that
 * pre-populated an apiKeySecretRef on one of the entries keeps that ref.
 */
export function writeReferenceOnlyGatewayConfig(
  dir: string,
  options: GatewayConfigOptions & { readonly filename?: string },
): string {
  const path = writeGatewayConfig(dir, options);
  return migrateGatewayConfigToReferenceOnly(path, options.apiKey ?? FIXTURE_API_KEY);
}
