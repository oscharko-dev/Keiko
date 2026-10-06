import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAmount, parseAmount } from "./money.ts";

test("parseAmount converts decimal strings to cents", () => {
  assert.equal(parseAmount("12.50"), 1250);
  assert.equal(parseAmount("-3"), -300);
  assert.equal(parseAmount(" $4.2 "), 420);
});

test("parseAmount rejects malformed input", () => {
  assert.throws(() => parseAmount("12.345"), /Invalid amount/);
  assert.throws(() => parseAmount("abc"), /Invalid amount/);
});

test("formatAmount renders two fractional digits", () => {
  assert.equal(formatAmount(1250), "12.50");
  assert.equal(formatAmount(-305), "-3.05");
  assert.equal(formatAmount(0), "0.00");
});
