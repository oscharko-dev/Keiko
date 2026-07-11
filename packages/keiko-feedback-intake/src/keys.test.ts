import { describe, expect, it } from "vitest";
import { InMemorySecretRing } from "./keys.js";
import type { IntakeSecretKey } from "./types.js";

function key(id: string, month: number): IntakeSecretKey {
  return {
    id,
    key: new Uint8Array(32).fill(month),
    activatedAt: new Date(`2026-${String(month).padStart(2, "0")}-01T00:00:00Z`),
  };
}

describe("independent rotating key custody", () => {
  it("keeps at most active plus two predecessors and destroys overflow", () => {
    const ring = new InMemorySecretRing(key("one", 1), 2);
    ring.rotate(key("two", 2));
    ring.rotate(key("three", 3));
    ring.rotate(key("four", 4));
    const custody = ring.snapshot(new Date("2026-04-01T00:00:00Z"));
    expect(custody.active.id).toBe("four");
    expect(custody.predecessors.map((item) => item.id)).toEqual(["three", "two"]);
    expect(ring.destroyed).toEqual(["one"]);
  });

  it("returns snapshots so callers cannot mutate custody material", () => {
    const ring = new InMemorySecretRing(key("one", 1), 1);
    const copy = ring.snapshot(new Date("2026-01-01T00:00:00Z"));
    copy.active.key[0] = 99;
    expect(ring.snapshot(new Date("2026-01-01T00:00:00Z")).active.key[0]).toBe(1);
  });
});
