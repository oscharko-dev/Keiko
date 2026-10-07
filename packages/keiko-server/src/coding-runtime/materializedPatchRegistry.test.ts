import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EDITOR_AGENT_REVIEW_TIMEOUT_MS } from "../editor/agentSessionRegistry.js";
import {
  createMaterializedPatchRegistry,
  MATERIALIZED_PATCH_MAX_ENTRIES,
  MATERIALIZED_PATCH_TTL_MS,
} from "./materializedPatchRegistry.js";

// The registry is the server's record of which diff text it rendered itself. Every test drives the
// clock it is given, so no case sleeps or reads the wall clock.

const PATCH = '--- a/t.js\n+++ b/t.js\n@@ -1 +1 @@\n-"a\\n-b"\n+"a\\n-c"\n';

function clock(start = 1_000_000): {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: (): number => current,
    advance: (ms): void => {
      current += ms;
    },
  };
}

describe("createMaterializedPatchRegistry", () => {
  it("recognizes the exact text it was given and nothing else", () => {
    const registry = createMaterializedPatchRegistry();

    registry.register(PATCH);

    expect(registry.lookup(PATCH).registered).toBe(true);
    // One byte of difference is another diff: a changed line, a trailing line feed, a swapped path.
    expect(registry.lookup(`${PATCH}\n`).registered).toBe(false);
    expect(registry.lookup(PATCH.replace("a/t.js", "a/u.js")).registered).toBe(false);
    expect(registry.lookup(PATCH.slice(0, -1)).registered).toBe(false);
    expect(registry.lookup("").registered).toBe(false);
  });

  it("answers with the SHA-256 of the asked text, and holds nothing but digests and counts", () => {
    const registry = createMaterializedPatchRegistry();
    registry.register(PATCH);

    const hit = registry.lookup(PATCH);
    const miss = registry.lookup("another diff");

    expect(hit.patchSha256).toBe(createHash("sha256").update(PATCH, "utf8").digest("hex"));
    expect(miss.patchSha256).toBe(
      createHash("sha256").update("another diff", "utf8").digest("hex"),
    );
    const stats = registry.stats();
    expect(Object.keys(stats).sort()).toEqual(["entries", "evicted", "expired"]);
    expect(Object.values(stats).every((value) => Number.isInteger(value))).toBe(true);
    expect(JSON.stringify([hit, miss, stats])).not.toContain("a/t.js");
  });

  it("keeps a registration through the editor's whole review window", () => {
    const time = clock();
    const registry = createMaterializedPatchRegistry({ now: time.now });
    registry.register(PATCH);

    time.advance(EDITOR_AGENT_REVIEW_TIMEOUT_MS);

    expect(MATERIALIZED_PATCH_TTL_MS).toBeGreaterThan(EDITOR_AGENT_REVIEW_TIMEOUT_MS);
    expect(registry.lookup(PATCH).registered).toBe(true);
  });

  it("ends a registration at its deadline, counts the expiry once and forgets the digest", () => {
    const time = clock();
    const registry = createMaterializedPatchRegistry({ now: time.now, ttlMs: 60_000 });
    registry.register(PATCH);

    time.advance(59_999);
    expect(registry.lookup(PATCH).registered).toBe(true);
    time.advance(1);
    expect(registry.lookup(PATCH).registered).toBe(false);
    expect(registry.lookup(PATCH).registered).toBe(false);

    expect(registry.stats()).toEqual({ entries: 0, evicted: 0, expired: 1 });
  });

  it("does not consume a registration: the route asks at admission and again at the result", () => {
    const registry = createMaterializedPatchRegistry();
    registry.register(PATCH);

    const answers = [registry.lookup(PATCH), registry.lookup(PATCH), registry.lookup(PATCH)];

    expect(answers.map((answer) => answer.registered)).toEqual([true, true, true]);
    expect(registry.stats().entries).toBe(1);
  });

  it("keeps one entry for a text rendered twice, and the later rendering restarts its lifetime", () => {
    const time = clock();
    const registry = createMaterializedPatchRegistry({ now: time.now, ttlMs: 60_000 });
    registry.register(PATCH);
    time.advance(40_000);

    registry.register(PATCH);
    time.advance(40_000);

    expect(registry.stats().entries).toBe(1);
    expect(registry.lookup(PATCH).registered).toBe(true);
  });

  it("drops the oldest digest first once it holds its maximum, and counts the eviction", () => {
    const registry = createMaterializedPatchRegistry({ maxEntries: 3 });
    for (const text of ["one", "two", "three", "four"]) registry.register(text);

    expect(registry.lookup("one").registered).toBe(false);
    for (const text of ["two", "three", "four"]) {
      expect(registry.lookup(text).registered).toBe(true);
    }
    expect(registry.stats()).toEqual({ entries: 3, evicted: 1, expired: 0 });
  });

  it("still recognizes the diff it was just given when it is asked to hold none", () => {
    const registry = createMaterializedPatchRegistry({ maxEntries: 0 });

    registry.register("one");
    registry.register("two");

    expect(registry.lookup("one").registered).toBe(false);
    expect(registry.lookup("two").registered).toBe(true);
    expect(registry.stats()).toEqual({ entries: 1, evicted: 1, expired: 0 });
  });

  it("moves a re-registered digest to the newest place before it evicts", () => {
    const registry = createMaterializedPatchRegistry({ maxEntries: 3 });
    for (const text of ["one", "two", "three"]) registry.register(text);

    registry.register("one");
    registry.register("four");

    expect(registry.lookup("one").registered).toBe(true);
    expect(registry.lookup("two").registered).toBe(false);
    expect(registry.stats().evicted).toBe(1);
  });

  it("drops expired digests before it evicts a live one", () => {
    const time = clock();
    const registry = createMaterializedPatchRegistry({
      now: time.now,
      ttlMs: 60_000,
      maxEntries: 2,
    });
    registry.register("old");
    time.advance(30_000);
    registry.register("middle");
    time.advance(30_000);

    registry.register("new");

    expect(registry.lookup("old").registered).toBe(false);
    expect(registry.lookup("middle").registered).toBe(true);
    expect(registry.lookup("new").registered).toBe(true);
    expect(registry.stats()).toEqual({ entries: 2, evicted: 0, expired: 1 });
  });

  it("never holds more than its maximum however many diffs are rendered", () => {
    const registry = createMaterializedPatchRegistry();

    for (let index = 0; index < MATERIALIZED_PATCH_MAX_ENTRIES + 50; index += 1) {
      registry.register(`diff ${String(index)}`);
    }

    expect(registry.stats()).toEqual({
      entries: MATERIALIZED_PATCH_MAX_ENTRIES,
      evicted: 50,
      expired: 0,
    });
  });
});
