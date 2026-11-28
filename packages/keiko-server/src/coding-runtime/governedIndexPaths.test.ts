import { afterEach, describe, expect, it } from "vitest";

import {
  GOVERNED_INDEX_PATHS_MAX_PER_RUN,
  GOVERNED_INDEX_PATHS_MAX_RUNS,
  governedIndexRecord,
  isGovernedIndexPath,
  noteGovernedIndexPaths,
  resetGovernedIndexPaths,
} from "./governedIndexPaths.js";

const created: string[] = [];

function run(name: string): string {
  const id = `run-governed-index-${name}`;
  created.push(id);
  return id;
}

afterEach(() => {
  for (const id of created.splice(0)) resetGovernedIndexPaths(id);
});

describe("governed index paths", () => {
  it("keeps each run's paths apart and normalizes a directory's trailing slash", () => {
    const first = run("first");
    const second = run("second");
    noteGovernedIndexPaths(first, ["src/a.ts", "docs/"]);
    noteGovernedIndexPaths(second, ["other.ts"]);

    expect(governedIndexRecord(first)).toEqual({ paths: ["src/a.ts", "docs"], truncated: false });
    expect(governedIndexRecord(second)).toEqual({ paths: ["other.ts"], truncated: false });
    expect(governedIndexRecord(run("none"))).toEqual({ paths: [], truncated: false });
  });

  it("accumulates over a turn and forgets everything when a new human turn begins", () => {
    const id = run("turn");
    noteGovernedIndexPaths(id, ["a.ts"]);
    noteGovernedIndexPaths(id, ["b.ts", "a.ts"]);
    expect(governedIndexRecord(id).paths).toEqual(["a.ts", "b.ts"]);

    resetGovernedIndexPaths(id);

    expect(governedIndexRecord(id)).toEqual({ paths: [], truncated: false });
  });

  it("cuts a run at its bound and says the record is incomplete", () => {
    const id = run("cap");
    const over = Array.from(
      { length: GOVERNED_INDEX_PATHS_MAX_PER_RUN + 3 },
      (_unused, index) => `f${String(index)}.ts`,
    );
    noteGovernedIndexPaths(id, over);

    const record = governedIndexRecord(id);

    expect(record.paths).toHaveLength(GOVERNED_INDEX_PATHS_MAX_PER_RUN);
    expect(record.truncated).toBe(true);
  });

  it("forgets the run written least recently once too many runs are held", () => {
    const oldest = run("lru-0");
    noteGovernedIndexPaths(oldest, ["old.ts"]);
    for (let index = 1; index <= GOVERNED_INDEX_PATHS_MAX_RUNS; index += 1) {
      const id = run(`lru-${String(index)}`);
      noteGovernedIndexPaths(id, ["x.ts"]);
    }

    expect(governedIndexRecord(oldest).paths).toEqual([]);
    expect(governedIndexRecord(run(`lru-${String(GOVERNED_INDEX_PATHS_MAX_RUNS)}`)).paths).toEqual([
      "x.ts",
    ]);
  });

  it("matches a path equal to a pathspec or below a directory it names, nothing else", () => {
    expect(isGovernedIndexPath("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(isGovernedIndexPath("src/a.ts", ["src"])).toBe(true);
    expect(isGovernedIndexPath("srcx/a.ts", ["src"])).toBe(false);
    expect(isGovernedIndexPath("src/a.ts", [])).toBe(false);
  });
});
