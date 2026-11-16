import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cartQuantity, formatPrice } from "./format.js";

describe("formatPrice", () => {
  it("formats cents with two decimals", () => {
    assert.equal(formatPrice(1999), "19.99");
  });

  it("pads a single-digit cent amount", () => {
    assert.equal(formatPrice(1905), "19.05");
  });
});

describe("cartQuantity", () => {
  it("limits the quantity to 1..99", () => {
    assert.equal(cartQuantity(0), 1);
    assert.equal(cartQuantity(500), 99);
    assert.equal(cartQuantity(7), 7);
  });
});
