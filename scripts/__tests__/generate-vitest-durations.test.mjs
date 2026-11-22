import { describe, expect, it } from "vitest";

import {
  HOSTED_CHECKOUT,
  durationsFromBlobs,
  fileSeconds,
  generationPlan,
} from "../generate-vitest-durations.mjs";

const ROOT = "/home/runner/work/Keiko/Keiko";

// The shape a Vitest 4 blob report carries: [version, files, errors, modules, coverage, ...].
function blob(files) {
  return ["4.1.12", files.map(([path, milliseconds]) => file(`${ROOT}/${path}`, milliseconds))];
}

function file(filepath, milliseconds) {
  return {
    filepath,
    result: { duration: milliseconds - 400 },
    collectDuration: 250,
    setupDuration: 100,
    prepareDuration: 40,
    environmentLoad: 10,
  };
}

describe("fileSeconds", () => {
  it("adds the import, setup, environment and test time of one file", () => {
    expect(fileSeconds(file("/a.test.ts", 2400))).toBe(2.4);
  });

  it("counts a missing or non-finite part as nothing", () => {
    expect(fileSeconds({ filepath: "/a.test.ts", collectDuration: Number.NaN })).toBe(0);
    expect(fileSeconds({ filepath: "/a.test.ts", result: { duration: 1500 } })).toBe(1.5);
  });
});

describe("generationPlan", () => {
  it("defaults to the hosted checkout and accepts --root anywhere", () => {
    expect(generationPlan(["a.json", "b.json"])).toEqual({
      root: HOSTED_CHECKOUT,
      paths: ["a.json", "b.json"],
    });
    expect(generationPlan(["a.json", "--root", "/w/k", "b.json"])).toEqual({
      root: "/w/k",
      paths: ["a.json", "b.json"],
    });
  });

  it("refuses no blobs and a missing or relative root", () => {
    expect(() => generationPlan([])).toThrow(TypeError);
    expect(() => generationPlan(["a.json", "--root"])).toThrow(TypeError);
    expect(() => generationPlan(["--root", "work", "a.json"])).toThrow(TypeError);
  });
});

describe("durationsFromBlobs", () => {
  it("keys every file by its repository path, sorted, with the slower of two runs", () => {
    const packages = blob([
      ["tests/z.test.ts", 2000],
      ["scripts/__tests__/a.test.mjs", 1200],
    ]);
    const scripts = blob([["scripts/__tests__/a.test.mjs", 3456]]);
    expect(durationsFromBlobs([packages, scripts])).toEqual({
      "scripts/__tests__/a.test.mjs": 3.5,
      "tests/z.test.ts": 2,
    });
    expect(Object.keys(durationsFromBlobs([packages, scripts]))).toEqual([
      "scripts/__tests__/a.test.mjs",
      "tests/z.test.ts",
    ]);
  });

  it("keeps the repository path of a scripts-only blob", () => {
    // CodeRabbit on #4513: the measured files' common prefix would be scripts/__tests__ here, and
    // the keys `a.test.mjs`, which the sequencer never looks up.
    const scripts = blob([
      ["scripts/__tests__/a.test.mjs", 1000],
      ["scripts/__tests__/b.test.mjs", 2000],
    ]);
    expect(Object.keys(durationsFromBlobs([scripts]))).toEqual([
      "scripts/__tests__/a.test.mjs",
      "scripts/__tests__/b.test.mjs",
    ]);
  });

  it("measures from another checkout with --root, and refuses a file outside it", () => {
    const moved = ["4.1.12", [file("/w/k/tests/a.test.ts", 1000)]];
    expect(durationsFromBlobs([moved], "/w/k/")).toEqual({ "tests/a.test.ts": 1 });
    expect(() => durationsFromBlobs([moved])).toThrow(TypeError);
    expect(() => durationsFromBlobs([["4.1.12", [file("/w/kx/a.test.ts", 1000)]]], "/w/k")).toThrow(
      TypeError,
    );
  });

  it("answers nothing for a blob without files", () => {
    expect(durationsFromBlobs([["4.1.12"]])).toEqual({});
  });
});
