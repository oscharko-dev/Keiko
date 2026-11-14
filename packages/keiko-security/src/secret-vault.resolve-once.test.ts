import { nullSecurityLogSink } from "./log-port.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetResolvedLocalVaultKeysForTest,
  resolveLocalVaultKeyOnce,
  resolvedKeyIsFinal,
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
    sink: sink ?? nullSecurityLogSink(),
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

  it("re-resolves when the keyfile it came from is gone", () => {
    const none = (): undefined => undefined;
    const first = resolveLocalVaultKeyOnce(options(none));
    expect(first.source).toBe("keyfile");
    expect(existsSync(join(dir, "once.key"))).toBe(true);
    rmSync(join(dir, "once.key"));
    const second = resolveLocalVaultKeyOnce(options(none));
    expect(existsSync(join(dir, "once.key"))).toBe(true);
    expect(second.key.equals(first.key)).toBe(false);
    expect(resolveLocalVaultKeyOnce(options(none)).key.equals(second.key)).toBe(true);
  });

  it("follows a changed operator override instead of the remembered key", () => {
    const none = (): undefined => undefined;
    const a = Buffer.alloc(32, 1).toString("base64");
    const b = Buffer.alloc(32, 2).toString("base64");
    const withEnv = (value: string): ResolveLocalVaultKeyOptions => ({
      ...options(none),
      env: { KEIKO_TEST_ONCE_KEY: value },
    });
    expect(resolveLocalVaultKeyOnce(withEnv(a)).key.equals(Buffer.alloc(32, 1))).toBe(true);
    expect(resolveLocalVaultKeyOnce(withEnv(b)).key.equals(Buffer.alloc(32, 2))).toBe(true);
    expect(resolveLocalVaultKeyOnce(withEnv(a)).source).toBe("env");
  });

  it("writes the resolution line once per sink, so another sink still gets its own", () => {
    const access = (): Buffer => Buffer.alloc(32, 4);
    const linesA: unknown[] = [];
    const linesB: unknown[] = [];
    const sinkA: SecurityLogSink = { write: (event) => void linesA.push(event) };
    const sinkB: SecurityLogSink = { write: (event) => void linesB.push(event) };
    resolveLocalVaultKeyOnce(options(access, sinkA));
    resolveLocalVaultKeyOnce(options(access, sinkA));
    resolveLocalVaultKeyOnce(options(access, sinkB));
    resolveLocalVaultKeyOnce(options(access, sinkB));
    expect(linesA).toHaveLength(1);
    expect(linesB).toHaveLength(1);
  });
});

describe("resolvedKeyIsFinal", () => {
  const key = Buffer.alloc(32, 1);
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  afterEach(() => {
    if (real !== undefined) Object.defineProperty(process, "platform", real);
  });
  function onPlatform(platform: string): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  it("keeps a keyfile answer provisional while the real keychain was reachable but silent", () => {
    onPlatform("darwin");
    const reachable = { ...options(() => undefined), keychainAccess: undefined };
    // Under vitest the real keychain is withheld, which is final by itself.
    expect(resolvedKeyIsFinal(reachable, { key, source: "keyfile" })).toBe(true);
    const original = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(resolvedKeyIsFinal(reachable, { key, source: "keyfile" })).toBe(false);
      expect(resolvedKeyIsFinal(reachable, { key, source: "keychain" })).toBe(true);
      const off = { ...reachable, env: { KEIKO_OS_KEYCHAIN: "off" } };
      expect(resolvedKeyIsFinal(off, { key, source: "keyfile" })).toBe(true);
      expect(
        resolvedKeyIsFinal(
          options(() => undefined),
          { key, source: "keyfile" },
        ),
      ).toBe(true);
      onPlatform("linux");
      expect(resolvedKeyIsFinal(reachable, { key, source: "keyfile" })).toBe(true);
    } finally {
      if (original !== undefined) process.env.VITEST = original;
    }
  });
});
