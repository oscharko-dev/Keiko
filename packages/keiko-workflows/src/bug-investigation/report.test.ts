import { describe, expect, it } from "vitest";
import { assembleBugReport, renderBugMarkdownReport, type BugReportParts } from "./report.js";
import type { PatchFileChange } from "@oscharko-dev/keiko-tools";
import type { VerificationAuditSummary } from "@oscharko-dev/keiko-verification";
import type { Hypothesis } from "./types.js";

function patchFile(overrides: Partial<PatchFileChange> = {}): PatchFileChange {
  return {
    path: "src/buggy.ts",
    kind: "modify",
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: ["-old", "+new", "+  it('regresses', () => {});"],
      },
    ],
    addedLines: 2,
    removedLines: 1,
    ...overrides,
  };
}

const HYPOTHESIS: Hypothesis = {
  rootCause: "divisor was 3",
  regressionTestStrategy: "assert half(10) === 5",
  uncertainty: "assumes no other caller",
  confidence: "high",
};

const VERIFICATION: VerificationAuditSummary = {
  workspaceRoot: "/repo",
  overallStatus: "passed",
  durationMs: 12,
  counts: {
    passed: 1,
    failed: 0,
    skipped: 0,
    denied: 0,
    "timed-out": 0,
    cancelled: 0,
    "resource-exceeded": 0,
  },
  results: [
    {
      kind: "targeted-test",
      scriptName: "test",
      command: "vitest run",
      status: "passed",
      exitCode: 0,
      durationMs: 12,
      truncated: false,
      appliedLimits: [],
    },
  ],
};

function parts(overrides: Partial<BugReportParts> = {}): BugReportParts {
  return {
    status: "fix-applied",
    modelId: "m",
    durationMs: 5,
    patchFiles: [patchFile()],
    patchValidates: true,
    patchApplied: true,
    verification: VERIFICATION,
    failureFrames: [{ file: "src/buggy.ts", line: 1 }],
    hypothesis: HYPOTHESIS,
    proposedDiff: "--- a\n+++ b",
    dryRunPreview: "PATCH OK — 1 file",
    verificationSkipReason: undefined,
    nextActions: ["Review the applied fix in src/buggy.ts"],
    modelCallCount: 1,
    patchRetryCount: 0,
    ...overrides,
  };
}

describe("assembleBugReport (AC #7 verified/hypothesis separation)", () => {
  it("puts only workflow-established facts in verified", () => {
    const report = assembleBugReport(parts());
    expect(report.verified.patchValidates).toBe(true);
    expect(report.verified.patchApplied).toBe(true);
    expect(report.verified.verification?.overallStatus).toBe("passed");
    expect(report.verified.failureFrames).toEqual([{ file: "src/buggy.ts", line: 1 }]);
  });

  it("puts the redacted model output in hypothesis (UNVERIFIED)", () => {
    const report = assembleBugReport(parts());
    expect(report.hypothesis.rootCause).toContain("divisor was 3");
    expect(report.hypothesis.confidence).toBe("high");
  });

  it("counts added regression test cases best-effort", () => {
    const report = assembleBugReport(parts());
    expect(report.regressionCoverage).toBe(1);
  });

  it("flags a manifest edit with elevatedReview", () => {
    const report = assembleBugReport(parts({ patchFiles: [patchFile({ path: "package.json" })] }));
    expect(report.changedFiles[0]?.elevatedReview).toBe(true);
  });

  it("redacts a secret-shaped token in the proposed diff", () => {
    const secret = `ghp_${"A".repeat(36)}`;
    const report = assembleBugReport(parts({ proposedDiff: `+const token = "${secret}";` }));
    expect(report.proposedDiff).not.toContain(secret);
  });

  it("redacts secret-shaped tokens in path-bearing report fields", () => {
    const secret = `ghp_${"B".repeat(36)}`;
    const report = assembleBugReport(
      parts({
        patchFiles: [patchFile({ path: `src/${secret}.ts` })],
        failureFrames: [{ file: `src/${secret}.ts`, line: 1 }],
        nextActions: [`Review src/${secret}.ts`],
      }),
    );
    expect(report.changedFiles[0]?.path).not.toContain(secret);
    expect(report.verified.failureFrames[0]?.file).not.toContain(secret);
    expect(report.nextActions[0]).not.toContain(secret);
  });

  it("is JSON-serializable", () => {
    const report = assembleBugReport(parts());
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe("renderBugMarkdownReport", () => {
  it("labels verified facts and the UNVERIFIED hypothesis distinctly", () => {
    const md = renderBugMarkdownReport(assembleBugReport(parts()));
    expect(md).toContain("Failure locations (verified)");
    expect(md).toContain("Changed files (verified)");
    expect(md).toContain("Verification (verified)");
    expect(md).toContain("UNVERIFIED — model output");
  });

  it("renders an investigation-only report without changed files", () => {
    const md = renderBugMarkdownReport(
      assembleBugReport(
        parts({
          status: "investigation-only",
          patchFiles: [],
          patchValidates: false,
          patchApplied: false,
          verification: undefined,
          proposedDiff: undefined,
          dryRunPreview: undefined,
          verificationSkipReason: "verification skipped: no patch produced (investigation-only)",
        }),
      ),
    );
    expect(md).toContain("investigation-only");
    expect(md).not.toContain("Changed files (verified)");
  });

  it("suppresses the hypothesis section when the model produced no hypothesis (rejected)", () => {
    const md = renderBugMarkdownReport(
      assembleBugReport(
        parts({
          status: "rejected",
          patchFiles: [],
          patchValidates: false,
          patchApplied: false,
          verification: undefined,
          proposedDiff: undefined,
          dryRunPreview: undefined,
          hypothesis: {
            rootCause: undefined,
            regressionTestStrategy: undefined,
            uncertainty: undefined,
            confidence: undefined,
          },
        }),
      ),
    );
    expect(md).not.toContain("UNVERIFIED — model output");
  });
});
