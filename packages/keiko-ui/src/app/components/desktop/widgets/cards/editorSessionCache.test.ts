import { describe, expect, it } from "vitest";
import { LruSessionCache } from "./editorSessionCache";

interface Entry {
  readonly protectedEntry?: boolean;
}

function keysInOrder(cache: LruSessionCache<Entry>, candidates: readonly string[]): string[] {
  return candidates.filter((key) => cache.get(key) !== undefined);
}

describe("LruSessionCache", () => {
  it("evicts the least-recently-used entry beyond the capacity", () => {
    const cache = new LruSessionCache<Entry>(2, () => false);
    cache.set("a", {});
    cache.set("b", {});
    cache.set("c", {}); // overflow → "a" (oldest) is evicted
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("treats a get as a use, so the touched entry survives the next overflow", () => {
    const cache = new LruSessionCache<Entry>(2, () => false);
    cache.set("a", {});
    cache.set("b", {});
    cache.get("a"); // "a" is now most-recently-used
    cache.set("c", {}); // overflow → "b" is the oldest now, evicted
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("never evicts a protected entry, even when it is the oldest", () => {
    const cache = new LruSessionCache<Entry>(2, (_key, value) => value.protectedEntry === true);
    cache.set("dirty", { protectedEntry: true }); // oldest, but protected (e.g. unsaved/saving)
    cache.set("b", {});
    cache.set("c", {}); // overflow: "b" (oldest evictable) goes, not the protected one
    expect(cache.get("dirty")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("briefly exceeds the cap when every overflow candidate is protected (correctness over bound)", () => {
    const cache = new LruSessionCache<Entry>(1, (_key, value) => value.protectedEntry === true);
    cache.set("a", { protectedEntry: true });
    cache.set("b", { protectedEntry: true });
    expect(cache.size).toBe(2); // both protected → neither evicted
    expect(keysInOrder(cache, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("deletes entries", () => {
    const cache = new LruSessionCache<Entry>(4, () => false);
    cache.set("a", {});
    expect(cache.delete("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.delete("a")).toBe(false);
  });
});
