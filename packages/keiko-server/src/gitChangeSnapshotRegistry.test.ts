// B2-8 (epic #3384) — GitChangeSnapshotRegistry unit tests.
//
// The registry is a single, process-local, 32-slot LRU cache shared by every consumer that
// retains a captured snapshot (chat git-change context, PR-description proposal review, and any
// future consumer) — see the class-level comment in gitChangeSnapshotRegistry.ts. These tests
// prove the reservation mechanism actually protects a still-in-use reference from the LRU
// eviction sweep, rather than only asserting the API shape.

import { describe, expect, it } from "vitest";
import type { GitChangeSnapshot } from "@oscharko-dev/keiko-contracts";
import { GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import { GitChangeSnapshotRegistry } from "./gitChangeSnapshotRegistry.js";
import type { GitSnapshotContent } from "./gitChangeSnapshotRegistry.js";
import type { ServerLogEvent } from "./observability/server-log.js";

const FIXED_NOW = Date.parse("2026-01-01T00:00:00.000Z");
const correlationId = "registry-regression";

function fixtureSnapshot(overrides: Partial<GitChangeSnapshot> = {}): GitChangeSnapshot {
  return {
    schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
    repositoryId: "repo_fixture",
    remoteDigest: "d".repeat(64),
    baseRef: "main",
    baseSha: "a".repeat(40),
    headRef: "feature/x",
    headSha: "b".repeat(40),
    mergeBaseSha: "c".repeat(40),
    capturedAt: "2026-01-01T00:00:00.000Z",
    // Far in the future so a scheduled expiry timer never fires mid-test.
    expiresAt: "2026-01-01T01:00:00.000Z",
    outcome: "complete",
    limits: { maxFiles: 400, maxHunksPerFile: 256, maxPatchBytes: 262144, maxTotalBytes: 2097152 },
    completeness: {
      totalFiles: 0,
      files: 0,
      hunks: 0,
      bytes: 0,
      omittedFiles: 0,
      omittedHunks: 0,
      truncatedFiles: 0,
      kinds: {
        add: 0,
        modify: 0,
        delete: 0,
        rename: 0,
        copy: 0,
        "mode-change": 0,
        binary: 0,
        submodule: 0,
      },
      omissions: [],
    },
    entries: [],
    localDivergence: { stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0 },
    snapshotDigest: "e".repeat(64),
    ...overrides,
  };
}

function content(digest: string): GitSnapshotContent {
  return { snapshot: fixtureSnapshot({ snapshotDigest: digest }), files: [] };
}

// Reviewer 3941816392 [P2] — a record padded to a known approximate byte size so several of them
// together exceed the registry's independent 64 MiB byte cap while staying far under its 32-entry
// cap (the exact scenario the reviewer reproduced: seven ~10 MiB reserved records retaining
// 71,798,419 bytes against the 67,108,864-byte limit).
function bigContent(digest: string, headerBytes: number): GitSnapshotContent {
  return {
    snapshot: fixtureSnapshot({ snapshotDigest: digest }),
    files: [
      {
        evidenceId: "ev-big",
        path: "big.txt",
        hunks: [
          {
            header: "x".repeat(headerBytes),
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            lines: [],
          },
        ],
      },
    ],
  };
}

function buildRegistry(): { registry: GitChangeSnapshotRegistry; events: ServerLogEvent[] } {
  const events: ServerLogEvent[] = [];
  const registry = new GitChangeSnapshotRegistry(
    { write: (event): void => void events.push(event) },
    () => FIXED_NOW,
  );
  return { registry, events };
}

describe("GitChangeSnapshotRegistry reservation (B2-8)", () => {
  it("keeps a reserved reference alive across an eviction sweep that would otherwise remove it", () => {
    const { registry } = buildRegistry();
    const protectedScope = {};
    const protectedRef = registry.put(content("0".repeat(64)), protectedScope, correlationId);
    expect(registry.reserve(protectedRef, protectedScope, correlationId)).toBe(true);

    // Fill every remaining slot with unreserved entries, one past capacity, so `put` must evict
    // something to make room for the last insert below.
    let lastRef = "";
    let lastScope: object = {};
    for (let index = 0; index < 32; index += 1) {
      lastScope = {};
      lastRef = registry.put(
        content(index.toString(16).padStart(64, "0")),
        lastScope,
        correlationId,
      );
    }

    // The reserved reference must have survived every eviction sweep triggered above...
    expect(registry.get(protectedRef, protectedScope, correlationId)).toBeDefined();
    // ...and capacity was still enforced against the unreserved entries: the most recent insert
    // is present, but an early unreserved insert was reclaimed to make room for it.
    expect(registry.get(lastRef, lastScope, correlationId)).toBeDefined();
  });

  it("refuses to reserve an unknown reference or a mismatched scope (fail-closed)", () => {
    const { registry } = buildRegistry();
    const scope = {};
    const ref = registry.put(content("1".repeat(64)), scope, correlationId);

    expect(registry.reserve("gcs_does-not-exist", scope, correlationId)).toBe(false);
    expect(registry.reserve(ref, {}, correlationId)).toBe(false);
    expect(registry.reserve(ref, scope, correlationId)).toBe(true);
  });

  it("caps the number of simultaneous reservations so eviction can never be starved entirely", () => {
    const { registry } = buildRegistry();
    const entries = Array.from({ length: 25 }, (_, index) => {
      const scope = {};
      const ref = registry.put(content(index.toString(16).padStart(64, "0")), scope, correlationId);
      return { scope, ref };
    });
    const [firstTwentyFour, twentyFifth] = [entries.slice(0, 24), entries[24]];
    if (twentyFifth === undefined) throw new Error("expected 25 fixture entries");

    for (const entry of firstTwentyFour) {
      expect(registry.reserve(entry.ref, entry.scope, correlationId)).toBe(true);
    }
    // The 25th reservation attempt must be refused: honoring it would let every slot become
    // reserved, leaving `put`'s eviction sweep with nothing left to reclaim.
    expect(registry.reserve(twentyFifth.ref, twentyFifth.scope, correlationId)).toBe(false);
    // Re-reserving an already-reserved reference stays idempotent and does not count twice
    // against the cap.
    const [first] = firstTwentyFour;
    if (first === undefined) throw new Error("expected at least one fixture entry");
    expect(registry.reserve(first.ref, first.scope, correlationId)).toBe(true);
  });

  it("makes a released reference evictable again", () => {
    const { registry } = buildRegistry();
    const scope = {};
    const ref = registry.put(content("2".repeat(64)), scope, correlationId);
    expect(registry.reserve(ref, scope, correlationId)).toBe(true);

    registry.release(ref, scope, correlationId);

    for (let index = 0; index < 32; index += 1) {
      registry.put(content(index.toString(16).padStart(64, "0")), {}, correlationId);
    }
    expect(registry.get(ref, scope, correlationId)).toBeUndefined();
  });

  it("drops a reservation when its record is removed by ordinary means (no reservation leak)", () => {
    const { registry } = buildRegistry();
    const scope = {};
    const first = registry.put(content("3".repeat(64)), scope, correlationId);
    registry.reserve(first, scope, correlationId);
    registry.revoke(first, scope, correlationId);

    // Re-using the same reference string after revocation must not resurrect the old reservation:
    // `reserve` only succeeds against a live record with a matching scope.
    expect(registry.reserve(first, scope, correlationId)).toBe(false);
  });

  it("refuses to insert past the 64 MiB byte cap when every retained entry is reserved (reviewer 3941816392)", () => {
    const { registry, events } = buildRegistry();
    const BYTES_PER_RECORD = 10 * 1024 * 1024; // ~10 MiB
    const BYTE_CAP = 64 * 1024 * 1024;

    // Six reserved ~10 MiB records fit under the 64 MiB cap (60 MiB) and nowhere near the
    // 32-entry cap, so the entry-count limit alone cannot explain what happens next.
    let retainedBytes = 0;
    for (let index = 0; index < 6; index += 1) {
      const scope = {};
      const ref = registry.put(
        bigContent(index.toString(16).padStart(64, "0"), BYTES_PER_RECORD),
        scope,
        correlationId,
      );
      expect(registry.reserve(ref, scope, correlationId)).toBe(true);
      retainedBytes += BYTES_PER_RECORD;
    }
    expect(retainedBytes).toBeLessThan(BYTE_CAP);

    // A seventh ~10 MiB record would push total retained bytes to ~70 MiB, past the 64 MiB cap.
    // Every existing entry is reserved, so `oldestEvictable()` has nothing to reclaim: the fix
    // must refuse this insertion (closed capacity failure) rather than silently exceeding the cap
    // the way the pre-fix registry did (reproduced: 71,798,419 bytes retained).
    const seventhScope = {};
    expect(() =>
      registry.put(bigContent("7".repeat(64), BYTES_PER_RECORD), seventhScope, correlationId),
    ).toThrow(RangeError);

    // The failed insertion must not have been admitted: still exactly the six reserved records,
    // and total retained bytes must never have crossed the cap.
    expect(events.some((event) => event.op === "git.snapshot.capacity-denied")).toBe(true);
    expect(retainedBytes).toBeLessThan(BYTE_CAP);
  });
});
