import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  KEYCHAIN_SPAWN_TIMEOUT_MS,
  readMacosKeychainSecret,
  writeMacosKeychainSecret,
} from "./macos-keychain.js";

const fakeDirs: string[] = [];

// A stand-in for `/usr/bin/security` whose behaviour each test chooses. No test may reach the host
// keychain: its state and policy are not ours, and reading it is the very thing that can raise the
// modal prompt under test.
function fakeSecurity(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-keychain-"));
  fakeDirs.push(dir);
  const path = join(dir, "security");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

afterAll(() => {
  for (const dir of fakeDirs) rmSync(dir, { recursive: true, force: true });
});

// `sleep` stands for a real `security` blocked on a macOS unlock dialog: it returns nothing until a
// human acts. The bounded spawn kills it, so no child outlives the test.
const HANGS = fakeSecurity("sleep 30");
const ANSWERS = fakeSecurity("printf %s AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
// Measured against the shipped binary: 44 is errSecItemNotFound, 1 is an unknown subcommand.
const REFUSES = fakeSecurity("exit 44");
const DENIES = fakeSecurity("exit 1");

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

  it("treats an immediate refusal that is not 'no such item' as unavailable, not absent", () => {
    // A locked, denied or policy-withheld keychain can fail FAST rather than time out. Classifying
    // that as `absent` sends the caller into a write it cannot complete, which is the second
    // bounded wait on the boot path that `unavailable` exists to prevent — so only the measured
    // item-not-found status may mean "store one".
    expect(
      readMacosKeychainSecret("svc", "acct", { executable: DENIES, platform: "darwin" }),
    ).toEqual({ kind: "unavailable" });
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

  it("defaults the platform and the bound when only the executable is supplied", () => {
    // Exercises the production defaults for platform and timeout against a controlled fixture, so
    // no test ever reaches the host keychain. On darwin the fixture answers "no such item"; on any
    // other host the tier reports itself unavailable without spawning at all.
    const read = readMacosKeychainSecret("svc", "acct", { executable: REFUSES });
    expect(read.kind).toBe(process.platform === "darwin" ? "absent" : "unavailable");
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

  it("never puts the secret in the argument vector", () => {
    // `ps` exposes a process's arguments to every process of the same user, which is the audience
    // this tier exists to keep the key away from. The secret must arrive over stdin instead.
    const dir = mkdtempSync(join(tmpdir(), "keiko-keychain-argv-"));
    fakeDirs.push(dir);
    const recorder = join(dir, "security");
    writeFileSync(
      recorder,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\n`,
    );
    chmodSync(recorder, 0o700);

    const secret = "SENTINEL-KEY-MATERIAL";
    expect(
      writeMacosKeychainSecret("svc", "acct", secret, {
        executable: recorder,
        platform: "darwin",
      }),
    ).toBe(true);

    expect(readFileSync(join(dir, "argv"), "utf8")).not.toContain(secret);
    expect(readFileSync(join(dir, "stdin"), "utf8")).toContain(secret);
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
