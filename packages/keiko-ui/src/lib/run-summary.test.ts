// Issue #66 — formatRunSummary unit tests. 12 kind × status cases plus defensive shape cases.

import { describe, expect, it } from "vitest";
import { classifyRunReport, formatRunSummary, formatRunSummaryFromManifest } from "./run-summary";

const UNIT_KIND = { workflowId: "unit-test-generation" } as const;
const BUG_KIND = { workflowId: "bug-investigation" } as const;
const VERIFY_KIND = { taskType: "verify" } as const;
const EXPLAIN_KIND = { taskType: "explain-plan" } as const;

describe("formatRunSummary — completed shapes per kind", () => {
  it("unit-tests: counts files and tests when present", () => {
    const r = formatRunSummary(
      {
        status: "completed",
        addedTestFiles: [
          { path: "a.test.ts", estimatedTestCount: 4 },
          { path: "b.test.ts", estimatedTestCount: 3 },
        ],
      },
      UNIT_KIND,
    );
    expect(r.workflowStatus).toBe("completed");
    expect(r.shortResult).toBe("Generated 2 test files; 7 tests proposed.");
  });

  it("unit-tests: counts files only when estimatedTestCount missing", () => {
    const r = formatRunSummary(
      { status: "completed", addedTestFiles: [{ path: "a.test.ts" }] },
      UNIT_KIND,
    );
    expect(r.shortResult).toBe("Generated 1 test files.");
  });

  it("unit-tests: falls back to Completed. when no files surfaced", () => {
    const r = formatRunSummary({ status: "completed" }, UNIT_KIND);
    expect(r.shortResult).toBe("Completed.");
  });

  it("bug-investigation completed", () => {
    const r = formatRunSummary({ status: "completed" }, BUG_KIND);
    expect(r.shortResult).toBe("Investigation complete; root cause documented.");
  });

  it("bug-investigation investigation-only is a completed terminal", () => {
    const r = formatRunSummary({ status: "investigation-only" }, BUG_KIND);
    expect(r.workflowStatus).toBe("completed");
  });

  it("verify completed with classifications", () => {
    const r = formatRunSummary(
      {
        status: "completed",
        verificationSummary: { results: [{}, {}, {}, {}, {}] },
      },
      VERIFY_KIND,
    );
    expect(r.shortResult).toBe("Verification passed: 5 classifications.");
  });

  it("verify completed without verificationSummary", () => {
    const r = formatRunSummary({ status: "completed" }, VERIFY_KIND);
    expect(r.shortResult).toBe("Verification passed.");
  });

  it("explain-plan completed with dryRunPreview lines", () => {
    const r = formatRunSummary(
      { status: "completed", dryRunPreview: "step one\nstep two\nstep three" },
      EXPLAIN_KIND,
    );
    expect(r.shortResult).toBe("Plan generated; 3 steps.");
  });

  it("explain-plan completed without preview", () => {
    const r = formatRunSummary({ status: "completed" }, EXPLAIN_KIND);
    expect(r.shortResult).toBe("Plan generated.");
  });
});

describe("formatRunSummary — failed shape", () => {
  it("failed with a failure message", () => {
    const r = formatRunSummary(
      { status: "failed", failure: { message: "tsc found 2 errors" } },
      UNIT_KIND,
    );
    expect(r.workflowStatus).toBe("failed");
    expect(r.shortResult).toBe("Run failed: tsc found 2 errors.");
  });

  it("failed without a failure message", () => {
    const r = formatRunSummary({ status: "failed" }, BUG_KIND);
    expect(r.shortResult).toBe("Run failed.");
  });

  it("rejected maps to failed", () => {
    const r = formatRunSummary({ status: "rejected" }, BUG_KIND);
    expect(r.workflowStatus).toBe("failed");
  });
});

describe("formatRunSummary — cancelled", () => {
  it("cancelled is a terminal status", () => {
    const r = formatRunSummary({ status: "cancelled" }, VERIFY_KIND);
    expect(r.workflowStatus).toBe("cancelled");
    expect(r.shortResult).toBe("Run cancelled.");
  });
});

describe("formatRunSummary — running", () => {
  it("running is passed through with empty shortResult", () => {
    const r = formatRunSummary({ status: "running" }, EXPLAIN_KIND);
    expect(r.workflowStatus).toBe("running");
    expect(r.shortResult).toBe("");
  });
});

describe("formatRunSummary — defensive shapes", () => {
  it("null report uses the conservative completed default", () => {
    const r = formatRunSummary(null, UNIT_KIND);
    expect(r.workflowStatus).toBe("completed");
    expect(r.shortResult).toBe("Completed.");
  });

  it("non-object report (string) does not throw", () => {
    const r = formatRunSummary("hello" as unknown, UNIT_KIND);
    expect(r.workflowStatus).toBe("completed");
  });

  it("missing status falls through to the conservative completed default", () => {
    // After self-critique #3 the formatter no longer fabricates per-kind text for an
    // unknown-shape payload — it returns the safe "Completed." default. The hook uses
    // classifyRunReport to keep polling rather than calling formatRunSummary here.
    const r = formatRunSummary({}, VERIFY_KIND);
    expect(r.workflowStatus).toBe("completed");
    expect(r.shortResult).toBe("Completed.");
  });

  it("truncates failure messages so shortResult stays ≤ 200 chars", () => {
    const huge = "x".repeat(500);
    const r = formatRunSummary({ status: "failed", failure: { message: huge } }, UNIT_KIND);
    expect(r.shortResult.length).toBeLessThanOrEqual(200);
  });

  it("unknown workflow kind still produces non-throwing summary", () => {
    const r = formatRunSummary({ status: "completed" }, { workflowId: "unknown-workflow" });
    expect(r.shortResult).toBe("Completed.");
  });
});

describe("classifyRunReport — keep-polling on unknown shapes (self-critique #3)", () => {
  it("non-object report returns kind=unknown", () => {
    expect(classifyRunReport(null, UNIT_KIND).kind).toBe("unknown");
    expect(classifyRunReport("oops" as unknown, UNIT_KIND).kind).toBe("unknown");
    expect(classifyRunReport(undefined, UNIT_KIND).kind).toBe("unknown");
  });

  it("report missing status returns kind=unknown", () => {
    expect(classifyRunReport({}, UNIT_KIND).kind).toBe("unknown");
  });

  it("report with unrecognised status returns kind=unknown", () => {
    expect(classifyRunReport({ status: "weird-state" }, UNIT_KIND).kind).toBe("unknown");
  });

  it("running status returns kind=running", () => {
    expect(classifyRunReport({ status: "running" }, UNIT_KIND).kind).toBe("running");
  });

  it("terminal status returns kind=terminal with the summary", () => {
    const outcome = classifyRunReport({ status: "completed" }, UNIT_KIND);
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind === "terminal") {
      expect(outcome.summary.workflowStatus).toBe("completed");
    }
  });
});

describe("formatRunSummaryFromManifest", () => {
  it("completed outcome with verify kind", () => {
    const r = formatRunSummaryFromManifest({ run: { outcome: "completed" } }, VERIFY_KIND);
    expect(r.workflowStatus).toBe("completed");
    expect(r.shortResult).toBe("Verification passed.");
  });

  it("cancelled outcome", () => {
    const r = formatRunSummaryFromManifest({ run: { outcome: "cancelled" } }, UNIT_KIND);
    expect(r.workflowStatus).toBe("cancelled");
  });

  it("failed outcome", () => {
    const r = formatRunSummaryFromManifest({ run: { outcome: "failed" } }, BUG_KIND);
    expect(r.workflowStatus).toBe("failed");
  });

  it("limit-exceeded outcome maps to failed", () => {
    const r = formatRunSummaryFromManifest({ run: { outcome: "limit-exceeded" } }, UNIT_KIND);
    expect(r.workflowStatus).toBe("failed");
  });

  it("unknown outcome falls back to completed default", () => {
    const r = formatRunSummaryFromManifest({ run: { outcome: "weird" } }, UNIT_KIND);
    expect(r.workflowStatus).toBe("completed");
  });

  it("non-object manifest does not throw", () => {
    const r = formatRunSummaryFromManifest(null, EXPLAIN_KIND);
    expect(r.workflowStatus).toBe("completed");
  });
});
