// The synthetic review seed corpus (Issue #4132): its coverage of the required defect classes, the
// integrity of every planted range, the absence of Keiko code, and its scoring through the shared
// `scoreReviewSeedRun` rule against scripted findings.

import { describe, expect, it } from "vitest";

import type { ReviewCodeLocation, ReviewSeedRunResult } from "@oscharko-dev/keiko-contracts";
import { scoreReviewSeedRun } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";

import { cleanControl, defectCase } from "./define.js";
import {
  REVIEW_SEED_CORPUS,
  REVIEW_SEED_CORPUS_CASES,
  REVIEW_SEED_DEFECT_KINDS,
  type ReviewSeedCorpusEntry,
} from "./index.js";

const defects = REVIEW_SEED_CORPUS.filter((entry) => !entry.seed.cleanControl);
const controls = REVIEW_SEED_CORPUS.filter((entry) => entry.seed.cleanControl);

function expectedOf(entry: ReviewSeedCorpusEntry): ReviewCodeLocation {
  if (entry.seed.cleanControl) throw new Error(`${entry.seed.id} is a clean control`);
  return entry.seed.expected;
}

/** A scripted review that reports exactly the planted location of every case it is asked to find. */
function scriptedResults(find: (entry: ReviewSeedCorpusEntry) => boolean): ReviewSeedRunResult[] {
  return REVIEW_SEED_CORPUS.map((entry) => ({
    caseId: entry.seed.id,
    outcome: "settled",
    findings: !entry.seed.cleanControl && find(entry) ? [expectedOf(entry)] : [],
  }));
}

describe("synthetic review seed corpus", () => {
  it("plants each required defect class exactly once and carries clean controls", () => {
    expect(defects.map((entry) => entry.kind).sort()).toEqual([...REVIEW_SEED_DEFECT_KINDS].sort());
    expect(controls.length).toBeGreaterThanOrEqual(3);
    expect(defects.every((entry) => entry.seed.required)).toBe(true);
    expect(new Set(REVIEW_SEED_CORPUS_CASES.map((seed) => seed.id)).size).toBe(
      REVIEW_SEED_CORPUS.length,
    );
  });

  it.each(defects.map((entry) => [entry.seed.id, entry] as const))(
    "%s plants its defect inside the changed region of the expected file",
    (_id, entry) => {
      const expected = expectedOf(entry);
      const head = entry.headFiles[expected.file];
      expect(head).toBeDefined();
      expect(head).not.toBe(entry.baseFiles[expected.file]);
      const lines = (head ?? "").split("\n");
      expect(expected.startLine).toBeGreaterThanOrEqual(1);
      expect(expected.endLine).toBeLessThanOrEqual(lines.length);
      // The planted text exists only after the change: the defect is in the diff, not in context.
      const planted = lines.slice(expected.startLine - 1, expected.endLine).join("\n");
      expect(entry.baseFiles[expected.file] ?? "").not.toContain(planted);
    },
  );

  it.each(controls.map((entry) => [entry.seed.id, entry] as const))(
    "%s is a real change with nothing planted",
    (_id, entry) => {
      expect(entry.headFiles).not.toEqual(entry.baseFiles);
      expect(entry.kind).toBe("clean-control");
    },
  );

  it("contains no Keiko or customer code", () => {
    for (const entry of REVIEW_SEED_CORPUS) {
      for (const content of [
        ...Object.values(entry.baseFiles),
        ...Object.values(entry.headFiles),
      ]) {
        expect(content).not.toMatch(/keiko|oscharko|@oscharko-dev/iu);
      }
    }
  });

  it("scores a scripted model that finds every planted defect as complete recall", () => {
    const score = scoreReviewSeedRun(
      REVIEW_SEED_CORPUS_CASES,
      scriptedResults(() => true),
    );
    expect(score).toMatchObject({
      defectCaseCount: 9,
      cleanControlCount: controls.length,
      found: 9,
      missed: 0,
      requiredCount: 9,
      requiredFound: 9,
      falseAlarms: 0,
      unmatchedResults: 0,
    });
  });

  it("scores a missed required defect as missed", () => {
    const missedId = "synthetic-inverted-condition";
    const score = scoreReviewSeedRun(
      REVIEW_SEED_CORPUS_CASES,
      scriptedResults((entry) => entry.seed.id !== missedId),
    );
    expect(score.missed).toBe(1);
    expect(score.requiredFound).toBe(score.requiredCount - 1);
  });

  it("scores a finding on the wrong lines of the right file as missed", () => {
    const target = defects[0];
    if (target === undefined) throw new Error("corpus has no defect case");
    const expected = expectedOf(target);
    const results = scriptedResults(() => true).map((result) =>
      result.caseId === target.seed.id
        ? {
            ...result,
            findings: [
              { ...expected, startLine: expected.endLine + 40, endLine: expected.endLine + 41 },
            ],
          }
        : result,
    );
    expect(scoreReviewSeedRun(REVIEW_SEED_CORPUS_CASES, results).missed).toBe(1);
  });

  it("counts every finding on a clean control as a false alarm, apart from recall", () => {
    const control = controls[0];
    if (control === undefined) throw new Error("corpus has no clean control");
    const file = Object.keys(control.headFiles)[0] ?? "";
    const results = scriptedResults(() => true).map((result) =>
      result.caseId === control.seed.id
        ? {
            ...result,
            findings: [
              { file, startLine: 1, endLine: 1 },
              { file, startLine: 2, endLine: 2 },
            ],
          }
        : result,
    );
    const score = scoreReviewSeedRun(REVIEW_SEED_CORPUS_CASES, results);
    expect(score.falseAlarms).toBe(2);
    expect(score.requiredFound).toBe(9);
  });
});

describe("seed corpus construction", () => {
  const files = { "src/a.ts": "one\ntwo\nthree\n" };

  it("derives the expected range from the planted text", () => {
    const entry = defectCase({
      id: "x",
      kind: "inverted-condition",
      seedClass: "correctness",
      file: "src/a.ts",
      planted: "two\nthree\n",
      baseFiles: {},
      headFiles: files,
      summary: "s",
    });
    expect(entry.seed).toMatchObject({ expected: { file: "src/a.ts", startLine: 2, endLine: 3 } });
  });

  it.each(["absent\n", "t"])(
    "refuses a planted text that is absent or ambiguous (%j)",
    (planted) => {
      expect(() =>
        defectCase({
          id: "x",
          kind: "inverted-condition",
          seedClass: "correctness",
          file: "src/a.ts",
          planted,
          baseFiles: {},
          headFiles: files,
          summary: "s",
        }),
      ).toThrow(/exactly once/u);
    },
  );

  it("refuses a case whose expected file is missing from the head tree", () => {
    expect(() =>
      defectCase({
        id: "x",
        kind: "inverted-condition",
        seedClass: "correctness",
        file: "src/missing.ts",
        planted: "one",
        baseFiles: {},
        headFiles: files,
        summary: "s",
      }),
    ).toThrow(/no head/u);
  });

  it("builds a clean control that requires nothing", () => {
    expect(cleanControl({ id: "c", baseFiles: {}, headFiles: files, summary: "s" }).seed).toEqual({
      id: "c",
      seedClass: "maintainability",
      required: false,
      cleanControl: true,
    });
  });
});
