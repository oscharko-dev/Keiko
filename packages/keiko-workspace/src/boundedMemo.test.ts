import { describe, expect, it } from "vitest";

import { memoizeByStringKey, PATH_MEMO_MAX_ENTRIES } from "./boundedMemo.js";

describe("memoizeByStringKey", () => {
  it("computes once per key and serves repeats from the cache", () => {
    let calls = 0;
    const memoized = memoizeByStringKey(8, (key: string) => {
      calls += 1;
      return `value:${key}`;
    });

    expect(memoized("a")).toBe("value:a");
    expect(memoized("a")).toBe("value:a");
    expect(memoized("b")).toBe("value:b");
    expect(calls).toBe(2);
  });

  it("returns the identical cached object for reference-stable reuse", () => {
    const memoized = memoizeByStringKey(8, (key: string) => ({ key }));
    expect(memoized("x")).toBe(memoized("x"));
  });

  it("flushes the whole cache when the cap is reached instead of evicting per entry", () => {
    let calls = 0;
    const memoized = memoizeByStringKey(2, (key: string) => {
      calls += 1;
      return key.toUpperCase();
    });

    memoized("a"); // size 1
    memoized("b"); // size 2 (cap reached on next insert)
    memoized("c"); // flush, then insert -> only "c" cached
    expect(calls).toBe(3);

    memoized("c"); // hit
    expect(calls).toBe(3);
    memoized("a"); // recompute after flush
    expect(calls).toBe(4);
  });

  it("still computes correct results for hostile keys (empty, unicode, path-like)", () => {
    const memoized = memoizeByStringKey(4, (key: string) => key.length);
    expect(memoized("")).toBe(0);
    expect(memoized("päd/ström.ts")).toBe("päd/ström.ts".length);
    expect(memoized("a/../b\\c")).toBe(8);
    expect(memoized("")).toBe(0);
  });

  it("exports a path memo cap large enough for tens of thousands of paths", () => {
    expect(PATH_MEMO_MAX_ENTRIES).toBeGreaterThanOrEqual(65_536);
  });
});
