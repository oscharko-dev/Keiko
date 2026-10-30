import { afterEach, describe, expect, it } from "vitest";
import { createGitReviewProcessRunner } from "@oscharko-dev/keiko-git";
import {
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

const fixtures: DiffFixtureRepository[] = [];

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup();
});

function headCommit(): { readonly repo: DiffFixtureRepository; readonly head: string } {
  const repo = new DiffFixtureRepository("keiko-review-intake-");
  fixtures.push(repo);
  const head = repo.commit([
    { path: "src/first.ts", content: `${SOURCE}\n` },
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

function intakeFor(log: BufferedServerLogSink, maxCandidates?: number): ReviewFindingIntake {
  const { repo, head } = headCommit();
  return createReviewFindingIntake({
    runId: "review-run-intake-1",
    worktreeRoot: repo.repo,
    headSha: head,
    runner: createGitReviewProcessRunner(),
    activityLog: log,
    ...(maxCandidates === undefined ? {} : { maxCandidates }),
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

    const cases: unknown[] = [
      "not an object",
      { ...report(), extra: true },
      report({ title: "line\u0007bell" }),
      report({ startLine: 3, endLine: 2 }),
      report({ evidence: [{ file: "src/first.ts", startLine: 2, endLine: 2, role: "context" }] }),
      report({ file: "../outside.ts" }),
    ];
    for (const value of cases) {
      await expect(intake.submit(value)).resolves.toEqual({
        status: "rejected",
        reason: "schema-invalid",
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
      ).resolves.toEqual({ status: "rejected", reason: "path-outside-worktree" });
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
    ).resolves.toEqual({ status: "rejected", reason: "path-outside-worktree" });
  });

  it("rejects ranges outside the head blob and blobs too large to verify (range-invalid)", async () => {
    const intake = intakeFor(createBufferedServerLogSink());

    await expect(intake.submit(report({ startLine: 5, endLine: 9 }))).resolves.toEqual({
      status: "rejected",
      reason: "range-invalid",
    });
    await expect(
      intake.submit(
        report({
          evidence: [{ file: "src/first.ts", startLine: 2, endLine: 99, role: "defect" }],
        }),
      ),
    ).resolves.toEqual({ status: "rejected", reason: "range-invalid" });
    await expect(
      intake.submit(
        report({
          file: "big.bin",
          evidence: [{ file: "big.bin", startLine: 1, endLine: 1, role: "defect" }],
        }),
      ),
    ).resolves.toEqual({ status: "rejected", reason: "range-invalid" });
  });

  it("rejects evidence that does not back the reported location (evidence-mismatch)", async () => {
    const intake = intakeFor(createBufferedServerLogSink());

    await expect(
      intake.submit(
        report({ evidence: [{ file: "src/first.ts", startLine: 5, endLine: 5, role: "defect" }] }),
      ),
    ).resolves.toEqual({ status: "rejected", reason: "evidence-mismatch" });
    await expect(
      intake.submit(
        report({
          startLine: 4,
          endLine: 4,
          evidence: [{ file: "src/first.ts", startLine: 4, endLine: 4, role: "defect" }],
        }),
      ),
    ).resolves.toEqual({ status: "rejected", reason: "evidence-mismatch" });
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

  it("keeps one candidate per fingerprint when the model repeats a finding", async () => {
    const intake = intakeFor(createBufferedServerLogSink());

    await intake.submit(report());
    await expect(intake.submit(report({ title: "Reworded title" }))).resolves.toEqual({
      status: "accepted",
      accepted: 1,
      remaining: REVIEW_RUN_MAX_CANDIDATE_REPORTS - 1,
    });
    expect(intake.candidates()).toHaveLength(1);
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
