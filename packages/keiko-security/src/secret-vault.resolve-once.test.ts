import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetResolvedLocalVaultKeysForTest,
  resolveLocalVaultKeyOnce,
  type ResolveLocalVaultKeyOptions,
} from "./secret-vault.js";
import type { SecurityLogSink } from "./log-port.js";

let dir: string;

beforeEach(() => {
  resetResolvedLocalVaultKeysForTest();
  dir = mkdtempSync(join(tmpdir(), "keiko-resolve-once-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function options(
  keychainAccess: () => Buffer | undefined,
  sink?: SecurityLogSink,
): ResolveLocalVaultKeyOptions {
  return {
    env: {},
    vaultDir: dir,
    envVarName: "KEIKO_TEST_ONCE_KEY",
    keychainService: "keiko-test-once",
    keyfileName: "once.key",
    keychainAccess,
    sink,
  };
}

describe("resolveLocalVaultKeyOnce", () => {
  it("runs the keychain tier and logs the resolution once across repeated calls", () => {
    let keychainCalls = 0;
    const events: unknown[] = [];
    const sink: SecurityLogSink = { write: (event) => void events.push(event) };
    const access = (): Buffer => {
      keychainCalls += 1;
      return Buffer.alloc(32, 3);
    };
    const first = resolveLocalVaultKeyOnce(options(access, sink));
    for (let i = 0; i < 20; i += 1) {
      const next = resolveLocalVaultKeyOnce(options(access, sink));
      expect(next.key.equals(first.key)).toBe(true);
      expect(next.source).toBe("keychain");
    }
    expect(keychainCalls).toBe(1);
    expect(events).toHaveLength(1);
  });

  it("hands out copies so a caller cannot corrupt the remembered key", () => {
    const access = (): Buffer => Buffer.alloc(32, 5);
    const first = resolveLocalVaultKeyOnce(options(access));
    first.key.fill(0);
    expect(resolveLocalVaultKeyOnce(options(access)).key.equals(Buffer.alloc(32, 5))).toBe(true);
  });

  it("does not cache a failed resolution", () => {
    let calls = 0;
    const access = (): Buffer => {
      calls += 1;
      if (calls === 1) throw new Error("keychain locked");
      return Buffer.alloc(32, 9);
    };
    expect(() => resolveLocalVaultKeyOnce(options(access))).toThrow("keychain locked");
    expect(resolveLocalVaultKeyOnce(options(access)).key.equals(Buffer.alloc(32, 9))).toBe(true);
    expect(calls).toBe(2);
  });

  it("keeps vault directories independent", () => {
    let calls = 0;
    const access = (): Buffer => {
      calls += 1;
      return Buffer.alloc(32, 1);
    };
    resolveLocalVaultKeyOnce(options(access));
    resolveLocalVaultKeyOnce({ ...options(access), vaultDir: join(dir, "other") });
    expect(calls).toBe(2);
  });
});
