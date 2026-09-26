// Wiring test for the Figma PAT vault's keychain-tier activity-log seam (Wave 4a, epic #3233 §8).
//
// WHAT THIS PINS
//
// `readFigmaVaultToken`/`figmaTokenStoreFor` (the real, exported composition functions
// `figmaSnapshotOrchestration.ts` hands to route/orchestration callers) omit `deps.keychainAccess`
// in production — it exists only as a test/CI seam, supplied by every OTHER test in
// `figmaSnapshotOrchestration.test.ts`. Production instead falls through this file's own
// `productionKeychainAccess` helper, which wires `processServerLogSink()` into the shared bounded
// keychain reader (`figmaKeychainReader`, `figma/figmaTokenStore.ts`'s `keyFromKeychain`) so a
// keychain that never answers is recorded as `security.keychain.fallback` on `server.log` instead
// of failing silently.
//
// `figmaKeychainReader` is module-mocked here (kept, real, elsewhere: every existing test in this
// package's suite exercises it through an injected `deps.keychainAccess`, which this test
// deliberately omits) so the forced "keychain unavailable" outcome is hermetic and
// platform-independent — the real reader would otherwise spawn the actual OS `security` binary.
//
// THE FAILURE THIS PINS: reverting `processServerLogSink()` to `undefined` (or dropping
// `productionKeychainAccess` entirely, back to passing `deps.keychainAccess` bare) makes the mock
// below observe `options.sink === undefined`, write nothing, and the assertion on `events` fails —
// the FAILS-BEFORE/PASSES-AFTER property a wiring test needs.

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
} from "../../observability/index.js";

vi.mock("../figma/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../figma/index.js")>();
  return {
    ...actual,
    // Stands in for a keychain that never answers (the 0.3.0 boot-hang class of failure — see
    // `macos-keychain.ts`'s file header): reports "unavailable" (`undefined`, falls through to the
    // keyfile tier) while emitting `security.keychain.fallback` on whatever sink it was given, the
    // same observable contract the real bounded reader has.
    figmaKeychainReader: (
      options: { readonly sink?: { write: (event: unknown) => void } } = {},
    ): Buffer | undefined => {
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

// Imported AFTER the mock declaration so `readFigmaVaultToken`/`figmaTokenStoreFor`'s internal
// `figmaKeychainReader` import (via `productionKeychainAccess`) binds to the fake above.
const { readFigmaVaultToken, figmaTokenStoreFor } =
  await import("../figmaSnapshotOrchestration.js");

let dir: string;
let sink: BufferedServerLogSink;

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-figma-keychain-log-"));
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetServerLogger();
  vi.restoreAllMocks();
});

describe("readFigmaVaultToken — production keychain access wires the activity log", () => {
  it("records a keychain fallback on server.log when deps.keychainAccess is omitted", () => {
    // No stored vault token, so `read()` returns undefined regardless — the wiring under test is
    // the log line the (mocked) keychain fallback produces on the way there, not the read result.
    readFigmaVaultToken({ evidenceDir: dir, env: {}, now: new Date(0).toISOString() });

    expect(sink.events).toContainEqual(
      expect.objectContaining({ category: "security", op: "security.keychain.fallback" }),
    );
  });
});

describe("figmaTokenStoreFor — production keychain access wires the activity log", () => {
  it("records a keychain fallback on server.log when deps.keychainAccess is omitted", () => {
    figmaTokenStoreFor({ evidenceDir: dir, env: {} });

    expect(sink.events).toContainEqual(
      expect.objectContaining({ category: "security", op: "security.keychain.fallback" }),
    );
  });
});
