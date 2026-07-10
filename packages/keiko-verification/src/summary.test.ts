import { describe, expect, it } from "vitest";
import { buildVerificationSummary, renderMarkdownSummary, summarizeForAudit } from "./summary.js";
import { buildAppliedLimits } from "./limits.js";
import { DEFAULT_VERIFICATION_LIMITS } from "./types.js";
import type { VerificationReport, VerificationResult, VerificationStatus } from "./types.js";

const SECRET = "ghp_" + "0123456789abcdefABCDEFghijklmnopqrst";

function result(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    kind: "test",
    scriptName: "test",
    command: "npm",
    args: ["test"],
    status: "passed",
    exitCode: 0,
    signal: null,
    durationMs: 12,
    truncated: false,
    redacted: true,
    outputSummary: "",
    appliedLimits: buildAppliedLimits(DEFAULT_VERIFICATION_LIMITS, undefined),
    detail: undefined,
    ...overrides,
  };
}

function report(results: readonly VerificationResult[]): VerificationReport {
  const count = (status: VerificationStatus): number =>
    results.filter((r) => r.status === status).length;
  return {
    workspaceRoot: "/ws",
    results,
    overallStatus: results.every((r) => r.status === "passed" || r.status === "skipped")
      ? "passed"
      : "failed",
    startedAtMs: 0,
    durationMs: 100,
    counts: {
      passed: count("passed"),
      failed: count("failed"),
      skipped: count("skipped"),
      denied: count("denied"),
      "timed-out": count("timed-out"),
      cancelled: count("cancelled"),
      "resource-exceeded": count("resource-exceeded"),
    },
  };
}

describe("buildVerificationSummary", () => {
  it("projects the report with the redacted output digest retained", () => {
    const summary = buildVerificationSummary(report([result({ outputSummary: "all good" })]));
    expect(summary.overallStatus).toBe("passed");
    expect(summary.results[0]?.outputSummary).toBe("all good");
    expect(summary.results[0]?.command).toBe("npm test");
  });

  it("preserves the summary contract fields required by the verification evidence schema", () => {
    const summary = buildVerificationSummary(
      report([
        result({
          kind: "lint",
          scriptName: "lint",
          args: ["run", "lint"],
          status: "failed",
          exitCode: 1,
          durationMs: 37,
          truncated: true,
          outputSummary: "lint failed",
          detail: "eslint reported an error",
        }),
      ]),
    );

    expect(summary).toMatchObject({
      workspaceRoot: "/ws",
      overallStatus: "failed",
      durationMs: 100,
      counts: {
        passed: 0,
        failed: 1,
        skipped: 0,
        denied: 0,
        "timed-out": 0,
        cancelled: 0,
        "resource-exceeded": 0,
      },
    });
    expect(summary.results[0]).toMatchObject({
      kind: "lint",
      scriptName: "lint",
      command: "npm run lint",
      status: "failed",
      exitCode: 1,
      durationMs: 37,
      truncated: true,
      outputSummary: "lint failed",
      detail: "eslint reported an error",
    });
    expect(summary.results[0]?.appliedLimits.map((row) => row.dimension)).toEqual([
      "wall-time",
      "output-size",
      "memory",
      "network",
    ]);
  });

  it("re-redacts a secret that somehow reached outputSummary or detail", () => {
    const summary = buildVerificationSummary(
      report([result({ status: "failed", outputSummary: SECRET, detail: SECRET })]),
    );
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it("carries structured failure locations through to the summary projection (ADR-0126 D3)", () => {
    const locations = [
      { file: "src/a.test.ts", line: 12, column: 3, message: "expected 2, got 0" },
    ];
    const summary = buildVerificationSummary(report([result({ status: "failed", locations })]));
    expect(summary.results[0]?.locations).toEqual(locations);
  });

  it("omits locations when the result carries none", () => {
    const summary = buildVerificationSummary(report([result({ status: "passed" })]));
    expect(summary.results[0]?.locations).toBeUndefined();
  });
});

describe("summarizeForAudit", () => {
  it("EXCLUDES raw output text but keeps status/exit/duration/appliedLimits/counts", () => {
    const audit = summarizeForAudit(
      report([result({ status: "failed", exitCode: 1, outputSummary: SECRET, detail: SECRET })]),
    );
    const json = JSON.stringify(audit);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("outputSummary");
    expect(json).not.toContain("detail");
    expect(audit.results[0]?.exitCode).toBe(1);
    expect(audit.results[0]?.appliedLimits).toHaveLength(4);
    expect(audit.counts.failed).toBe(1);
  });

  it("does not carry structured failure locations into the audit projection", () => {
    const audit = summarizeForAudit(
      report([
        result({
          status: "failed",
          locations: [{ file: "src/a.test.ts", line: 12, column: 3, message: "expected 2, got 0" }],
        }),
      ]),
    );
    expect("locations" in (audit.results[0] as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe("renderMarkdownSummary", () => {
  it("renders a table and redacts command-derived cells", () => {
    const md = renderMarkdownSummary(
      report([result({ status: "failed", exitCode: 1, args: ["test", "--token", SECRET] })]),
    );
    expect(md).toContain("| Kind | Status | Exit | ms | Command | Detail |");
    expect(md).toContain("| test | failed | 1 |");
    expect(md).not.toContain(SECRET);
  });

  it("shows an em dash for a null exit code", () => {
    const md = renderMarkdownSummary(report([result({ status: "cancelled", exitCode: null })]));
    expect(md).toContain("| test | cancelled | — |");
  });
});
