import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent, SecurityLogSink } from "./log-port.js";
import {
  KEYCHAIN_SPAWN_TIMEOUT_MS,
  emitKeychainFallback,
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
// `exec` REPLACES the shell with sleep, so the spawn timeout's kill reaches the hanging process
// itself — a plain `sleep 30` would fork a child the timeout cannot reach, leaking an orphaned
// sleep across later suites (review finding on #3037).
const HANGS = fakeSecurity("exec sleep 30");
const ANSWERS = fakeSecurity("printf %s AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
const STORES = fakeSecurity("cat >/dev/null");
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
      readMacosKeychainSecret("svc", "acct", {
        executable: REFUSES,
        platform: "darwin",
        timeoutMs: 30_000,
      }),
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
      readMacosKeychainSecret("svc", "acct", {
        executable: DENIES,
        platform: "darwin",
        timeoutMs: 30_000,
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("returns the stored secret without surrounding whitespace", () => {
    const read = readMacosKeychainSecret("svc", "acct", {
      executable: ANSWERS,
      platform: "darwin",
      timeoutMs: 30_000,
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

  it("refuses a caller-supplied timeout that would disable the bound", () => {
    // execFileSync reads `timeout: 0` as "no timeout". Honouring a caller's 0 would restore the
    // unbounded spawn this module exists to remove — so the production bound applies instead, and
    // the call still returns rather than waiting for the 30s fixture.
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const started = process.hrtime.bigint();
      const read = readMacosKeychainSecret("svc", "acct", {
        executable: HANGS,
        timeoutMs,
        platform: "darwin",
      });
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(10_000);
      expect(read).toEqual({ kind: "unavailable" });
    }
  }, 60_000);

  it("defaults the platform when the platform option is omitted", () => {
    // Exercises the production platform default against a controlled fixture (the bound comes
    // from the load-proof test budget), so no test ever reaches the host keychain. On darwin the
    // fixture answers "no such item"; on any other host the tier reports itself unavailable
    // without spawning at all.
    const read = readMacosKeychainSecret("svc", "acct", { executable: REFUSES, timeoutMs: 30_000 });
    expect(read.kind).toBe(process.platform === "darwin" ? "absent" : "unavailable");
  });

  it("resolves the default executable path itself when none is supplied, off darwin", () => {
    // `resolveSpawn` computes the `options.executable ?? MACOS_SECURITY_EXECUTABLE` default
    // unconditionally, before the darwin check short-circuits — so this exercises that default
    // branch without ever spawning the real `/usr/bin/security` (the early non-darwin return fires
    // first, exactly as the equivalent-executable HANGS-off-darwin test above proves for the
    // caller-supplied path).
    const started = process.hrtime.bigint();
    const read = readMacosKeychainSecret("svc", "acct", { platform: "linux" });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1_000);
    expect(read).toEqual({ kind: "unavailable" });
  });

  it("applies the production spawn bound when timeoutMs is omitted", () => {
    // The one call that really omits timeoutMs runs against the HANGING fixture on purpose: a
    // fast fixture would flake on a saturated runner (the incident this file hardens against),
    // while the hang deterministically proves the production bound fires — the call returns
    // unavailable after ~KEYCHAIN_SPAWN_TIMEOUT_MS instead of waiting 30s for the fixture.
    const started = process.hrtime.bigint();
    const read = readMacosKeychainSecret("svc", "acct", { executable: HANGS, platform: "darwin" });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeGreaterThanOrEqual(KEYCHAIN_SPAWN_TIMEOUT_MS - 100);
    expect(elapsedMs).toBeLessThan(15_000);
    expect(read).toEqual({ kind: "unavailable" });
  }, 20_000);
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
        timeoutMs: 30_000,
      }),
    ).toBe(false);
  });

  it("reports a successful store", () => {
    expect(
      writeMacosKeychainSecret("svc", "acct", "secret", {
        executable: STORES,
        platform: "darwin",
        timeoutMs: 30_000,
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
        timeoutMs: 30_000,
      }),
    ).toBe(true);

    expect(readFileSync(join(dir, "argv"), "utf8")).not.toContain(secret);
    expect(readFileSync(join(dir, "stdin"), "utf8")).toContain(secret);
  });

  it("updates an existing item rather than being refused as a duplicate", () => {
    // Without `-U`, `security` rejects an add whose item already exists (status 45, measured), so
    // the documented "replace an undecodable stored key" path would silently never replace.
    const dir = mkdtempSync(join(tmpdir(), "keiko-keychain-update-"));
    fakeDirs.push(dir);
    const recorder = join(dir, "security");
    writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > /dev/null\n`);
    chmodSync(recorder, 0o700);

    writeMacosKeychainSecret("svc", "acct", "secret", {
      executable: recorder,
      platform: "darwin",
      timeoutMs: 30_000,
    });
    expect(readFileSync(join(dir, "argv"), "utf8").split("\n")).toContain("-U");
  });

  it("does not spawn off darwin", () => {
    const started = process.hrtime.bigint();
    expect(
      writeMacosKeychainSecret("svc", "acct", "secret", { executable: HANGS, platform: "linux" }),
    ).toBe(false);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1_000);
  });

  it("honours a caller-supplied executable while defaulting the platform", () => {
    // Only `executable` (plus the load-proof test budget) is supplied, so the platform comes
    // from the production default. On darwin the fake answers and the store reports success;
    // elsewhere the tier is unavailable and reports failure. Either way it returns a boolean
    // promptly and never throws.
    const started = process.hrtime.bigint();
    const stored = writeMacosKeychainSecret("svc", "acct", "secret", {
      executable: STORES,
      timeoutMs: 30_000,
    });
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(5_000);
    expect(stored).toBe(process.platform === "darwin");
  });

  it("applies the production spawn bound to writes when timeoutMs is omitted", () => {
    // Same rationale as the read-side omitted-timeout pin: the hanging fixture makes the
    // production default deterministic — the write gives up after ~KEYCHAIN_SPAWN_TIMEOUT_MS.
    const started = process.hrtime.bigint();
    const stored = writeMacosKeychainSecret("svc", "acct", "secret", {
      executable: HANGS,
      platform: "darwin",
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeGreaterThanOrEqual(KEYCHAIN_SPAWN_TIMEOUT_MS - 100);
    expect(elapsedMs).toBeLessThan(15_000);
    expect(stored).toBe(false);
  }, 20_000);
});

// The wiring the 0.3.0 boot-hang incident (file header) was missing: a fallback now emits ONE
// event, carrying only closed-vocabulary/duration fields — never the service/account name, and
// never the executable path or the OS error's message.
describe("readMacosKeychainSecret sink wiring", () => {
  function recordingSink(): { sink: SecurityLogSink; events: SecurityLogEvent[] } {
    const events: SecurityLogEvent[] = [];
    return {
      sink: {
        write: (event): void => {
          events.push(event);
        },
      },
      events,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one security.keychain.fallback event, with only the documented fields, when the keychain refuses immediately", () => {
    const { sink, events } = recordingSink();

    const read = readMacosKeychainSecret("svc", "acct", {
      executable: DENIES,
      platform: "darwin",
      timeoutMs: 30_000,
      sink,
    });

    expect(read).toEqual({ kind: "unavailable" });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      level: "warn",
      category: "security",
      op: "security.keychain.fallback",
      extra: { reasonKind: "Error", boundedExitKind: "exit-status" },
    });
    expect(typeof event?.durationMs).toBe("number");
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(event ?? {}).sort()).toEqual([
      "category",
      "durationMs",
      "extra",
      "level",
      "op",
    ]);
    // Never the service/account this call was made with, never a path.
    expect(JSON.stringify(event)).not.toContain("svc");
    expect(JSON.stringify(event)).not.toContain("acct");
  });

  it("classifies a timed-out spawn distinctly from an immediate refusal", () => {
    const { sink, events } = recordingSink();

    readMacosKeychainSecret("svc", "acct", {
      executable: HANGS,
      platform: "darwin",
      timeoutMs: 250,
      sink,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "security.keychain.fallback",
      extra: { reasonKind: "ETIMEDOUT", boundedExitKind: "timeout" },
    });
  }, 15_000);

  it("does not emit for the ordinary first-run case (item not found)", () => {
    const { sink, events } = recordingSink();

    const read = readMacosKeychainSecret("svc", "acct", {
      executable: REFUSES,
      platform: "darwin",
      timeoutMs: 30_000,
      sink,
    });

    expect(read).toEqual({ kind: "absent" });
    expect(events).toHaveLength(0);
  });

  it("does not emit when the call succeeds", () => {
    const { sink, events } = recordingSink();

    readMacosKeychainSecret("svc", "acct", {
      executable: ANSWERS,
      platform: "darwin",
      timeoutMs: 30_000,
      sink,
    });

    expect(events).toHaveLength(0);
  });

  it("degrades a throwing sink without ever failing the read (degrade-once idiom)", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const dead: SecurityLogSink = {
      write: (): never => {
        throw new Error("sink transport is down");
      },
    };

    const read = readMacosKeychainSecret("svc", "acct", {
      executable: DENIES,
      platform: "darwin",
      timeoutMs: 30_000,
      sink: dead,
    });

    expect(read).toEqual({ kind: "unavailable" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays exactly as silent as before when no sink is wired", () => {
    expect(() => {
      readMacosKeychainSecret("svc", "acct", {
        executable: DENIES,
        platform: "darwin",
        timeoutMs: 30_000,
      });
    }).not.toThrow();
  });
});

// classifyBoundedExit's closed vocabulary end to end: readMacosKeychainSecret's own fixtures only
// ever reach "timeout" (HANGS) and "exit-status" (DENIES/REFUSES). The other two members —
// "signal" and "spawn-error" — describe spawn shapes `execFileSync` can produce that this suite's
// shell-script fixtures cannot fabricate on demand, so they are exercised directly through
// `emitKeychainFallback`, the exported reporter both keychain surfaces in this package share
// [GEN-MAINT-COUPLING-006]. "unknown" covers a thrown value that is not even an object.
describe("emitKeychainFallback — boundedExitKind classification", () => {
  function recordingSink(): { sink: SecurityLogSink; events: SecurityLogEvent[] } {
    const events: SecurityLogEvent[] = [];
    return {
      sink: {
        write: (event): void => {
          events.push(event);
        },
      },
      events,
    };
  }

  it("classifies a thrown non-object value as unknown", () => {
    const { sink, events } = recordingSink();
    emitKeychainFallback(sink, "plain string throw", () => 0);
    expect(events).toHaveLength(1);
    expect(events[0]?.extra).toMatchObject({ boundedExitKind: "unknown" });
  });

  it("classifies a thrown null as unknown", () => {
    const { sink, events } = recordingSink();
    emitKeychainFallback(sink, null, () => 0);
    expect(events).toHaveLength(1);
    expect(events[0]?.extra).toMatchObject({ boundedExitKind: "unknown" });
  });

  it("classifies a spawn killed by signal as signal", () => {
    const { sink, events } = recordingSink();
    emitKeychainFallback(sink, { signal: "SIGKILL" }, () => 0);
    expect(events).toHaveLength(1);
    expect(events[0]?.extra).toMatchObject({ boundedExitKind: "signal" });
  });

  it("classifies a spawn failure carrying a string code other than ETIMEDOUT as spawn-error", () => {
    const { sink, events } = recordingSink();
    emitKeychainFallback(sink, { code: "ENOENT" }, () => 0);
    expect(events).toHaveLength(1);
    expect(events[0]?.extra).toMatchObject({ boundedExitKind: "spawn-error" });
  });
});
