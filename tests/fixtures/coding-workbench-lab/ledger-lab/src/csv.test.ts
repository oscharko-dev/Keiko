import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "./csv.ts";

test("parseCsv reads entries after the header", () => {
  const entries = parseCsv("date,account,description,amount\n2026-02-01,checking,Coffee,-3.20\n");
  assert.deepEqual(entries, [
    { date: "2026-02-01", account: "checking", description: "Coffee", amount: -320 },
  ]);
});

test("parseCsv handles quoted fields with commas", () => {
  const entries = parseCsv("date,account,description,amount\n2026-02-02,card,\"Books, magazines\",-42.90\n");
  assert.deepEqual(entries, [
    { date: "2026-02-02", account: "card", description: "Books, magazines", amount: -4290 },
  ]);
});

test("parseCsv handles escaped quotes in quoted fields", () => {
  const entries = parseCsv("date,account,description,amount\n2026-02-03,card,\"The \"\"Big\"\" Book\",-10.00\n");
  assert.deepEqual(entries, [
    { date: "2026-02-03", account: "card", description: 'The "Big" Book', amount: -1000 },
  ]);
});

test("parseCsv rejects an unexpected header", () => {
  assert.throws(() => parseCsv("when,amount\n"), /Unexpected CSV header/);
});
