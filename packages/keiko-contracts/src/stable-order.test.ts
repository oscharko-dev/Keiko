import { describe, expect, it } from "vitest";

import { sortedStrings } from "./stable-order.js";

describe("sortedStrings", () => {
  it("returns a localeCompare-ordered copy without mutating the caller's collection", () => {
    const values = ["zeta", "alpha", "delta"];

    expect(sortedStrings(values)).toEqual(["alpha", "delta", "zeta"]);
    expect(values).toEqual(["zeta", "alpha", "delta"]);
  });

  it("accepts generic string iterables such as sets", () => {
    expect(sortedStrings(new Set(["beta", "alpha", "gamma"]))).toEqual(["alpha", "beta", "gamma"]);
  });
});
