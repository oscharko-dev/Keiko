import assert from "node:assert/strict";
import { test } from "node:test";

import { invoiceTotal } from "../src/invoice.js";

test("an invoice without lines totals zero", () => {
  assert.equal(invoiceTotal([]), 0);
});

test("the total is the sum of every line", () => {
  const lines = [{ amountCents: 1250 }, { amountCents: 300 }, { amountCents: 75 }];
  assert.equal(invoiceTotal(lines), 1625);
});
