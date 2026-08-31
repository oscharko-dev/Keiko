// Isolated so the `node:fs` mock never leaks into credentialVault.test.ts. persistVaultEntries
// used to call set() once per credential; each set() is a whole-file rewrite. This pin fails if
// that loop returns (#3346).
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialStorePath, sealProviderApiKeys } from "./credentialVault.js";

const renameDestinations: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (oldPath: unknown, newPath: unknown): void => {
      renameDestinations.push(String(newPath));
      (actual.renameSync as (...args: unknown[]) => void)(oldPath, newPath);
    },
  };
});

const REAL_TMPDIR = realpathSync(tmpdir());
const KEY1 = Buffer.alloc(32, 0x11).toString("base64");
const dirs: string[] = [];

afterEach(() => {
  renameDestinations.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persistVaultEntries — write cost (#3346)", () => {
  it("commits the provider-credentials vault file once when sealing N new credentials", () => {
    const dir = realpathSync(mkdtempSync(join(REAL_TMPDIR, "keiko-cred-set-many-io-")));
    dirs.push(dir);
    const configPath = join(dir, "keiko.config.json");
    const vaultPath = resolve(credentialStorePath(configPath));
    const providers = Array.from({ length: 20 }, (_unused, index) => ({
      modelId: `m${String(index)}`,
      baseUrl: "https://gw",
      apiKey: `k${String(index)}`,
    }));

    renameDestinations.length = 0;
    sealProviderApiKeys({
      raw: { providers },
      env: { KEIKO_PROVIDER_CREDENTIALS_KEY: KEY1 },
      configPath,
    });

    expect(renameDestinations.filter((path) => path === vaultPath)).toHaveLength(1);
  });
});
