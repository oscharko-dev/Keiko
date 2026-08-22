// Wiring test for `createBffMemoryVault`'s `securityLogSink` option (Wave 4a, epic #3233 §8).
//
// WHAT THIS PINS
//
// `createBffMemoryVault` (`memory-handlers.ts`) is the ONE production caller of
// `createMemoryVault` (`@oscharko-dev/keiko-memory-vault`) in this codebase's BFF composition. It
// already threads `logSink: processServerLogSink()`; this pins that it ALSO threads
// `securityLogSink: processServerLogSink()`, the option `createMemoryVault` (Wave 4a, epic #3233
// §8) forwards into the shared bounded keychain reader so a keychain fallback lands on
// `server.log` instead of being silently dropped.
//
// `@oscharko-dev/keiko-memory-vault` is module-mocked (kept elsewhere real: every other test in
// this file's package uses the genuine vault) so the OPTIONS OBJECT `createBffMemoryVault` builds
// is directly observable without needing to force a real OS keychain failure — the vault's own
// `securityLogSink` → `keyFromKeychain` wiring is separately pinned in
// `packages/keiko-memory-vault/src/vault-keychain-log-wiring.test.ts`; this file's job is only the
// SERVER composition boundary between the two.
//
// THE FAILURE THIS PINS: dropping `securityLogSink: processServerLogSink()` from
// `createBffMemoryVault`'s call to `createMemoryVault` makes the captured options carry no
// `securityLogSink`, and the first assertion below fails.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "./observability/index.js";

type CreateMemoryVaultOptions = Parameters<
  typeof import("@oscharko-dev/keiko-memory-vault").createMemoryVault
>[0];

let captured: CreateMemoryVaultOptions;

vi.mock("@oscharko-dev/keiko-memory-vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-memory-vault")>();
  return {
    ...actual,
    createMemoryVault: (
      options: CreateMemoryVaultOptions,
    ): ReturnType<typeof actual.createMemoryVault> => {
      captured = options;
      return actual.createMemoryVault(options);
    },
  };
});

// Imported AFTER the mock declaration so `createBffMemoryVault`'s internal `createMemoryVault`
// import binds to the capturing wrapper above.
const { createBffMemoryVault } = await import("./memory-handlers.js");

let dir: string;
let sink: BufferedServerLogSink;

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-memory-handlers-secloG-"));
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  captured = undefined;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetServerLogger();
  vi.restoreAllMocks();
});

describe("createBffMemoryVault — securityLogSink composition wiring", () => {
  it("passes securityLogSink to createMemoryVault, and it reaches server.log when written to", () => {
    const vault = createBffMemoryVault((value: string) => value, undefined, undefined, {
      KEIKO_MEMORY_DIR: dir,
    });
    try {
      expect(captured?.securityLogSink).toBeDefined();

      // Prove the captured sink is not merely present but IS the process-wide activity log: a
      // write through it must reach `server.log`, exactly like the wired keychain tier would
      // produce on a real fallback.
      captured?.securityLogSink?.write({
        level: "warn",
        category: "security",
        op: "security.keychain.fallback",
        extra: { reasonKind: "ETIMEDOUT", boundedExitKind: "timeout" },
      });

      expect(sink.events).toContainEqual(
        expect.objectContaining({ category: "security", op: "security.keychain.fallback" }),
      );
    } finally {
      vault.close();
    }
  });
});
