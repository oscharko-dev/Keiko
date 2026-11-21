import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { checkProperty, propertySettings } from "../../tests/support/property-testing.ts";
import DurationSequencer, {
  assignShard,
  readFileDurations,
} from "../lib/vitest-duration-sequencer.mjs";

function everyShard(keys, durations, count) {
  return Array.from({ length: count }, (_, index) =>
    assignShard(keys, durations, index + 1, count),
  );
}

function byText(a, b) {
  return a.localeCompare(b);
}

function seconds(keys, durations, fallback = 0) {
  return keys.reduce((sum, key) => sum + (durations[key] ?? fallback), 0);
}

describe("assignShard", () => {
  it("balances measured time where the path hash balanced only the file count", () => {
    // One slow suite and many fast ones: equal file counts would put the slow suite beside half
    // of the fast ones; equal time puts it alone.
    const durations = { "slow.test.ts": 60 };
    for (let file = 0; file < 6; file += 1) durations[`fast-${String(file)}.test.ts`] = 10;
    const shards = everyShard(Object.keys(durations), durations, 2);
    expect(shards.map((keys) => seconds(keys, durations))).toEqual([60, 60]);
    expect(shards[0]).toEqual(["slow.test.ts"]);
  });

  it("counts an unmeasured file as the median measured file", () => {
    const durations = { "a.test.ts": 1, "b.test.ts": 5, "c.test.ts": 9 };
    const keys = [...Object.keys(durations), "new.test.ts"];
    // Median 5: [9] then [5, new(5)] then 1 to the lighter shard.
    expect(everyShard(keys, durations, 2)).toEqual([
      ["c.test.ts", "a.test.ts"],
      ["b.test.ts", "new.test.ts"],
    ]);
  });

  it("still spreads files evenly when nothing is measured", () => {
    const keys = ["d", "c", "b", "a"];
    expect(everyShard(keys, {}, 2)).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
  });

  it.each([
    [0, 4],
    [5, 4],
    [1.5, 4],
    [1, 0],
    [1, 2.5],
  ])("refuses shard %s/%s", (index, count) => {
    expect(() => assignShard(["a"], {}, index, count)).toThrow(Error);
  });
});

describe("assignShard properties", () => {
  const name = "every file lands on exactly one shard, whatever the order, times or shard count";
  it(name, async () => {
    const { runs } = propertySettings({ name });
    let unmeasured = 0;
    await checkProperty({
      name,
      generate: (random) => {
        const keys = Array.from(
          { length: random.integer(0, 40) },
          (_, file) => `f${String(file)}.test.ts`,
        );
        const durations = {};
        for (const key of keys) {
          if (random.chance(0.8)) durations[key] = random.integer(0, 300) / 10;
        }
        const shuffled = [...keys];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
          const other = random.integer(0, index);
          [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
        }
        return { keys, shuffled, durations, count: random.integer(1, 8) };
      },
      property: ({ keys, shuffled, durations, count }) => {
        if (keys.some((key) => durations[key] === undefined)) unmeasured += 1;
        const shards = everyShard(keys, durations, count);
        expect(shards.flat().sort(byText)).toEqual([...keys].sort(byText));
        // Every shard derives the same assignment from the same set, in any input order.
        expect(everyShard(shuffled, durations, count)).toEqual(shards);
        // Longest-processing-time bound: no shard exceeds the ideal share by more than one file.
        const times = keys.map((key) => durations[key]).filter((value) => value !== undefined);
        const sorted = [...times].sort((a, b) => a - b);
        const fallback = sorted.length === 0 ? 1 : sorted[Math.floor(sorted.length / 2)];
        const loads = shards.map((shard) => seconds(shard, durations, fallback));
        const total = loads.reduce((sum, load) => sum + load, 0);
        const longest = Math.max(0, ...keys.map((key) => durations[key] ?? fallback));
        for (const load of loads) expect(load).toBeLessThanOrEqual(total / count + longest + 1e-9);
      },
    });
    expect(unmeasured).toBeGreaterThan(runs / 4);
  });
});

describe("readFileDurations", () => {
  it("reads the generated document and answers none for a missing file", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-durations-"));
    try {
      const path = join(directory, "durations.json");
      writeFileSync(path, JSON.stringify({ files: { "a.test.ts": 2.5 } }));
      expect(readFileDurations(pathToFileURL(path))).toEqual({ "a.test.ts": 2.5 });
      expect(readFileDurations(pathToFileURL(join(directory, "absent.json")))).toEqual({});
      writeFileSync(path, "{");
      // A corrupted document fails the run instead of silently dropping the balance.
      expect(() => readFileDurations(pathToFileURL(path))).toThrow(SyntaxError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("covers the files the repository's coverage runs measured", () => {
    const files = readFileDurations();
    expect(Object.keys(files).length).toBeGreaterThan(1000);
    expect(Object.values(files).every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
  });
});

describe("DurationSequencer", () => {
  it("shards Vitest specifications by their repository-relative path", async () => {
    const root = "/repo";
    const spec = (path) => ({ moduleId: `${root}/${path}`, project: { name: "" } });
    const specs = ["a.test.ts", "b.test.ts", "c.test.ts"].map(spec);
    const shards = await Promise.all(
      [1, 2].map((index) =>
        new DurationSequencer({ config: { root, shard: { index, count: 2 } } }).shard(specs),
      ),
    );
    expect(
      shards
        .flat()
        .map(({ moduleId }) => moduleId)
        .sort(byText),
    ).toEqual(specs.map(({ moduleId }) => moduleId));
    expect(shards.every((shard) => shard.length > 0)).toBe(true);
  });
});
