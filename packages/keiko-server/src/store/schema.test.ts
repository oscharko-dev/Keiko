import { describe, expect, it } from "vitest";

import { MIGRATIONS } from "./schema.js";

// KEIKO-0573: runMigrations filters and applies pending migrations in declaration order (no
// .sort()), so the array's order-of-declaration is trusted to equal ascending version order. This
// test pins the invariant so a future migration added out of position fails here before it can
// reach a real on-disk database.
describe("keiko-server store MIGRATIONS", () => {
  it("starts at version 1 and is strictly increasing", () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS[0]?.version).toBe(1);
    let previous = 0;
    for (const m of MIGRATIONS) {
      expect(m.version).toBeGreaterThan(previous);
      previous = m.version;
    }
  });
});
