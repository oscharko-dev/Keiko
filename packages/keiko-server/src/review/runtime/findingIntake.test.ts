import { afterEach, describe, expect, it } from "vitest";
import { createGitReviewProcessRunner } from "@oscharko-dev/keiko-git";
import {
  REVIEW_REPORT_GUIDANCE,
  REVIEW_REPORT_MAX_ISSUE_PATH_LENGTH,
  REVIEW_REPORT_MAX_ISSUES,
  REVIEW_REPORT_REPEAT_LIMIT,
  REVIEW_RUN_MAX_CANDIDATE_REPORTS,
  type ReviewFindingReport,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { computeReviewFindingFingerprint } from "@oscharko-dev/keiko-security/review-finding-fingerprint";

import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../../../tests/support/buffered-server-log.js";
import { DiffFixtureRepository } from "../diff-package/diffFixtures.test-support.js";
import { createReviewFindingIntake, type ReviewFindingIntake } from "./findingIntake.js";

const SOURCE = [
  "export function first(values: number[]): number {",
  "  return values[0];",
  "}",
  "",
  "export const LIMIT = 3;",
].join("\n");

const TWICE = [
  "export function a(body: string): unknown {",
  "  return JSON.parse(body);",
  "}",
  "export function b(body: string): unknown {",
  "  return JSON.parse(body);",
  "}",
].join("\n");

const fixtures: DiffFixtureRepository[] = [];

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup();
});

function headCommit(): { readonly repo: DiffFixtureRepository; readonly head: string } {
  const repo = new DiffFixtureRepository("keiko-review-intake-");
  fixtures.push(repo);
  const head = repo.commit([
    { path: "src/first.ts", content: `${SOURCE}\n` },
    { path: "src/twice.ts", content: `${TWICE}\n` },
    { path: ".env", content: "SECRET=1\n" },
    { path: "big.bin", content: Buffer.alloc(3 * 1024 * 1024, 0x61) },
  ]);
  return { repo, head };
}

function report(overrides: Partial<ReviewFindingReport> = {}): ReviewFindingReport {
  return {
    file: "src/first.ts",
    startLine: 2,
    endLine: 2,
    title: "Unchecked first element",
    condition: "An empty array is passed.",
    mechanism: "The function indexes element zero without a length check.",
    consequence: "It returns undefined typed as number.",
    remedy: "Check the length before indexing.",
    category: "correctness",
    severity: "medium",
    evidence: [{ file: "src/first.ts", startLine: 2, endLine: 2, role: "defect" }],
    failureMode: { trigger: "first([])", detection: "nothing", coveredByChange: false },
    ...overrides,
  };
}

function intakeFor(
  log: BufferedServerLogSink,
  maxCandidates?: number,
  onRepeatLimit?: () => void,
): ReviewFindingIntake {
  const { repo, head } = headCommit();
  return createReviewFindingIntake({
    runId: "review-run-intake-1",
    worktreeRoot: repo.repo,
    headSha: head,
    runner: createGitReviewProcessRunner(),
    activityLog: log,
    ...(maxCandidates === undefined ? {} : { maxCandidates }),
    ...(onRepeatLimit === undefined ? {} : { onRepeatLimit }),
  });
}

describe("createReviewFindingIntake", () => {
  it("accepts a report proven by the head commit and fingerprints its defect excerpt", async () => {
    const log = createBufferedServerLogSink();
    const intake = intakeFor(log);

    await expect(intake.submit(report())).resolves.toEqual({
      status: "accepted",
      accepted: 1,
      remaining: REVIEW_RUN_MAX_CANDIDATE_REPORTS - 1,
    });
    const [candidate] = intake.candidates();
    expect(candidate?.defectExcerpt).toBe("  return values[0];");
    expect(candidate?.fingerprint).toBe(
      computeReviewFindingFingerprint(report(), "  return values[0];"),
    );
  });

  it("rejects schema violations the tool boundary cannot express (AC6 schema-invalid)", async () => {
    const intake = intakeFor(createBufferedServerLogSink());

    // #4130: each answer names the contract issue, so the model can correct the report.
    const cases: readonly (readonly [unknown, string, string])[] = [
      ["not an object", "not-an-object", "$"],
      [{ ...report(), extra: true }, "unknown-field", "extra"],
      [report({ title: "line\u0007bell" }), "control-character", "title"],
      [report({ startLine: 3, endLine: 2 }), "invalid-line-range", "endLine"],
      [
        report({ evidence: [{ file: "src/first.ts", startLine: 2, endLine: 2, role: "context" }] }),
        "inconsistent-fields",
        "evidence",
      ],
      [report({ file: "../outside.ts" }), "invalid-path", "file"],
    ];
    for (const [value, code, path] of cases) {
      await expect(intake.submit(value)).resolves.toEqual({
        status: "rejected",
        reason: "schema-invalid",
        issues: [{ code, path }],
        guidance: REVIEW_REPORT_GUIDANCE.rejected,
      });
    }
    expect(intake.rejections()["schema-invalid"]).toBe(cases.length);
    expect(intake.candidates()).toEqual([]);
  });

  it("rejects paths the head commit does not hold or the read tools deny (path-outside-worktree)", async () => {
    const intake = intakeFor(createBufferedServerLogSink());

    for (const file of ["src/missing.ts", ".env", "src"]) {
      await expect(
        intake.submit(
          report({ file, evidence: [{ file, startLine: 1, endLine: 1, role: "defect" }] }),
        ),
      ).resolves.toEqual({
        status: "rejected",
        reason: "path-outside-worktree",
        guidance: REVIEW_REPORT_GUIDANCE.rejected,
      });
    }
    await expect(
      intake.submit(
        report({
          evidence: [
            { file: "src/first.ts", startLine: 2, endLine: 2, role: "defect" },
            { file: "src/elsewhere.ts", startLine: 1, endLine: 1, role: "context" },
          ],
        }),
      ),
    ).resolves.toEqual({
      status: "rejected",
      reason: "path-outside-worktree",
      guidance: REVIEW_REPORT_GUIDANCE.rejected,
    });
  });

  it("rejects ranges outside the head blob and blobs too large to verify (range-invalid)", async () => {
    const intake = intakeFor(createBufferedServerLogSink());

    await expect(intake.submit(report({ startLine: 5, endLine: 9 }))).resolves.toEqual({
      status: "rejected",
      reason: "range-invalid",
      guidance: REVIEW_REPORT_GUIDANCE.rejected,
    });
    await expect(
      intake.submit(
        report({
          evidence: [{ file: "src/first.ts", startLine: 2, endLine: 99, role: "defect" }],
        }),
      ),
    ).resolves.toEqual({
      status: "rejected",
      reason: "range-invalid",
      guidance: REVIEW_REPORT_GUIDANCE.rejected,
    });
    await expect(
      intake.submit(
        report({
          file: "big.bin",
          evidence: [{ file: "big.bin", startLine: 1, endLine: 1, role: "defect" }],
        }),
      ),
    ).resolves.toEqual({
      status: "rejected",
      reason: "range-invalid",
      guidance: REVIEW_REPORT_GUIDANCE.rejected,
    });
  });

  it("rejects evidence that does not back the reported location (evidence-mismatch)", async () => {
    const intake = intakeFor(createBufferedServerLogSink());

    await expect(
      intake.submit(
        report({ evidence: [{ file: "src/first.ts", startLine: 5, endLine: 5, role: "defect" }] }),
      ),
    ).resolves.toEqual({
      status: "rejected",
      reason: "evidence-mismatch",
      guidance: REVIEW_REPORT_GUIDANCE.rejected,
    });
    await expect(
      intake.submit(
        report({
          startLine: 4,
          endLine: 4,
          evidence: [{ file: "src/first.ts", startLine: 4, endLine: 4, role: "defect" }],
        }),
      ),
    ).resolves.toEqual({
      status: "rejected",
      reason: "evidence-mismatch",
      guidance: REVIEW_REPORT_GUIDANCE.rejected,
    });
  });

  it("accepts at most eight candidates and answers limit-reached after (AC6)", async () => {
    const intake = intakeFor(createBufferedServerLogSink());
    const categories = [
      "correctness",
      "security",
      "reliability",
      "performance",
      "concurrency",
      "data-integrity",
      "test-gap",
      "maintainability",
    ] as const;

    for (const category of categories) {
      const answer = await intake.submit(report({ category }));
      expect(answer.status).toBe("accepted");
    }
    await expect(intake.submit(report({ severity: "high" }))).resolves.toEqual({
      status: "limit-reached",
    });
    expect(intake.candidates()).toHaveLength(REVIEW_RUN_MAX_CANDIDATE_REPORTS);
    expect(intake.rejections()["limit-reached"]).toBe(1);
  });

  // Security review of #4135, finding 4: the cap was checked before the head-commit judgement was
  // awaited, so concurrent reports all passed the check and more than eight were accepted.
  it("never accepts more than eight candidates from concurrent reports", async () => {
    const intake = intakeFor(createBufferedServerLogSink());
    const categories = [
      "correctness",
      "security",
      "reliability",
      "performance",
      "concurrency",
      "data-integrity",
      "test-gap",
      "maintainability",
    ] as const;
    const reports = categories.flatMap((category) =>
      [1, 2].map((line) =>
        report({
          category,
          startLine: line,
          endLine: line,
          evidence: [{ file: "src/first.ts", startLine: line, endLine: line, role: "defect" }],
        }),
      ),
    );
    const answers = await Promise.all(reports.map((value) => intake.submit(value)));

    const statuses = answers.map((answer) => answer.status);
    expect(statuses.filter((status) => status === "accepted")).toHaveLength(
      REVIEW_RUN_MAX_CANDIDATE_REPORTS,
    );
    expect(statuses.filter((status) => status === "limit-reached")).toHaveLength(
      reports.length - REVIEW_RUN_MAX_CANDIDATE_REPORTS,
    );
    expect(intake.candidates()).toHaveLength(REVIEW_RUN_MAX_CANDIDATE_REPORTS);
  });

  it("releases a reserved slot when the reserved report is rejected", async () => {
    const intake = intakeFor(createBufferedServerLogSink(), 1);
    await expect(intake.submit(report({ file: "src/missing.ts" }))).resolves.toMatchObject({
      status: "rejected",
    });
    await expect(intake.submit(report())).resolves.toMatchObject({ status: "accepted" });
    await expect(intake.submit(report({ category: "security" }))).resolves.toEqual({
      status: "limit-reached",
    });
  });

  // R4130-025: a repeated finding was dropped but answered `accepted`, so the model could not tell
  // that its report added nothing. It now answers `duplicate`, and the log counts it.
  it("keeps one candidate per fingerprint and answers a repeated finding as a duplicate", async () => {
    const log = createBufferedServerLogSink();
    const intake = intakeFor(log);

    await intake.submit(report());
    await expect(intake.submit(report({ title: "Reworded title" }))).resolves.toEqual({
      status: "duplicate",
      accepted: 1,
      remaining: REVIEW_RUN_MAX_CANDIDATE_REPORTS - 1,
      guidance: REVIEW_REPORT_GUIDANCE.duplicate,
    });
    expect(intake.candidates()).toHaveLength(1);
    const lines = log.events.filter((event) => event.op === "review.finding.reported");
    expect(lines.map((event) => event.extra?.outcome)).toEqual(["accepted", "duplicate"]);
    expect(lines[1]?.extra).toMatchObject({ acceptedCount: 1, duplicateCount: 1 });
    expect(lines[1]?.extra?.fingerprintDigest).toBe(intake.candidates()[0]?.fingerprint);
  });

  // #4130: development iteration 9 had a Reviewer session that sent one accepted finding 25 more
  // times and one that sent 29 reports refused for the same schema issue, each until the run's 20
  // minutes ran out. The repeat is answered with a sentence that says to stop, and the
  // REVIEW_REPORT_REPEAT_LIMIT-th identical report in a row asks once for the session's end.
  it("ends the session once the same duplicate arrives the repeat limit in a row", async () => {
    const log = createBufferedServerLogSink();
    let ends = 0;
    const intake = intakeFor(log, undefined, () => {
      ends += 1;
    });
    await intake.submit(report());

    const guidance: unknown[] = [];
    for (let sent = 0; sent < REVIEW_REPORT_REPEAT_LIMIT + 1; sent += 1) {
      const answer = await intake.submit(report()); // NOSONAR typescript:S9382 -- the order of the reports is the point
      guidance.push(answer.status === "duplicate" ? answer.guidance : answer.status);
    }

    expect(guidance).toEqual([
      REVIEW_REPORT_GUIDANCE.duplicate,
      REVIEW_REPORT_GUIDANCE.repeated,
      REVIEW_REPORT_GUIDANCE.stopped,
      REVIEW_REPORT_GUIDANCE.stopped,
    ]);
    expect(ends).toBe(1);
    expect(intake.repeatLimitReached()).toBe(true);
    expect(intake.candidates()).toHaveLength(1);
    const lines = log.events.filter((event) => event.op === "review.finding.reported");
    expect(lines.map((event) => event.extra?.repeatCount)).toEqual([undefined, 1, 2, 3, 4]);
    expect(lines.map((event) => event.extra?.sessionEnded)).toEqual([
      undefined,
      undefined,
      undefined,
      true,
      true,
    ]);
  });

  it("ends the session once the same refused report arrives the repeat limit in a row", async () => {
    const log = createBufferedServerLogSink();
    let ends = 0;
    const intake = intakeFor(log, undefined, () => {
      ends += 1;
    });
    const invalid = { ...report(), extra: true };

    for (let sent = 0; sent < REVIEW_REPORT_REPEAT_LIMIT; sent += 1) {
      await intake.submit(invalid); // NOSONAR typescript:S9382 -- the order of the reports is the point
    }

    expect(ends).toBe(1);
    expect(intake.repeatLimitReached()).toBe(true);
    const lines = log.events.filter((event) => event.op === "review.finding.reported");
    expect(lines.at(-1)?.extra).toMatchObject({
      outcome: "schema-invalid",
      issueCode: "unknown-field",
      issueCount: 1,
      repeatCount: REVIEW_REPORT_REPEAT_LIMIT,
      sessionEnded: true,
    });
  });

  it("counts again after an accepted report or a different report", async () => {
    let ends = 0;
    const intake = intakeFor(createBufferedServerLogSink(), undefined, () => {
      ends += 1;
    });
    const invalid = { ...report(), extra: true };
    const other = { ...report(), other: true };
    await intake.submit(invalid);
    await intake.submit(invalid);
    await intake.submit(other);
    await intake.submit(other);
    await intake.submit(report());
    await intake.submit(invalid);
    await intake.submit(invalid);
    await intake.submit(report());
    await intake.submit(report());

    expect(ends).toBe(0);
    expect(intake.repeatLimitReached()).toBe(false);
  });

  it("ends the session when reports keep arriving past the candidate cap", async () => {
    let ends = 0;
    const intake = intakeFor(createBufferedServerLogSink(), 1, () => {
      ends += 1;
    });
    await intake.submit(report());
    for (let sent = 0; sent < REVIEW_REPORT_REPEAT_LIMIT; sent += 1) {
      await intake.submit(report({ category: "security" })); // NOSONAR typescript:S9382 -- the order of the reports is the point
    }

    expect(ends).toBe(1);
    expect(intake.candidates()).toHaveLength(1);
  });

  it("names at most the first issues, each path cut to its bound", async () => {
    const intake = intakeFor(createBufferedServerLogSink());
    const long = "x".repeat(REVIEW_REPORT_MAX_ISSUE_PATH_LENGTH * 2);

    const empty = await intake.submit({});
    const unknown = await intake.submit({ ...report(), [long]: true });

    expect(empty.status === "rejected" ? empty.issues : undefined).toHaveLength(
      REVIEW_REPORT_MAX_ISSUES,
    );
    expect(unknown.status === "rejected" ? unknown.issues : undefined).toEqual([
      { code: "unknown-field", path: long.slice(0, REVIEW_REPORT_MAX_ISSUE_PATH_LENGTH) },
    ]);
  });

  it("accepts two separate defects with the same file, category and excerpt", async () => {
    const intake = intakeFor(createBufferedServerLogSink());
    const at = (line: number): ReviewFindingReport =>
      report({
        file: "src/twice.ts",
        startLine: line,
        endLine: line,
        evidence: [{ file: "src/twice.ts", startLine: line, endLine: line, role: "defect" }],
      });

    await expect(intake.submit(at(2))).resolves.toMatchObject({ status: "accepted" });
    await expect(intake.submit(at(5))).resolves.toMatchObject({ status: "accepted", accepted: 2 });
    const [first, second] = intake.candidates();
    expect(first?.fingerprint).toBe(
      computeReviewFindingFingerprint(at(2), "  return JSON.parse(body);"),
    );
    expect(second?.fingerprint).toBe(
      computeReviewFindingFingerprint(at(5), "  return JSON.parse(body);", 1),
    );
  });

  // R4130-013: an aborted or timed-out head read was cached for the whole run as a refusal, so one
  // cancelled tool call poisoned the path and every later report citing it was rejected.
  it("does not keep a transient head-read failure for later reports", async () => {
    const intake = intakeFor(createBufferedServerLogSink());
    const aborted = new AbortController();
    aborted.abort();

    await expect(intake.submit(report(), aborted.signal)).resolves.toMatchObject({
      status: "rejected",
    });
    await expect(intake.submit(report())).resolves.toMatchObject({ status: "accepted" });
  });

  it("keeps a deterministic head-read refusal for the run", async () => {
    const intake = intakeFor(createBufferedServerLogSink());
    const missing = report({
      file: "src/missing.ts",
      evidence: [{ file: "src/missing.ts", startLine: 1, endLine: 1, role: "defect" }],
    });

    await expect(intake.submit(missing)).resolves.toEqual({
      status: "rejected",
      reason: "path-outside-worktree",
      guidance: REVIEW_REPORT_GUIDANCE.rejected,
    });
    const aborted = new AbortController();
    aborted.abort();
    // The cached refusal answers without a Git read, so the aborted signal changes nothing. The same
    // report a second time is a repeat (#4130).
    await expect(intake.submit(missing, aborted.signal)).resolves.toEqual({
      status: "rejected",
      reason: "path-outside-worktree",
      guidance: REVIEW_REPORT_GUIDANCE.repeated,
    });
  });

  it("logs every report body-free: no prose, path, line or code (AC7)", async () => {
    const log = createBufferedServerLogSink();
    const intake = intakeFor(log);

    await intake.submit(report());
    await intake.submit(report({ file: "src/missing.ts" }));
    const lines = log.events.filter((event) => event.op === "review.finding.reported");
    expect(lines.map((event) => event.extra?.outcome)).toEqual([
      "accepted",
      "path-outside-worktree",
    ]);
    const serialized = JSON.stringify(lines);
    for (const forbidden of ["src/first.ts", "missing.ts", "Unchecked", "values[0]", "first([])"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(lines[0]?.extra).toMatchObject({
      findingCategory: "correctness",
      severity: "medium",
      evidenceCount: 1,
      acceptedCount: 1,
    });
  });
});
