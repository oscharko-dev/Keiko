import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KEYCHAIN_SPAWN_TIMEOUT_MS,
  readMacosKeychainSecret,
  writeMacosKeychainSecret,
} from "./macos-keychain.js";

// A stand-in for `/usr/bin/security` whose behaviour each test chooses. `sleep` is the case that
// matters: it stands for a real `security` blocked on a macOS unlock dialog, which returns nothing
// until a human acts.
function fakeSecurity(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-keychain-"));
  const path = join(dir, "security");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

const HANGS = fakeSecurity("sleep 30");
const ANSWERS = fakeSecurity("printf %s AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
const REFUSES = fakeSecurity("exit 44"); // `security`'s "item could not be found" exit code.

describe("readMacosKeychainSecret", () => {
  it("gives up on a keychain that never answers instead of waiting for it", () => {
    const started = process.hrtime.bigint();
    const read = readMacosKeychainSecret("svc", "acct", {
      executable: HANGS,
      timeoutMs: 250,
      platform: "darwin",
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // The load-bearing assertion is the elapsed time: against an unbounded spawn this call blocks
    // for the full 30s and the test fails on the suite timeout instead of here.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(read).toEqual({ kind: "unavailable" });
  }, 15_000);

  it("distinguishes a keychain that answers 'no such item' from one that does not answer", () => {
    // `absent` invites the caller to store a key; `unavailable` must not, or the caller spends a
    // second timeout on the boot path.
    expect(
      readMacosKeychainSecret("svc", "acct", { executable: REFUSES, platform: "darwin" }),
    ).toEqual({
      kind: "absent",
    });
  });

  it("returns the stored secret without surrounding whitespace", () => {
    const read = readMacosKeychainSecret("svc", "acct", {
      executable: ANSWERS,
      platform: "darwin",
    });
    expect(read).toEqual({
      kind: "found",
      secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
  });

  it("reports the tier unavailable off darwin without spawning anything", () => {
    // HANGS would block for 30s if it were spawned, so returning promptly is the proof.
    const started = process.hrtime.bigint();
    const read = readMacosKeychainSecret("svc", "acct", { executable: HANGS, platform: "linux" });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1_000);
    expect(read).toEqual({ kind: "unavailable" });
  });

  it("bounds the production call without a caller-supplied timeout", () => {
    expect(KEYCHAIN_SPAWN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(KEYCHAIN_SPAWN_TIMEOUT_MS)).toBe(true);
  });

  it("resolves the production defaults when the caller supplies no options at all", () => {
    // Exercises the shipped configuration — host platform, the system `security` path, the
    // production bound — rather than only the seams. The service name cannot exist, so on darwin
    // this is a read of an absent item and on any other host the tier reports itself unavailable
    // without spawning. Both mean "no key from this tier", which is the entire caller contract, so
    // the assertion holds on every host without the test knowing which one it runs on.
    const read = readMacosKeychainSecret("keiko-service-that-cannot-exist", "keiko-test-account");
    expect(["absent", "unavailable"]).toContain(read.kind);
  });
});

describe("writeMacosKeychainSecret", () => {
  it("gives up on a keychain that never answers instead of waiting for it", () => {
    const started = process.hrtime.bigint();
    const stored = writeMacosKeychainSecret("svc", "acct", "secret", {
      executable: HANGS,
      timeoutMs: 250,
      platform: "darwin",
    });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(5_000);
    expect(stored).toBe(false);
  }, 15_000);

  it("reports a refused store as not stored rather than throwing", () => {
    expect(
      writeMacosKeychainSecret("svc", "acct", "secret", {
        executable: REFUSES,
        platform: "darwin",
      }),
    ).toBe(false);
  });

  it("reports a successful store", () => {
    expect(
      writeMacosKeychainSecret("svc", "acct", "secret", {
        executable: ANSWERS,
        platform: "darwin",
      }),
    ).toBe(true);
  });

  it("does not spawn off darwin", () => {
    const started = process.hrtime.bigint();
    expect(
      writeMacosKeychainSecret("svc", "acct", "secret", { executable: HANGS, platform: "linux" }),
    ).toBe(false);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1_000);
  });

  it("honours a caller-supplied executable while defaulting the rest", () => {
    // Only `executable` is supplied, so the platform and the bound come from the production
    // defaults. On darwin the fake answers and the store reports success; elsewhere the tier is
    // unavailable and reports failure. Either way it returns a boolean promptly and never throws.
    const started = process.hrtime.bigint();
    const stored = writeMacosKeychainSecret("svc", "acct", "secret", { executable: ANSWERS });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(5_000);
    expect(stored).toBe(process.platform === "darwin");
  });
});
