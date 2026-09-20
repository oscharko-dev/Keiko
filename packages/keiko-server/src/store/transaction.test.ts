import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withImmediateTransaction } from "./transaction.js";

describe("nested store transactions", () => {
  it("rolls back a failed inner write while allowing the caller to finish its transaction", () => {
    using db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE records (id TEXT PRIMARY KEY)");
    withImmediateTransaction(db, () => {
      db.exec("INSERT INTO records VALUES ('outer-before')");
      expect(() =>
        withImmediateTransaction(db, () => {
          db.exec("INSERT INTO records VALUES ('inner')");
          throw new TypeError("Rejected inner write");
        }),
      ).toThrow("Rejected inner write");
      expect(db.isTransaction).toBe(true);
      db.exec("INSERT INTO records VALUES ('outer-after')");
    });
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT id FROM records ORDER BY id").all()).toEqual([
      { id: "outer-after" },
      { id: "outer-before" },
    ]);
  });

  it("rolls back successful nested writes when the caller fails", () => {
    using db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE records (id TEXT PRIMARY KEY)");
    expect(() =>
      withImmediateTransaction(db, () => {
        withImmediateTransaction(db, () => db.exec("INSERT INTO records VALUES ('inner')"));
        throw new TypeError("Rejected outer write");
      }),
    ).toThrow("Rejected outer write");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT id FROM records").all()).toEqual([]);
  });
});
