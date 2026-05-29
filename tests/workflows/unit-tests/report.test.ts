import { describe, expect, it } from "vitest";
import {
  assembleReport,
  renderMarkdownReport,
  type ReportParts,
} from "../../../src/workflows/unit-tests/report.js";
import type { PatchFileChange } from "../../../src/tools/index.js";
import type { VerificationAuditSummary } from "../../../src/verification/index.js";

function patchFile(overrides: Partial<PatchFileChange> = {}): PatchFileChange {
  return {
    path: "tests/add.test.ts",
    kind: "create",
    addedLines: 3,
    removedLines: 0,
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: [
          "+import { add } from '../src/add';",
          "+test('adds', () => {});",
          "+it('zero', () => {});",
        ],
      },
    ],
    ...overrides,
  };
}

function parts(overrides: Partial<ReportParts> = {}): ReportParts {
  return {
    status: "dry-run",
    modelId: "m",
    durationMs: 42,
    patchFiles: [patchFile()],
    dryRunPreview: "PATCH OK — 1 file(s), 3 changed line(s)",
    proposedDiff: "--- /dev/null\n+++ b/tests/add.test.ts\n",
    coveredBehavior: "happy path",
    knownGaps: "negatives",
    nextActions: ["Review the generated tests in tests/add.test.ts"],
    verificationSummary: undefined,
    verificationSkipReason: "verification skipped: dry-run, no files written",
    modelCallCount: 1,
    patchRetryCount: 0,
    ...overrides,
  };
}

const auditSummary: VerificationAuditSummary = {
  workspaceRoot: "/repo",
  overallStatus: "passed",
  durationMs: 10,
  counts: {
    passed: 1,
    failed: 0,
    skipped: 0,
    denied: 0,
    "timed-out": 0,
    cancelled: 0,
    "resource-exceeded": 0,
  },
  results: [],
};

describe("assembleReport (AC #9)", () => {
  it("populates every field from the parts", () => {
    const report = assembleReport(parts());
    expect(report.workflowId).toBe("unit-test-generation");
    expect(report.status).toBe("dry-run");
    expect(report.dryRunPreview).toContain("PATCH OK");
    expect(report.proposedDiff).toContain("tests/add.test.ts");
    expect(report.coveredBehavior).toBe("happy path");
    expect(report.knownGaps).toBe("negatives");
    expect(report.nextActions).toHaveLength(1);
    expect(report.modelCallCount).toBe(1);
  });

  it("estimates added test cases from + lines opening with test(/it(/describe(", () => {
    const report = assembleReport(parts());
    expect(report.addedTestFiles[0]).toEqual({ path: "tests/add.test.ts", estimatedTestCount: 2 });
  });

  it("redacts prose, the dry-run preview, and the proposed diff", () => {
    const secret = "ghp_" + "0123456789abcdefABCDEFghijklmnopqrst";
    const report = assembleReport(
      parts({
        coveredBehavior: `leak ${secret}`,
        proposedDiff: `+const token = "${secret}";`,
        dryRunPreview: `note ${secret}`,
        nextActions: [`do ${secret}`],
      }),
    );
    expect(report.coveredBehavior).not.toContain(secret);
    expect(report.proposedDiff).not.toContain(secret);
    expect(report.dryRunPreview).not.toContain(secret);
    expect(report.nextActions[0]).not.toContain(secret);
  });

  it("redacts a secret-shaped token in verificationSkipReason", () => {
    const token = "ghp_" + "0123456789abcdefghijABCDEFGHIJ0123456789";
    const report = assembleReport(parts({ verificationSkipReason: `skipped: ${token}` }));
    expect(report.verificationSkipReason).not.toContain(token);
  });

  it("carries the verification summary when present", () => {
    const report = assembleReport(
      parts({ status: "completed", verificationSummary: auditSummary }),
    );
    expect(report.verificationSummary?.overallStatus).toBe("passed");
  });

  it("omits optional prose fields when absent", () => {
    const report = assembleReport(parts({ coveredBehavior: undefined, knownGaps: undefined }));
    expect(report.coveredBehavior).toBeUndefined();
    expect(report.knownGaps).toBeUndefined();
  });

  it("is JSON-serializable", () => {
    const report = assembleReport(parts());
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({
      workflowId: "unit-test-generation",
    });
  });
});

describe("renderMarkdownReport", () => {
  it("renders status, files, prose, and next actions", () => {
    const md = renderMarkdownReport(assembleReport(parts()));
    expect(md).toContain("# Unit-test generation: dry-run");
    expect(md).toContain("tests/add.test.ts");
    expect(md).toContain("## Covered behavior");
    expect(md).toContain("## Next actions");
    expect(md).toContain("verification skipped");
  });

  it("renders the verification status when a summary is present", () => {
    const md = renderMarkdownReport(
      assembleReport(
        parts({
          status: "completed",
          verificationSummary: auditSummary,
          verificationSkipReason: undefined,
        }),
      ),
    );
    expect(md).toContain("Status: passed");
  });
});
