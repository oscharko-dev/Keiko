// Issue #1320: one-time migration of an existing plaintext keiko.config.json into encrypted local
// storage, exercised through the real server bootstrap (buildUiHandlerDeps). These tests are the
// acceptance evidence for "existing plaintext config credentials are migrated to encrypted storage
// and replaced by stable references without losing configured model/provider behavior", for the
// Figma PAT routing, for env-credential transience, for crash-aware idempotency, and for the
// redaction guarantee.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFromFile } from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, currentGatewayConfig } from "./deps.js";
import type { BuildHandlerDepsOptions } from "./deps.js";
import { createProviderSecretResolver, openProviderCredentialVault } from "./credentialVault.js";

const REAL_TMPDIR = realpathSync(tmpdir());

const VAULT_ENV: Readonly<Record<string, string>> = {
  KEIKO_PROVIDER_CREDENTIALS_KEY: Buffer.alloc(32, 0x21).toString("base64"),
  KEIKO_FIGMA_KEY: Buffer.alloc(32, 0x42).toString("base64"),
};

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(REAL_TMPDIR, prefix));
  tmpDirs.push(dir);
  return dir;
}

interface Layout {
  readonly uiDir: string;
  readonly evidenceDir: string;
  readonly configPath: string;
  readonly credentialStorePath: string;
  readonly figmaVaultPath: string;
  options(env: Readonly<Record<string, string | undefined>>): BuildHandlerDepsOptions;
}

function layout(): Layout {
  const uiDir = tempDir("keiko-mig-ui-");
  const evidenceDir = tempDir("keiko-mig-ev-");
  return {
    uiDir,
    evidenceDir,
    configPath: join(uiDir, "keiko.config.json"),
    credentialStorePath: join(uiDir, "credentials", "provider-credentials.vault"),
    figmaVaultPath: join(evidenceDir, "figma", "figma-token.vault"),
    options(env): BuildHandlerDepsOptions {
      return {
        configPath: undefined,
        evidenceDir,
        env,
        uiDbPath: join(uiDir, "keiko-ui.db"),
      };
    },
  };
}

function writeConfig(configPath: string, raw: Record<string, unknown>): void {
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

function legacyConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: [
      {
        modelId: "gpt-x",
        baseUrl: "https://gw.example.com",
        apiKey: "legacy-secret-key",
        apiKeyHeaderName: "authorization",
        timeoutMs: 30_000,
        maxRetries: 2,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    ...extra,
  };
}

describe("local credential migration (#1320)", () => {
  it("migrates a plaintext provider apiKey into the vault and rewrites the config with a reference", () => {
    const l = layout();
    writeConfig(l.configPath, legacyConfig());
    const deps = buildUiHandlerDeps(l.options({ ...VAULT_ENV }));
    try {
      const onDisk = readFileSync(l.configPath, "utf8");
      expect(onDisk).not.toContain("legacy-secret-key");
      expect(onDisk).toContain("apiKeySecretRef");
      expect(onDisk).toContain("cred:gpt-x");

      expect(existsSync(l.credentialStorePath)).toBe(true);
      const store = readFileSync(l.credentialStorePath, "utf8");
      expect(store).not.toContain("legacy-secret-key");
      expect(store).toContain("cred:gpt-x");

      // The running gateway still resolves the real credential from the vault.
      expect(currentGatewayConfig(deps)?.providers[0]?.apiKey).toBe("legacy-secret-key");
      expect(currentGatewayConfig(deps)?.providers[0]?.baseUrl).toBe("https://gw.example.com");
    } finally {
      deps.store.close();
    }
  });

  it("migrates an explicit config path instead of only the default local config", () => {
    const l = layout();
    const explicitDir = tempDir("keiko-mig-explicit-");
    const explicitConfigPath = join(explicitDir, "custom-keiko.config.json");
    const explicitStorePath = join(explicitDir, "credentials", "provider-credentials.vault");
    writeConfig(explicitConfigPath, legacyConfig());

    const deps = buildUiHandlerDeps({
      ...l.options({ ...VAULT_ENV }),
      configPath: explicitConfigPath,
    });

    try {
      const explicitDisk = readFileSync(explicitConfigPath, "utf8");
      expect(explicitDisk).not.toContain("legacy-secret-key");
      expect(explicitDisk).toContain("apiKeySecretRef");
      expect(existsSync(explicitStorePath)).toBe(true);
      expect(existsSync(l.credentialStorePath)).toBe(false);
      expect(deps.gatewayConfig?.storagePath).toBe(explicitConfigPath);
      expect(currentGatewayConfig(deps)?.providers[0]?.apiKey).toBe("legacy-secret-key");
    } finally {
      deps.store.close();
    }
  });

  it("routes a plaintext figma.accessToken into the encrypted Figma vault and drops it from JSON", () => {
    const l = layout();
    writeConfig(l.configPath, legacyConfig({ figma: { accessToken: "figd_legacy-token" } }));
    const deps = buildUiHandlerDeps(l.options({ ...VAULT_ENV }));
    try {
      const onDisk = readFileSync(l.configPath, "utf8");
      expect(onDisk).not.toContain("figd_legacy-token");
      expect(onDisk).not.toContain('"figma"');

      expect(existsSync(l.figmaVaultPath)).toBe(true);
      const figmaVault = readFileSync(l.figmaVaultPath, "utf8");
      expect(figmaVault).not.toContain("figd_legacy-token");
      expect(figmaVault.startsWith("kv1.")).toBe(true);
    } finally {
      deps.store.close();
    }
  });

  it("is idempotent: a second bootstrap over the migrated config makes no further change", () => {
    const l = layout();
    writeConfig(l.configPath, legacyConfig({ figma: { accessToken: "figd_legacy-token" } }));
    const first = buildUiHandlerDeps(l.options({ ...VAULT_ENV }));
    first.store.close();
    const afterFirst = readFileSync(l.configPath, "utf8");

    const second = buildUiHandlerDeps(l.options({ ...VAULT_ENV }));
    try {
      expect(readFileSync(l.configPath, "utf8")).toBe(afterFirst);
      expect(readFileSync(l.configPath, "utf8")).not.toContain("legacy-secret-key");
      expect(currentGatewayConfig(second)?.providers[0]?.apiKey).toBe("legacy-secret-key");
    } finally {
      second.store.close();
    }
  });

  it("completes a partially migrated config (plaintext still present alongside a reference)", () => {
    // Simulates a crash after the vault write but before/within the config rewrite: the file still
    // carries the plaintext apiKey. Re-running the migration must seal it and strip the plaintext.
    const l = layout();
    writeConfig(
      l.configPath,
      legacyConfig({
        providers: [
          {
            modelId: "gpt-x",
            baseUrl: "https://gw.example.com",
            apiKey: "legacy-secret-key",
            apiKeySecretRef: "cred:gpt-x",
            timeoutMs: 30_000,
            maxRetries: 2,
            retryBaseDelayMs: 500,
          },
        ],
      }),
    );
    const deps = buildUiHandlerDeps(l.options({ ...VAULT_ENV }));
    try {
      const onDisk = readFileSync(l.configPath, "utf8");
      expect(onDisk).not.toContain("legacy-secret-key");
      expect(onDisk).toContain("cred:gpt-x");
      expect(currentGatewayConfig(deps)?.providers[0]?.apiKey).toBe("legacy-secret-key");
    } finally {
      deps.store.close();
    }
  });

  it("does not write an env-provided credential back to disk (env stays transient)", () => {
    const l = layout();
    // The provider's stored value equals the default env key, so env is authoritative: migration must
    // neither vault it nor leave a reference — the provider resolves from the environment at load.
    writeConfig(
      l.configPath,
      legacyConfig({
        providers: [
          {
            modelId: "gpt-x",
            baseUrl: "https://gw.example.com",
            apiKey: "env-default-key",
            timeoutMs: 30_000,
            maxRetries: 2,
            retryBaseDelayMs: 500,
          },
        ],
      }),
    );
    const deps = buildUiHandlerDeps(
      l.options({ ...VAULT_ENV, KEIKO_DEFAULT_API_KEY: "env-default-key" }),
    );
    try {
      const onDisk = readFileSync(l.configPath, "utf8");
      expect(onDisk).not.toContain("env-default-key");
      expect(onDisk).not.toContain("apiKeySecretRef");
      // No durable secret was written: the credential store is absent.
      expect(existsSync(l.credentialStorePath)).toBe(false);
      // The runtime still resolves the credential — transiently, from the environment.
      expect(currentGatewayConfig(deps)?.providers[0]?.apiKey).toBe("env-default-key");
    } finally {
      deps.store.close();
    }
  });

  it("preserves a different durable file credential when a per-model env override is present", () => {
    const l = layout();
    writeConfig(l.configPath, legacyConfig());
    const envWithOverride = {
      ...VAULT_ENV,
      KEIKO_MODEL_GPT_X_API_KEY: "temporary-env-key",
    };

    const deps = buildUiHandlerDeps(l.options(envWithOverride));
    try {
      const onDisk = readFileSync(l.configPath, "utf8");
      expect(onDisk).not.toContain("legacy-secret-key");
      expect(onDisk).toContain("apiKeySecretRef");
      const vault = openProviderCredentialVault({ configPath: l.configPath, env: envWithOverride });
      expect(vault.get("cred:gpt-x")).toBe("legacy-secret-key");

      // While the override is present, runtime behavior still honors the env value.
      expect(currentGatewayConfig(deps)?.providers[0]?.apiKey).toBe("temporary-env-key");

      // After the override is removed, the durable file credential still resolves from the vault.
      const withoutOverride = loadConfigFromFile(
        l.configPath,
        { ...VAULT_ENV },
        {
          secretResolver: createProviderSecretResolver({
            configPath: l.configPath,
            env: VAULT_ENV,
          }),
        },
      );
      expect(withoutOverride.providers[0]?.apiKey).toBe("legacy-secret-key");
    } finally {
      deps.store.close();
    }
  });

  it("leaves an env-only config (no plaintext, no references) untouched", () => {
    const l = layout();
    writeConfig(
      l.configPath,
      legacyConfig({
        providers: [
          {
            modelId: "gpt-x",
            baseUrl: "https://gw.example.com",
            timeoutMs: 30_000,
            maxRetries: 2,
            retryBaseDelayMs: 500,
          },
        ],
      }),
    );
    const before = readFileSync(l.configPath, "utf8");
    const deps = buildUiHandlerDeps(
      l.options({ ...VAULT_ENV, KEIKO_DEFAULT_API_KEY: "env-default-key" }),
    );
    try {
      // Nothing to migrate (no plaintext credential present), so the file is not rewritten.
      expect(readFileSync(l.configPath, "utf8")).toBe(before);
      expect(existsSync(l.credentialStorePath)).toBe(false);
      expect(currentGatewayConfig(deps)?.providers[0]?.apiKey).toBe("env-default-key");
    } finally {
      deps.store.close();
    }
  });

  it("degrades gracefully when the credential vault is deleted after migration", () => {
    const l = layout();
    writeConfig(l.configPath, legacyConfig());
    const first = buildUiHandlerDeps(l.options({ ...VAULT_ENV }));
    first.store.close();
    // Simulate vault corruption/loss: the reference survives in config, the sealed store is gone.
    rmSync(l.credentialStorePath, { force: true });

    // Re-bootstrap must NOT throw; the unresolvable reference simply yields no usable provider.
    const second = buildUiHandlerDeps(l.options({ ...VAULT_ENV }));
    try {
      // Config on disk still holds no plaintext — only the (now-orphaned) reference.
      const onDisk = readFileSync(l.configPath, "utf8");
      expect(onDisk).not.toContain("legacy-secret-key");
      expect(onDisk).toContain("cred:gpt-x");
      // The credential cannot be resolved, so no provider is activated (honest, not a silent default).
      expect(currentGatewayConfig(second)?.providers[0]?.apiKey).toBeUndefined();
    } finally {
      second.store.close();
    }
  });

  it("keeps the live redactor scrubbing the vault-resolved credential (AC5)", () => {
    const l = layout();
    writeConfig(l.configPath, legacyConfig());
    const deps = buildUiHandlerDeps(l.options({ ...VAULT_ENV }));
    try {
      const redacted = JSON.stringify(
        deps.redactor({ note: "token is legacy-secret-key here", url: "https://gw.example.com" }),
      );
      expect(redacted).not.toContain("legacy-secret-key");
    } finally {
      deps.store.close();
    }
  });
});
