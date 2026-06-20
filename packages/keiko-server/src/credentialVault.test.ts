// Issue #1320: unit coverage for the dependency-light provider-credential vault policy — the secret
// reference scheme, env-credential classification, plaintext detection, the seal transform, and the
// store-existence-gated resolver that the gateway/CLI inject.

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import {
  createProviderSecretResolver,
  credentialVaultDir,
  hasPlaintextGatewayCredentials,
  isEnvProvidedApiKey,
  openProviderCredentialVault,
  prepareSealedProviderApiKeys,
  providerSecretRef,
  sealProviderApiKeys,
} from "./credentialVault.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const KEY1 = Buffer.alloc(32, 0x11).toString("base64");
const KEY2 = Buffer.alloc(32, 0x22).toString("base64");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempConfigPath(): string {
  const dir = mkdtempSync(join(REAL_TMPDIR, "keiko-cred-vault-"));
  tmpDirs.push(dir);
  return join(dir, "keiko.config.json");
}

function envWith(key: string): EnvSource {
  return { KEIKO_PROVIDER_CREDENTIALS_KEY: key };
}

describe("providerSecretRef / credentialVaultDir", () => {
  it("derives a stable, prefixed reference from the modelId", () => {
    expect(providerSecretRef("gpt-x")).toBe("cred:gpt-x");
  });

  it("places the vault dir next to the config file", () => {
    expect(credentialVaultDir("/x/y/keiko.config.json")).toBe(join("/x/y", "credentials"));
  });
});

describe("isEnvProvidedApiKey", () => {
  it("is true only when the per-model env key equals the effective value", () => {
    expect(
      isEnvProvidedApiKey("gpt-x", "stored-value", {
        KEIKO_MODEL_GPT_X_API_KEY: "stored-value",
      }),
    ).toBe(true);
    expect(
      isEnvProvidedApiKey("gpt-x", "stored-value", {
        KEIKO_MODEL_GPT_X_API_KEY: "temporary-override",
      }),
    ).toBe(false);
  });

  it("is true only when the default env key equals the effective value", () => {
    expect(isEnvProvidedApiKey("gpt-x", "k", { KEIKO_DEFAULT_API_KEY: "k" })).toBe(true);
    expect(isEnvProvidedApiKey("gpt-x", "k", { KEIKO_DEFAULT_API_KEY: "other" })).toBe(false);
  });

  it("is false when no env source provides the credential", () => {
    expect(isEnvProvidedApiKey("gpt-x", "k", {})).toBe(false);
  });
});

describe("hasPlaintextGatewayCredentials", () => {
  it("flags a plaintext provider apiKey", () => {
    expect(
      hasPlaintextGatewayCredentials({ providers: [{ modelId: "m", apiKey: "secret" }] }),
    ).toBe(true);
  });

  it("flags a plaintext figma accessToken", () => {
    expect(
      hasPlaintextGatewayCredentials({ providers: [], figma: { accessToken: "figd_x" } }),
    ).toBe(true);
  });

  it("does not flag a reference-only provider", () => {
    expect(
      hasPlaintextGatewayCredentials({ providers: [{ modelId: "m", apiKeySecretRef: "cred:m" }] }),
    ).toBe(false);
  });

  it("does not flag a whitespace-only figma token, empty providers, or a non-object", () => {
    expect(hasPlaintextGatewayCredentials({ providers: [], figma: { accessToken: "   " } })).toBe(
      false,
    );
    expect(hasPlaintextGatewayCredentials({ providers: [] })).toBe(false);
    expect(hasPlaintextGatewayCredentials("not-an-object")).toBe(false);
  });
});

describe("openProviderCredentialVault", () => {
  it("seals and resolves a credential round-trip", () => {
    const configPath = tempConfigPath();
    const vault = openProviderCredentialVault({ configPath, env: envWith(KEY1) });
    vault.set("cred:m", "secret-value");
    expect(vault.get("cred:m")).toBe("secret-value");
    const store = readFileSync(
      join(credentialVaultDir(configPath), "provider-credentials.vault"),
      "utf8",
    );
    expect(store).not.toContain("secret-value");
  });
});

describe("sealProviderApiKeys", () => {
  it("seals plaintext keys into the vault and rewrites providers with references", () => {
    const configPath = tempConfigPath();
    const env = envWith(KEY1);
    const providers = sealProviderApiKeys({
      raw: {
        providers: [
          { modelId: "m1", baseUrl: "https://gw", apiKey: "k1" },
          { modelId: "m2", baseUrl: "https://gw", apiKey: "k2" },
        ],
      },
      env,
      configPath,
    });
    expect(providers).toEqual([
      { modelId: "m1", baseUrl: "https://gw", apiKeySecretRef: "cred:m1" },
      { modelId: "m2", baseUrl: "https://gw", apiKeySecretRef: "cred:m2" },
    ]);
    const vault = openProviderCredentialVault({ configPath, env });
    expect(vault.get("cred:m1")).toBe("k1");
    expect(vault.get("cred:m2")).toBe("k2");
  });

  it("drops env-provided credentials without a reference or vault entry", () => {
    const configPath = tempConfigPath();
    const env: EnvSource = { ...envWith(KEY1), KEIKO_DEFAULT_API_KEY: "env-key" };
    const providers = sealProviderApiKeys({
      raw: { providers: [{ modelId: "m1", baseUrl: "https://gw", apiKey: "env-key" }] },
      env,
      configPath,
    });
    expect(providers).toEqual([{ modelId: "m1", baseUrl: "https://gw" }]);
    expect(existsSync(join(credentialVaultDir(configPath), "provider-credentials.vault"))).toBe(
      false,
    );
  });

  it("vaults a durable file credential when a per-model env override has a different value", () => {
    const configPath = tempConfigPath();
    const env: EnvSource = {
      ...envWith(KEY1),
      KEIKO_MODEL_GPT_X_API_KEY: "temporary-env-key",
    };
    const providers = sealProviderApiKeys({
      raw: {
        providers: [{ modelId: "gpt-x", baseUrl: "https://gw", apiKey: "durable-file-key" }],
      },
      env,
      configPath,
    });
    expect(providers).toEqual([
      { modelId: "gpt-x", baseUrl: "https://gw", apiKeySecretRef: "cred:gpt-x" },
    ]);
    expect(openProviderCredentialVault({ configPath, env }).get("cred:gpt-x")).toBe(
      "durable-file-key",
    );
  });

  it("removes a stale store when no providers need vaulting", () => {
    const configPath = tempConfigPath();
    const env = envWith(KEY1);
    // Seed a store, then re-seal a config whose only provider is env-provided.
    openProviderCredentialVault({ configPath, env }).set("cred:old", "stale");
    sealProviderApiKeys({
      raw: { providers: [{ modelId: "m1", baseUrl: "https://gw" }] },
      env,
      configPath,
    });
    expect(existsSync(join(credentialVaultDir(configPath), "provider-credentials.vault"))).toBe(
      false,
    );
  });

  it("preserves active reference-only credentials while pruning stale refs after sealing", () => {
    const configPath = tempConfigPath();
    const env = envWith(KEY1);
    const vault = openProviderCredentialVault({ configPath, env });
    vault.set("cred:m1", "active-secret");
    vault.set("cred:stale", "stale-secret");

    const providers = sealProviderApiKeys({
      raw: {
        providers: [{ modelId: "m1", baseUrl: "https://gw", apiKeySecretRef: "cred:m1" }],
      },
      env,
      configPath,
    });

    expect(providers).toEqual([
      { modelId: "m1", baseUrl: "https://gw", apiKeySecretRef: "cred:m1" },
    ]);
    expect(vault.get("cred:m1")).toBe("active-secret");
    expect(vault.get("cred:stale")).toBeUndefined();
  });

  it("does not prune stale refs during prepare before the config rewrite succeeds", () => {
    const configPath = tempConfigPath();
    const env = envWith(KEY1);
    const vault = openProviderCredentialVault({ configPath, env });
    vault.set("cred:m1", "active-secret");
    vault.set("cred:stale", "stale-secret");

    const prepared = prepareSealedProviderApiKeys({
      raw: {
        providers: [{ modelId: "m1", baseUrl: "https://gw", apiKeySecretRef: "cred:m1" }],
      },
      env,
      configPath,
    });

    expect(prepared.activeSecretRefs).toEqual(["cred:m1"]);
    expect(vault.get("cred:m1")).toBe("active-secret");
    expect(vault.get("cred:stale")).toBe("stale-secret");
  });
});

describe("createProviderSecretResolver", () => {
  it("returns undefined and never generates a key when no store exists", () => {
    const configPath = tempConfigPath();
    const resolve = createProviderSecretResolver({ configPath, env: envWith(KEY1) });
    expect(resolve("cred:m")).toBeUndefined();
    // Gated on store existence — no keyfile is materialised for a credential-free config.
    expect(existsSync(credentialVaultDir(configPath))).toBe(false);
  });

  it("resolves a sealed reference once the store exists", () => {
    const configPath = tempConfigPath();
    openProviderCredentialVault({ configPath, env: envWith(KEY1) }).set("cred:m", "secret");
    const resolve = createProviderSecretResolver({ configPath, env: envWith(KEY1) });
    expect(resolve("cred:m")).toBe("secret");
    expect(resolve("cred:absent")).toBeUndefined();
  });

  it("degrades to undefined when the vault cannot be opened with the configured key", () => {
    const configPath = tempConfigPath();
    openProviderCredentialVault({ configPath, env: envWith(KEY1) }).set("cred:m", "secret");
    // A different key cannot authenticate the sealed entry; the resolver must not throw.
    const resolve = createProviderSecretResolver({ configPath, env: envWith(KEY2) });
    expect(resolve("cred:m")).toBeUndefined();
  });
});
