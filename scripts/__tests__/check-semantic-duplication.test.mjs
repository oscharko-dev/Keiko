import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DUPES_BASELINE,
  FALLOW_DUPES_ARGS,
  ownedGroups,
  staleEntries,
} from "../check-semantic-duplication.mjs";

const group = (...files) => ({
  instances: files.map((file) => ({ file, start_line: 1, end_line: 12 })),
});

describe("historical duplication reporting utilities (#3898)", () => {
  it("owns every new group for a whole-project run", () => {
    const groups = [group("a.ts", "b.ts"), group("c.ts", "d.ts")];
    expect(ownedGroups(groups, undefined)).toEqual(groups);
  });

  it("owns a new group only when one of its instances is in a changed file", () => {
    const touching = group("src/changed.ts", "src/old.ts");
    const elsewhere = group("src/old.ts", "src/other.ts");
    expect(ownedGroups([touching, elsewhere], new Set(["src/changed.ts"]))).toEqual([touching]);
  });

  it("reads legacy staleness counts without making them an audit verdict", () => {
    expect(staleEntries({ stale_entries: 3 })).toBe(3);
    expect(staleEntries({ stale_entries: 0 })).toBe(0);
    expect(staleEntries(undefined)).toBe(0);
  });

  it("retains the historical baseline without treating it as strict-ruler evidence", () => {
    expect(FALLOW_DUPES_ARGS).toEqual([
      "dupes",
      "--mode",
      "semantic",
      "--min-tokens",
      "100",
      "--min-lines",
      "10",
      "--ignore-imports",
      "--no-package-baselines",
    ]);
    const baseline = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", DUPES_BASELINE),
        "utf8",
      ),
    );
    expect(baseline.kind).toBe("dupes");
    expect(baseline.clone_groups.length).toBeGreaterThan(0);
    // This historical artifact excluded generated owners; the mandatory audit does not.
    expect(Object.keys(baseline).sort()).toEqual([
      "clone_fingerprints",
      "clone_groups",
      "kind",
      "normalized_clone_fingerprints",
    ]);
    expect(baseline.clone_groups.some((key) => key.includes(".generated."))).toBe(false);
  });
});
