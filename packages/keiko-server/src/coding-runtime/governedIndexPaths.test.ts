import { afterEach, describe, expect, it } from "vitest";

import {
  AT_HEAD,
  GOVERNED_INDEX_PATHS_MAX_PER_RUN,
  GOVERNED_INDEX_PATHS_MAX_RUNS,
  governedIndexRecord,
  isGovernedIndexPath,
  noteGovernedIndexTransitions,
  noteGovernedIndexUnproven,
  resetGovernedIndexPaths,
} from "./governedIndexPaths.js";

const created: string[] = [];

function run(name: string): string {
  const id = `run-governed-index-${name}`;
  created.push(id);
  return id;
}

const STAGED = "100644 aaaa";
const RESTAGED = "100644 bbbb";

function writes(...paths: string[]): { path: string; before: string; after: string }[] {
  return paths.map((path) => ({ path, before: AT_HEAD, after: STAGED }));
}

afterEach(() => {
  for (const id of created.splice(0)) resetGovernedIndexPaths(id);
});

describe("governed index paths", () => {
  it("keeps each run's paths apart with the entry each mutation wrote", () => {
    const first = run("first");
    const second = run("second");
    noteGovernedIndexTransitions(first, writes("src/a.ts", "docs/b.ts"));
    noteGovernedIndexTransitions(second, writes("other.ts"));

    expect(governedIndexRecord(first)).toEqual({
      paths: ["src/a.ts", "docs/b.ts"],
      written: new Map([
        ["src/a.ts", STAGED],
        ["docs/b.ts", STAGED],
      ]),
      previous: new Map([
        ["src/a.ts", AT_HEAD],
        ["docs/b.ts", AT_HEAD],
      ]),
      truncated: false,
    });
    expect(governedIndexRecord(second).paths).toEqual(["other.ts"]);
    expect(governedIndexRecord(run("none"))).toEqual({
      paths: [],
      written: new Map(),
      previous: new Map(),
      truncated: false,
    });
  });

  it("accumulates over a turn, keeps the latest entry and forgets everything when a new human turn begins", () => {
    const id = run("turn");
    noteGovernedIndexTransitions(id, writes("a.ts"));
    noteGovernedIndexTransitions(id, [
      ...writes("b.ts"),
      { path: "a.ts", before: STAGED, after: RESTAGED },
    ]);
    expect(governedIndexRecord(id).paths).toEqual(["a.ts", "b.ts"]);
    expect(governedIndexRecord(id).written.get("a.ts")).toBe(RESTAGED);

    resetGovernedIndexPaths(id);

    expect(governedIndexRecord(id).paths).toEqual([]);
  });

  it("drops a path a person changed between two governed mutations and never records it again", () => {
    const id = run("interleaved");
    noteGovernedIndexTransitions(id, writes("a.ts"));
    // The second mutation found something else than what the first wrote: the person staged it.
    noteGovernedIndexTransitions(id, [{ path: "a.ts", before: "100644 cccc", after: RESTAGED }]);
    noteGovernedIndexTransitions(id, writes("a.ts"));

    expect(governedIndexRecord(id).paths).toEqual([]);
  });

  it("says the record is incomplete when a mutation's entries could not be read", () => {
    const id = run("unproven");
    noteGovernedIndexUnproven(id, ["a.ts"]);

    expect(governedIndexRecord(id).truncated).toBe(true);
  });

  it("takes back ownership of every held path in an unobserved mutation's scope, and only those", () => {
    const id = run("unproven-scope");
    noteGovernedIndexTransitions(id, writes("a.ts", "dir/b.ts", "other/c.ts"));
    noteGovernedIndexUnproven(id, ["a.ts", "dir"]);

    const record = governedIndexRecord(id);
    expect(record.paths).toEqual(["other/c.ts"]);
    expect(record.truncated).toBe(true);
    // The person's later state for a withdrawn path is never recorded again this turn.
    noteGovernedIndexTransitions(id, writes("a.ts"));
    expect(governedIndexRecord(id).paths).toEqual(["other/c.ts"]);
  });

  it("counts the paths withdrawn from ownership against the per-run bound", () => {
    const id = run("cap-foreign");
    const rounds = 3;
    for (let round = 0; round < rounds; round += 1) {
      const paths = Array.from(
        { length: GOVERNED_INDEX_PATHS_MAX_PER_RUN },
        (_unused, index) => `r${String(round)}-${String(index)}.ts`,
      );
      noteGovernedIndexTransitions(id, writes(...paths));
      // A person changes every one of them before the second governed mutation.
      noteGovernedIndexTransitions(
        id,
        paths.map((path) => ({ path, before: "100644 cccc", after: RESTAGED })),
      );
    }

    const record = governedIndexRecord(id);
    expect(record.paths).toEqual([]);
    expect(record.truncated).toBe(true);
    // Reaching the bound never makes a person-owned path eligible again.
    noteGovernedIndexTransitions(id, writes("r0-0.ts"));
    expect(governedIndexRecord(id).paths).toEqual([]);
  });

  it("cuts a run at its bound and says the record is incomplete", () => {
    const id = run("cap");
    const over = writes(
      ...Array.from(
        { length: GOVERNED_INDEX_PATHS_MAX_PER_RUN + 3 },
        (_unused, index) => `f${String(index)}.ts`,
      ),
    );
    noteGovernedIndexTransitions(id, over);

    const record = governedIndexRecord(id);

    expect(record.paths).toHaveLength(GOVERNED_INDEX_PATHS_MAX_PER_RUN);
    expect(record.truncated).toBe(true);
  });

  it("forgets the run written least recently once too many runs are held", () => {
    const oldest = run("lru-0");
    noteGovernedIndexTransitions(oldest, writes("old.ts"));
    for (let index = 1; index <= GOVERNED_INDEX_PATHS_MAX_RUNS; index += 1) {
      const id = run(`lru-${String(index)}`);
      noteGovernedIndexTransitions(id, writes("x.ts"));
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
