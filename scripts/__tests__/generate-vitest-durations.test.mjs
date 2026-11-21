import { describe, expect, it } from "vitest";

import { commonRoot, durationsFromBlobs, fileSeconds } from "../generate-vitest-durations.mjs";

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

describe("commonRoot", () => {
  it("finds the checkout root the run measured from", () => {
    expect(
      commonRoot([
        `${ROOT}/tests/a.test.ts`,
        `${ROOT}/packages/keiko-server/src/b.test.ts`,
        `${ROOT}/scripts/__tests__/c.test.mjs`,
      ]),
    ).toBe(ROOT);
  });

  it("does not stop inside a directory name that only shares a prefix", () => {
    expect(commonRoot(["/r/packages-a/x.test.ts", "/r/packages-b/y.test.ts"])).toBe("/r");
  });

  it("answers nothing for no paths", () => {
    expect(commonRoot([])).toBe("");
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

  it("answers nothing for a blob without files", () => {
    expect(durationsFromBlobs([["4.1.12"]])).toEqual({});
  });
});
