import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry } from "./ledger.ts";
import {
  categorize,
  recurringEntries,
  renderTable,
  share,
  summarizeAccounts,
  summarizeCategories,
} from "./report.ts";

const entries: readonly Entry[] = [
  { date: "2026-01-05", account: "checking", description: "Salary", amount: 300000 },
  { date: "2026-01-09", account: "checking", description: "Rent", amount: -120000 },
  { date: "2026-01-28", account: "card", description: "Groceries", amount: -8450 },
  { date: "2026-02-09", account: "checking", description: "Rent", amount: -120000 },
  { date: "2026-02-15", account: "checking", description: "Electricity", amount: -9610 },
];

test("renderTable pads columns and underlines the header", () => {
  const table = renderTable(
    [
      { header: "Name", align: "left" },
      { header: "Amount", align: "right" },
    ],
    [
      ["a", "1.00"],
      ["bbb", "-12.50"],
    ],
  );
  assert.equal(table, "Name  Amount\n----  ------\na       1.00\nbbb   -12.50");
});

test("summarizeAccounts separates income and expenses per account", () => {
  const [card, checking] = summarizeAccounts(entries);
  assert.deepEqual(card, { account: "card", entryCount: 1, income: 0, expenses: -8450, balance: -8450 });
  assert.equal(checking?.income, 300000);
  assert.equal(checking?.expenses, -249610);
});

test("categorize uses the first matching keyword rule", () => {
  assert.equal(categorize(entries[1] as Entry), "Housing");
  assert.equal(categorize({ ...(entries[0] as Entry), description: "Consulting" }), "Other");
});

test("summarizeCategories lists expense categories largest first with their share", () => {
  const [housing, food] = summarizeCategories(entries);
  assert.equal(housing?.category, "Housing");
  assert.equal(housing?.total, -249610);
  assert.equal(food?.category, "Food");
  assert.equal(share(-8450, -258060), 3.3);
});

test("recurringEntries reports a description and amount seen in two months once", () => {
  const recurring = recurringEntries(entries);
  assert.deepEqual(
    recurring.map((entry) => entry.description),
    ["Rent"],
  );
});
