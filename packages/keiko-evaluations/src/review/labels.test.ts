// AC2 (Issue #4132): every labeling rule has a fixture — a hit, a false alarm, a contradicted
// refutation and an unmatched finding — and the unmatched case is never counted as a hit.

import { describe, expect, it } from "vitest";

import {
  findingOverlapsThread,
  labelReviewThread,
  matchReviewFinding,
  scoreReviewFindings,
  threadOverlap,
} from "./labels.js";
import { thread } from "./_support.js";

const refuted = { classification: "refuted", producer: "human" } as const;
const fixed = { classification: "fixed", producer: "human" } as const;

describe("labelReviewThread", () => {
  it("rule 1: a region changed later in the same pull request is a hit", () => {
    expect(labelReviewThread(thread({ regionChange: "changed", reply: fixed }))).toEqual({
      label: "hit",
      refuted: false,
      refutationContradicted: false,
    });
    expect(labelReviewThread(thread({ regionChange: "changed", reply: null })).label).toBe("hit");
  });

  it("rule 2: an evidenced refutation with the code unchanged is a false alarm", () => {
    expect(labelReviewThread(thread({ regionChange: "unchanged", reply: refuted }))).toEqual({
      label: "false-alarm",
      refuted: true,
      refutationContradicted: false,
    });
    expect(
      labelReviewThread(thread({ regionChange: "no-later-commit", reply: refuted })).label,
    ).toBe("false-alarm");
  });

  it("rule 3: a refutation the code later contradicted is not a refutation but a hit", () => {
    expect(labelReviewThread(thread({ regionChange: "changed", reply: refuted }))).toEqual({
      label: "hit",
      refuted: true,
      refutationContradicted: true,
    });
  });

  it("leaves an unchanged, unrefuted thread undecided — a fix claim alone is not a hit", () => {
    expect(labelReviewThread(thread({ regionChange: "unchanged", reply: fixed })).label).toBe(
      "undecided",
    );
    expect(labelReviewThread(thread({ regionChange: "unchanged", reply: null })).label).toBe(
      "undecided",
    );
  });

  it("never reads an unmeasurable region as unchanged, even under a refutation", () => {
    expect(labelReviewThread(thread({ regionChange: "unavailable", reply: refuted }))).toEqual({
      label: "unmeasured",
      refuted: true,
      refutationContradicted: false,
    });
  });
});

describe("matchReviewFinding", () => {
  const threads = [
    thread({ id: "hit", regionChange: "changed", startLine: 10, endLine: 12 }),
    thread({ id: "false", regionChange: "unchanged", reply: refuted, startLine: 30, endLine: 30 }),
    thread({ id: "file", path: "src/b.ts", startLine: null, endLine: null, fileLevel: true }),
  ];

  it("scores a finding overlapping a changed region as a hit", () => {
    expect(matchReviewFinding({ file: "src/a.ts", startLine: 12, endLine: 14 }, threads)).toEqual({
      outcome: "hit",
      matchedThreadIds: ["hit"],
    });
  });

  it("scores a finding overlapping a confirmed refutation as a false alarm", () => {
    expect(
      matchReviewFinding({ file: "src/a.ts", startLine: 29, endLine: 31 }, threads).outcome,
    ).toBe("false-alarm");
  });

  it("rule 4: a finding without a counterpart is unmatched — the hand-graded sample, never a hit", () => {
    const unmatched = matchReviewFinding({ file: "src/a.ts", startLine: 20, endLine: 25 }, threads);
    expect(unmatched).toEqual({ outcome: "unmatched", matchedThreadIds: [] });
    expect(unmatched.outcome).not.toBe("hit");
    expect(
      matchReviewFinding({ file: "src/c.ts", startLine: 10, endLine: 12 }, threads).outcome,
    ).toBe("unmatched");
  });

  it("lets the strongest evidence decide when several threads overlap", () => {
    const wide = { file: "src/a.ts", startLine: 1, endLine: 40 };
    expect(matchReviewFinding(wide, threads)).toEqual({
      outcome: "hit",
      matchedThreadIds: ["hit", "false"],
    });
  });

  it("treats a file-level thread as overlapping any range in its file", () => {
    expect(
      findingOverlapsThread(
        { file: "src/b.ts", startLine: 900, endLine: 901 },
        threads[2] ?? thread(),
      ),
    ).toBe(true);
    expect(
      matchReviewFinding({ file: "src/b.ts", startLine: 5, endLine: 5 }, threads).outcome,
    ).toBe("undecided");
  });

  it("does not match an adjacent but non-overlapping range", () => {
    expect(findingOverlapsThread({ file: "src/a.ts", startLine: 13, endLine: 13 }, thread())).toBe(
      false,
    );
    expect(findingOverlapsThread({ file: "src/a.ts", startLine: 9, endLine: 9 }, thread())).toBe(
      false,
    );
  });
});

describe("scoreReviewFindings", () => {
  // R4130-014: a matched thread credits one hit per pull request; restatements are duplicates.
  const threads = [
    thread({ id: "hit", regionChange: "changed", startLine: 10, endLine: 12 }),
    thread({ id: "hit-2", regionChange: "changed", startLine: 40, endLine: 41 }),
    thread({ id: "open", regionChange: "unchanged", startLine: 60, endLine: 60 }),
  ];

  it("credits a hit once per matched thread and marks later findings on it as duplicates", () => {
    const outcomes = scoreReviewFindings(
      [
        { file: "src/a.ts", startLine: 10, endLine: 10 },
        { file: "src/a.ts", startLine: 11, endLine: 11 },
        { file: "src/a.ts", startLine: 12, endLine: 13 },
      ],
      threads,
    );
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["hit", "duplicate", "duplicate"]);
    expect(outcomes[1]?.matchedThreadIds).toEqual(["hit"]);
  });

  it("credits a finding that reaches a thread no earlier finding was credited for", () => {
    const outcomes = scoreReviewFindings(
      [
        { file: "src/a.ts", startLine: 10, endLine: 10 },
        { file: "src/a.ts", startLine: 12, endLine: 40 },
      ],
      threads,
    );
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["hit", "hit"]);
  });

  it("leaves repeated undecided matches undecided, so each still counts against the rate", () => {
    const outcomes = scoreReviewFindings(
      [
        { file: "src/a.ts", startLine: 60, endLine: 60 },
        { file: "src/a.ts", startLine: 59, endLine: 61 },
      ],
      threads,
    );
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["undecided", "undecided"]);
  });
});

describe("matching in head coordinates (R4130-007)", () => {
  // Reviewed at lines 40-42; a later commit inserted 20 lines above and fixed it: 60-62 at head.
  const moved = thread({
    id: "moved",
    regionChange: "changed",
    startLine: 40,
    endLine: 42,
    headStartLine: 60,
    headEndLine: 62,
  });

  it("matches a finding at head against the carried anchor, not the reviewed one", () => {
    expect(matchReviewFinding({ file: "src/a.ts", startLine: 61, endLine: 61 }, [moved])).toEqual({
      outcome: "hit",
      matchedThreadIds: ["moved"],
    });
    expect(
      matchReviewFinding({ file: "src/a.ts", startLine: 40, endLine: 42 }, [moved]).outcome,
    ).toBe("unmatched");
  });

  it("treats a line anchor that could not be carried as unmeasured, never as a hit", () => {
    const lost = thread({
      id: "lost",
      regionChange: "changed",
      headStartLine: null,
      headEndLine: null,
    });
    expect(matchReviewFinding({ file: "src/a.ts", startLine: 500, endLine: 500 }, [lost])).toEqual({
      outcome: "unmeasured",
      matchedThreadIds: ["lost"],
    });
    expect(threadOverlap({ file: "src/b.ts", startLine: 1, endLine: 1 }, lost)).toBe("apart");
  });

  it("does not credit an uncarried hit thread when another thread decides the finding", () => {
    const lost = thread({
      id: "lost",
      regionChange: "changed",
      headStartLine: null,
      headEndLine: null,
    });
    const outcomes = scoreReviewFindings(
      [
        { file: "src/a.ts", startLine: 61, endLine: 61 },
        { file: "src/a.ts", startLine: 62, endLine: 62 },
      ],
      [moved, lost],
    );
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["hit", "duplicate"]);
  });

  it("matches only right-side anchors", () => {
    const base = thread({ id: "base", side: "left", regionChange: "unavailable" });
    expect(threadOverlap({ file: "src/a.ts", startLine: 10, endLine: 12 }, base)).toBe("apart");
    expect(
      matchReviewFinding({ file: "src/a.ts", startLine: 10, endLine: 12 }, [base]).outcome,
    ).toBe("unmatched");
  });
});
