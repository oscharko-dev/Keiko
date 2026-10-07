import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger } from "./ledger.ts";

function sampleLedger(): Ledger {
  const ledger = new Ledger();
  ledger.add({ date: "2026-01-05", account: "checking", description: "Salary", amount: 300000 });
  ledger.add({ date: "2026-01-09", account: "checking", description: "Rent", amount: -120000 });
  ledger.add({ date: "2026-01-12", account: "card", description: "Groceries", amount: -8450 });
  return ledger;
}

test("balance sums all entries", () => {
  assert.equal(sampleLedger().balance(), 171550);
});

test("balance can be restricted to one account", () => {
  assert.equal(sampleLedger().balance("card"), -8450);
});

test("monthly totals are in chronological order and correctly keyed", () => {
  const ledger = new Ledger();
  ledger.add({ date: "2026-02-01", account: "a", description: "Feb", amount: 100 });
  ledger.add({ date: "2026-01-01", account: "a", description: "Jan", amount: 200 });
  
  const totals = ledger.monthlyTotals();
  const keys = Array.from(totals.keys());
  
  assert.deepEqual(keys, ["2026-01", "2026-02"]);
  assert.equal(totals.get("2026-01"), 200);
  assert.equal(totals.get("2026-02"), 100);
});

test("monthly totals handle start-of-month dates independently of timezone", () => {
  const ledger = new Ledger();
  // 2026-01-01 is often shifted to 2025-12-31 in UTC- offset timezones when parsed as local.
  ledger.add({ date: "2026-01-01", account: "a", description: "New Year", amount: 100 });
  
  const totals = ledger.monthlyTotals();
  assert.ok(totals.has("2026-01"), "Should have 2026-01 key");
  assert.equal(totals.get("2026-01"), 100);
});

test("add rejects invalid dates", () => {
  assert.throws(
    () => new Ledger().add({ date: "05.01.2026", account: "a", description: "x", amount: 1 }),
    /Invalid date/,
  );
});
