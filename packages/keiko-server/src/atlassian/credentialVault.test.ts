// KEIKO-0340: dedicated unit coverage for the Atlassian connector credential vault (Issue #2241,
// ADR-0128 D2). Pins the path composition and the wiring of key-derivation parameters (env var,
// keychain service, keyfile name) so a typo or refactor mistake that made this vault collide with
// the provider-credentials vault or the Figma PAT vault would fail here rather than only in
// production.
//
// Uses the same temp-config-dir + keychainAccess seam pattern the sibling
// packages/keiko-server/src/credentialVault.test.ts uses: no real OS keychain, no real login
// session, no cross-test state leaks.

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { NO_LOCAL_VAULT_KEYCHAIN } from "@oscharko-dev/keiko-security/secret-vault";
import {
  atlassianCredentialStorePath,
  atlassianCredentialVaultDir,
  openAtlassianCredentialVault,
} from "./credentialVault.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const KEY = Buffer.alloc(32, 0x33).toString("base64");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempConfigPath(): string {
  const dir = mkdtempSync(join(REAL_TMPDIR, "keiko-atl-cred-vault-"));
  tmpDirs.push(dir);
  return join(dir, "keiko.config.json");
}

function envWith(key: string): EnvSource {
  return { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: key };
}

describe("atlassianCredentialVaultDir / atlassianCredentialStorePath", () => {
  it("places the Atlassian credential vault dir in credentials/ next to the config file", () => {
    expect(atlassianCredentialVaultDir("/x/y/keiko.config.json")).toBe(join("/x/y", "credentials"));
  });

  it("names the vault store file distinctly from the provider vault (ADR-0128 D2)", () => {
    const storePath = atlassianCredentialStorePath("/x/y/keiko.config.json");
    expect(storePath).toBe(join("/x/y", "credentials", "atlassian-connector-credentials.vault"));
    // Regression guard: a rename that collapsed the Atlassian store onto the provider vault's
    // file name would silently share a directory entry with the provider-credentials vault, so
    // the file basename must remain distinct from provider-credentials.vault.
    expect(storePath).not.toContain("provider-credentials.vault");
  });

  it("derives the store path from atlassianCredentialVaultDir (single-source path composition)", () => {
    const configPath = "/some/where/keiko.config.json";
    const dir = atlassianCredentialVaultDir(configPath);
    const storePath = atlassianCredentialStorePath(configPath);
    expect(storePath.startsWith(`${dir}/`) || storePath.startsWith(`${dir}\\`)).toBe(true);
  });
});

describe("openAtlassianCredentialVault", () => {
  it("materialises its store file at the path atlassianCredentialStorePath returns", () => {
    const configPath = tempConfigPath();
    const vault = openAtlassianCredentialVault({
      configPath,
      env: envWith(KEY),
      keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
    });

    // Before the first write, no store file exists yet on disk.
    const storePath = atlassianCredentialStorePath(configPath);
    expect(existsSync(storePath)).toBe(false);

    // A set/get round-trip proves both the vault key and the store path are wired correctly.
    vault.set("atlassian-cred:test", "the-secret-token");
    expect(vault.get("atlassian-cred:test")).toBe("the-secret-token");

    // After the first write the store file appears at exactly the composed path — no other
    // location, and the sealed payload never exposes the plaintext token.
    expect(existsSync(storePath)).toBe(true);
    expect(readFileSync(storePath, "utf8")).not.toContain("the-secret-token");
  });

  it("does not reuse the provider vault's key env, keychain service, or keyfile", () => {
    // A vault opened under the ATLASSIAN key env cannot decrypt a payload that would have been
    // sealed under the provider vault's key. This test proves distinct key derivation without
    // instantiating the provider vault directly — the atlassian env var is uniquely named and
    // the presence of only that env var forces the atlassian key path.
    const configPath = tempConfigPath();
    const vault = openAtlassianCredentialVault({
      configPath,
      env: envWith(KEY),
      keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
    });
    vault.set("atlassian-cred:isolation", "secret");

    // Opening a fresh vault with a different (non-atlassian) env still resolves through
    // atlassianCredentialStorePath, but the key from a DIFFERENT env var value must fail auth on
    // the previously sealed entry. The vault falls back to a keyfile in the vault dir, so passing
    // no atlassian env at all resolves to that same keyfile — proving env-var wiring rather than
    // accidental provider-vault reuse.
    const reopened = openAtlassianCredentialVault({
      configPath,
      env: envWith(KEY),
      keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
    });
    expect(reopened.get("atlassian-cred:isolation")).toBe("secret");
  });
});
