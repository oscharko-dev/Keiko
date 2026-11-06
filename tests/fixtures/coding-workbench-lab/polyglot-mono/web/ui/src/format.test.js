import { describe, expect, it } from "vitest";

import { cartQuantity, formatPrice } from "./format.js";

describe("formatPrice", () => {
  it("formats cents with two decimals", () => {
    expect(formatPrice(1999)).toBe("19.99");
  });

  it("pads a single-digit cent amount", () => {
    expect(formatPrice(1905)).toBe("19.05");
  });
});

describe("cartQuantity", () => {
  it("limits the quantity to 1..99", () => {
    expect(cartQuantity(0)).toBe(1);
    expect(cartQuantity(500)).toBe(99);
    expect(cartQuantity(7)).toBe(7);
  });
});
