// Wiring test for `createMemoryVault`'s `securityLogSink` option (Wave 4a, epic #3233 §8).
//
// WHY THIS IS ITS OWN FILE
//
// `CreateMemoryVaultOptions` deliberately exposes no `keychainAccess` test seam — production has
// none either, `resolveVaultKey`'s injectable third argument is built internally by
// `resolveCipherWithSource`, not forwarded from the public factory. That means the real OS
// boundary (`cipher.ts`'s `keyFromKeychain`, backed by `@oscharko-dev/keiko-security`'s bounded
// `/usr/bin/security` spawn) cannot be forced to fail deterministically from `createMemoryVault`'s
// public surface alone. The only hermetic way to observe, from that public surface, whether
// `securityLogSink` actually reaches the keychain tier is to replace `keyFromKeychain` itself with
// a fake that reports "unavailable" while forwarding whatever `sink` option it was called with —
// exactly the contract the real reader documents (`macos-keychain.ts`'s `emitKeychainFallback`).
// `vi.mock` is file-scoped, so this lives apart from `vault.test.ts` to avoid forcing every other
// test in that file through the fake keychain reader.
//
// THE FAILURE THIS PINS
//
// Before the wiring, `resolveCipherWithSource` called `resolveVaultKey(env, memoryDir)` with no
// third argument, so `resolveVaultKey`'s own default (`keyFromKeychain` with no options) ran —
// `options.sink` was always `undefined`, so a keychain fallback never reached ANY sink no matter
// what a caller passed as `securityLogSink`. Reverting the `sink: securityLogSink` forwarding in
// `resolveCipherWithSource` (`vault.ts`) reproduces that: the fake keychain reader below would
// then be called with `options.sink === undefined`, write nothing, and the first test's assertion
// on `events` would fail — exactly the FAILS-BEFORE/PASSES-AFTER property a wiring test needs.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";

vi.mock("./cipher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cipher.js")>();
  return {
    ...actual,
    // Stands in for a keychain that never answers (the 0.3.0 boot-hang class of failure, see
    // `macos-keychain.ts`'s file header): reports `unavailable` (`undefined`, falls through to the
    // keyfile tier) while emitting `security.keychain.fallback` on whatever sink it was given —
    // the same observable contract the real bounded reader has.
    keyFromKeychain: (options: { readonly sink?: SecurityLogSink } = {}): Buffer | undefined => {
      options.sink?.write({
        level: "warn",
        category: "security",
        op: "security.keychain.fallback",
        extra: { reasonKind: "ETIMEDOUT", boundedExitKind: "timeout" },
      });
      return undefined;
    },
  };
});

// Imported AFTER the mock declaration so `createMemoryVault`'s internal `keyFromKeychain` import
// binds to the fake above.
const { createMemoryVault } = await import("./vault.js");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-memvault-keychain-log-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function recordingSink(): { sink: SecurityLogSink; events: SecurityLogEvent[] } {
  const events: SecurityLogEvent[] = [];
  return { sink: { write: (event): void => void events.push(event) }, events };
}

describe("createMemoryVault — securityLogSink wiring to the shared keychain tier", () => {
  it("forwards securityLogSink into the keychain tier so a fallback reaches the caller's sink", () => {
    const { sink, events } = recordingSink();

    const vault = createMemoryVault({
      memoryDir: dir,
      env: {}, // No KEIKO_MEMORY_KEY: forces the (mocked) keychain tier, which falls through to keyfile.
      securityLogSink: sink,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "security",
      op: "security.keychain.fallback",
    });
    vault.close();
  });

  it("never throws, and the vault still opens, when securityLogSink is omitted", () => {
    expect(() => {
      const vault = createMemoryVault({ memoryDir: dir, env: {} });
      vault.close();
    }).not.toThrow();
  });
});
