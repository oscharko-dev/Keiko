import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILLER_FILES,
  DENIED_FILE,
  LOCKED_FILE,
  OWNER_FILE,
  REPO_QUESTIONS,
  atomPaths,
  buildCorpusSpec,
  createRandom,
  evaluateProtection,
  evaluateQuestion,
  evaluateWalk,
  fillerFiles,
  parseArguments,
  verdictLine,
} from "../testing/measure-recursive-search.mjs";

const outcome = (paths, atomCount = paths.length) => ({ paths: new Set(paths), atomCount });

describe("buildCorpusSpec", () => {
  it("is byte-identical for the same seed and differs for another", () => {
    const first = JSON.stringify(buildCorpusSpec({ fillerCount: 40 }));
    expect(JSON.stringify(buildCorpusSpec({ fillerCount: 40 }))).toBe(first);
    expect(JSON.stringify(buildCorpusSpec({ fillerCount: 40, seed: 7 }))).not.toBe(first);
  });

  it("plants every expected and forbidden file of every question", () => {
    const spec = buildCorpusSpec({ fillerCount: 0 });
    const paths = new Set(spec.files.map((file) => file.path));
    for (const question of spec.questions) {
      for (const path of [...question.expected, ...(question.forbidden ?? [])]) {
        expect(paths.has(path), `${question.id}: ${path}`).toBe(true);
      }
    }
    for (const path of [LOCKED_FILE, OWNER_FILE, DENIED_FILE, ".gitignore"]) {
      expect(paths.has(path)).toBe(true);
    }
  });

  it("keeps the CRLF fact, the mixed-case names and the differently cased ignore rules", () => {
    const files = new Map(buildCorpusSpec({ fillerCount: 0 }).files.map((f) => [f.path, f.text]));
    expect(files.get("archive/people/2023/Q1/notes/policies/Remote-Work-Policy.md")).toContain(
      "\r\n",
    );
    expect(files.get(".gitignore")).toBe("*.log\nbuild/\n");
    expect(files.has("cases/Debug.LOG") && files.has("Build/output.txt")).toBe(true);
  });

  it("defaults to the documented filler count and never repeats a path", () => {
    const spec = buildCorpusSpec();
    const paths = spec.files.map((file) => file.path);
    expect(
      paths.filter((path) => path.startsWith("archive/") && path.includes("/doc-")),
    ).toHaveLength(DEFAULT_FILLER_FILES);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("never plants the no-match words in filler text", () => {
    const words = buildCorpusSpec({ fillerCount: 0 })
      .questions.find((q) => q.id === "no-match")
      .text.split(" ");
    const text = fillerFiles(200, createRandom(1))
      .map((file) => file.text)
      .join("\n");
    for (const word of words) expect(text).not.toContain(word);
  });
});

describe("evaluateQuestion", () => {
  const question = { id: "q", expected: ["a.md", "b.md"], forbidden: ["ignored.LOG"] };

  it("passes when every expected file is found and no ignored file is returned", () => {
    expect(evaluateQuestion(question, outcome(["a.md", "b.md", "c.md"]))).toEqual({ pass: true });
  });

  it("fails on a missing expected file", () => {
    expect(evaluateQuestion(question, outcome(["a.md"]))).toEqual({
      pass: false,
      reason: "expected-file-missing",
      missing: 1,
    });
  });

  it("fails when an ignored file is returned", () => {
    expect(evaluateQuestion(question, outcome(["a.md", "b.md", "ignored.LOG"]))).toEqual({
      pass: false,
      reason: "ignored-file-returned",
      forbiddenHits: 1,
    });
  });

  it("fails when the search itself failed", () => {
    expect(evaluateQuestion(question, { failed: true })).toEqual({
      pass: false,
      reason: "search-failed",
    });
  });

  it("separates no-match from match expectations", () => {
    expect(evaluateQuestion({ expected: [], expectNoAtoms: true }, outcome([], 0))).toEqual({
      pass: true,
    });
    expect(evaluateQuestion({ expected: [], expectNoAtoms: true }, outcome(["x"]))).toEqual({
      pass: false,
      reason: "unexpected-match",
    });
    expect(evaluateQuestion(REPO_QUESTIONS[0], outcome([], 0))).toEqual({
      pass: false,
      reason: "no-match",
    });
    expect(evaluateQuestion(REPO_QUESTIONS[0], outcome(["x"]))).toEqual({ pass: true });
  });
});

describe("evaluateWalk and evaluateProtection", () => {
  it("requires the case-insensitive include globs to keep SCAN.TXT and Readme.MD", () => {
    expect(evaluateWalk({ paths: new Set(["cases/SCAN.TXT", "cases/Readme.MD"]) })).toEqual({
      pass: true,
    });
    expect(evaluateWalk({ paths: new Set(["cases/SCAN.TXT"]) })).toEqual({
      pass: false,
      reason: "case-insensitive-glob-missed",
      missing: 1,
    });
    expect(evaluateWalk({ failed: true, paths: new Set() })).toEqual({
      pass: false,
      reason: "walk-failed",
    });
  });

  it("requires unreadable files to be disclosed as io-error, not only a match cap", () => {
    const applied = { applied: true };
    expect(
      evaluateProtection(applied, { coverageIncomplete: true, coverageReasons: ["io-error"] }),
    ).toEqual({
      pass: true,
      observed: "disclosed",
    });
    expect(
      evaluateProtection(applied, { coverageIncomplete: true, coverageReasons: ["match-cap"] }),
    ).toEqual({
      pass: false,
      reason: "unreadable-file-undisclosed",
    });
    expect(evaluateProtection({ applied: false }, {})).toEqual({
      pass: true,
      observed: "not-applied",
    });
  });
});

describe("atomPaths", () => {
  it("normalizes separators and prefers the scope path", () => {
    const paths = atomPaths([
      { scopePath: "a\\b.md", path: "/abs/a/b.md" },
      { path: "c/d.md" },
      {},
    ]);
    expect([...paths]).toEqual(["a/b.md", "c/d.md"]);
  });
});

describe("parseArguments", () => {
  it("parses every option", () => {
    expect(parseArguments(["--files", "10", "--repo", "r", "--parent", "p", "--keep"])).toEqual({
      fillerCount: 10,
      repo: "r",
      parent: "p",
      keep: true,
    });
  });

  it("rejects unknown arguments, missing values and invalid counts", () => {
    expect(() => parseArguments(["--nope"])).toThrow("unknown argument");
    expect(() => parseArguments(["--repo"])).toThrow("--repo needs a value");
    expect(() => parseArguments(["--files", "-1"])).toThrow("non-negative integer");
    expect(() => parseArguments(["--files", "x"])).toThrow("non-negative integer");
  });
});

describe("verdictLine", () => {
  it("names every failed check", () => {
    expect(verdictLine([{ id: "a", pass: true }])).toBe("measure-recursive-search: PASS");
    expect(
      verdictLine([
        { id: "a", pass: false, reason: "r" },
        { id: "b", pass: true },
      ]),
    ).toBe("measure-recursive-search: FAIL (a:r)");
  });
});
