import assert from "node:assert/strict";
import { test } from "node:test";

import { statementTotal } from "../src/statement.js";

test("a statement without lines totals zero", () => {
  assert.equal(statementTotal([]), "0.00");
});

test("the total is the sum of every line", () => {
  const lines = [{ amountCents: 1250 }, { amountCents: 300 }, { amountCents: 75 }];
  assert.equal(statementTotal(lines), "16.25");
});
