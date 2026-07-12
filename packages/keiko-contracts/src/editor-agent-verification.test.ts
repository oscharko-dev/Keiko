import { describe, expect, it } from "vitest";
import {
  isEditorAgentVerificationResult,
  parseEditorAgentVerificationResult,
  parseEditorAgentVerificationRunRequest,
  toRedactedVerificationReport,
} from "./editor-agent-verification.js";
import {
  VERIFICATION_FAILURE_MESSAGE_MAX_CHARS,
  VERIFICATION_MAX_FAILURE_LOCATIONS,
} from "./verification.js";
import type { VerificationReport } from "./verification.js";

const AUTHORITY = { runId: "run-1", envelopeDigest: "a".repeat(64) };

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    sessionId: "session-1",
    kind: "typecheck",
    authorityRef: AUTHORITY,
    ...over,
  };
}

describe("parseEditorAgentVerificationRunRequest", () => {
  it("accepts a minimal, well-formed request", () => {
    const parsed = parseEditorAgentVerificationRunRequest(request());
    expect(parsed).toEqual({
      ok: true,
      value: {
        schemaVersion: "1",
        sessionId: "session-1",
        kind: "typecheck",
        authorityRef: AUTHORITY,
      },
    });
  });

  it("accepts a workspace-contained targetPath for targeted-test", () => {
    const parsed = parseEditorAgentVerificationRunRequest(
      request({ kind: "targeted-test", targetPath: "src/a.test.ts" }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.targetPath).toBe("src/a.test.ts");
  });

  it("requires targetPath only for targeted-test", () => {
    expect(parseEditorAgentVerificationRunRequest(request({ kind: "targeted-test" })).ok).toBe(
      false,
    );
    expect(
      parseEditorAgentVerificationRunRequest(
        request({ kind: "typecheck", targetPath: "src/a.test.ts" }),
      ).ok,
    ).toBe(false);
  });

  it("deep-projects the request and strips unknown authority properties", () => {
    const parsed = parseEditorAgentVerificationRunRequest(
      request({
        secret: "TOP_LEVEL_SECRET",
        authorityRef: { ...AUTHORITY, secret: "NESTED_SECRET" },
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        schemaVersion: "1",
        sessionId: "session-1",
        kind: "typecheck",
        authorityRef: AUTHORITY,
      },
    });
  });

  it.each([
    ["a non-object", 42],
    ["a wrong schemaVersion", request({ schemaVersion: "2" })],
    ["a missing sessionId", request({ sessionId: "" })],
    ["an unsupported kind", request({ kind: "deploy" })],
    ["an escaping targetPath", request({ targetPath: "../../etc/passwd" })],
    ["a missing authorityRef", request({ authorityRef: undefined })],
    ["an authorityRef without a digest", request({ authorityRef: { runId: "run-1" } })],
  ])("rejects %s", (_label, input) => {
    expect(parseEditorAgentVerificationRunRequest(input).ok).toBe(false);
  });

  it("collects deterministic field errors without throwing", () => {
    const parsed = parseEditorAgentVerificationRunRequest({ kind: "deploy" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

function report(over: Partial<VerificationReport["results"][number]> = {}): VerificationReport {
  return {
    workspaceRoot: "/repo",
    overallStatus: "failed",
    startedAtMs: 1,
    durationMs: 9,
    counts: {
      passed: 0,
      failed: 1,
      skipped: 0,
      denied: 0,
      "timed-out": 0,
      cancelled: 0,
      "resource-exceeded": 0,
    },
    results: [
      {
        kind: "typecheck",
        scriptName: "typecheck",
        command: "npm",
        args: ["SECRET_ARG"],
        status: "failed",
        exitCode: 2,
        signal: null,
        durationMs: 9,
        truncated: false,
        redacted: true,
        outputSummary: "SECRET_SUMMARY",
        appliedLimits: [],
        ...over,
      },
    ],
  };
}

describe("toRedactedVerificationReport", () => {
  it("keeps enums, counts, durations, and structured locations", () => {
    const redacted = toRedactedVerificationReport(
      report({ locations: [{ file: "src/a.ts", line: 3, message: "TS2322" }] }),
    );
    expect(redacted).toEqual({
      overallStatus: "failed",
      durationMs: 9,
      counts: {
        passed: 0,
        failed: 1,
        skipped: 0,
        denied: 0,
        "timed-out": 0,
        cancelled: 0,
        "resource-exceeded": 0,
      },
      steps: [
        {
          kind: "typecheck",
          status: "failed",
          durationMs: 9,
          locations: [{ file: "src/a.ts", line: 3, message: "TS2322" }],
        },
      ],
    });
  });

  it("drops outputSummary, command, and argv by omission (content-free by construction)", () => {
    const serialized = JSON.stringify(toRedactedVerificationReport(report()));
    expect(serialized).not.toContain("SECRET_SUMMARY");
    expect(serialized).not.toContain("SECRET_ARG");
    expect(serialized).not.toContain("outputSummary");
    expect(serialized).not.toContain("command");
  });
});

describe("isEditorAgentVerificationResult", () => {
  it("accepts a completed result", () => {
    expect(
      isEditorAgentVerificationResult({
        outcome: "completed",
        report: toRedactedVerificationReport(report()),
      }),
    ).toBe(true);
  });

  it("accepts a not-run disposition", () => {
    expect(
      isEditorAgentVerificationResult({
        outcome: "not-run",
        disposition: "review-required",
        reason: "mode-approval-required",
      }),
    ).toBe(true);
  });

  it.each([
    { outcome: "??" },
    { outcome: "completed" },
    { outcome: "not-run", disposition: "allowed", reason: "x" },
    { outcome: "not-run", disposition: "denied" },
  ])("rejects a malformed result %#", (value) => {
    expect(isEditorAgentVerificationResult(value)).toBe(false);
  });

  it.each([
    ["a non-finite report duration", { durationMs: Number.POSITIVE_INFINITY }],
    ["an unknown overall status", { overallStatus: "unknown" }],
    ["a negative count", { counts: { failed: -1 } }],
    ["an unknown step kind", { steps: [{ kind: "deploy" }] }],
    ["a non-finite step duration", { steps: [{ durationMs: Number.NaN }] }],
  ])("rejects %s", (_label, reportOverride) => {
    const base = toRedactedVerificationReport(report());
    const stepOverride =
      "steps" in reportOverride && Array.isArray(reportOverride.steps)
        ? { steps: [{ ...base.steps[0], ...reportOverride.steps[0] }] }
        : {};
    const countsOverride =
      "counts" in reportOverride
        ? { counts: { ...base.counts, ...(reportOverride.counts as Record<string, number>) } }
        : {};
    const value = {
      outcome: "completed",
      report: { ...base, ...reportOverride, ...stepOverride, ...countsOverride },
    };
    expect(isEditorAgentVerificationResult(value)).toBe(false);
  });

  it("rejects malformed or over-bound failure locations", () => {
    const base = toRedactedVerificationReport(report());
    const value = (locations: readonly unknown[]): unknown => ({
      outcome: "completed",
      report: { ...base, steps: [{ ...base.steps[0], locations }] },
    });
    expect(
      isEditorAgentVerificationResult(value([{ file: "src/a.ts", line: 0, message: "x" }])),
    ).toBe(false);
    expect(
      isEditorAgentVerificationResult(value([{ file: "src/a.ts", column: 1, message: "x" }])),
    ).toBe(false);
    expect(
      isEditorAgentVerificationResult(
        value([
          {
            file: "src/a.ts",
            message: "x".repeat(VERIFICATION_FAILURE_MESSAGE_MAX_CHARS + 1),
          },
        ]),
      ),
    ).toBe(false);
    expect(
      isEditorAgentVerificationResult(
        value(
          Array.from({ length: VERIFICATION_MAX_FAILURE_LOCATIONS + 1 }, () => ({
            file: "src/a.ts",
            message: "x",
          })),
        ),
      ),
    ).toBe(false);
  });

  it("rejects internally inconsistent counts and overall status", () => {
    const base = toRedactedVerificationReport(report());
    expect(
      isEditorAgentVerificationResult({
        outcome: "completed",
        report: { ...base, counts: { ...base.counts, failed: 0, passed: 1 } },
      }),
    ).toBe(false);
    expect(
      isEditorAgentVerificationResult({
        outcome: "completed",
        report: { ...base, overallStatus: "passed" },
      }),
    ).toBe(false);
  });

  it("rejects NUL-bearing and UTF-16-over-bound location text", () => {
    const base = toRedactedVerificationReport(report());
    const withMessage = (message: string): unknown => ({
      outcome: "completed",
      report: {
        ...base,
        steps: [{ ...base.steps[0], locations: [{ file: "src/a.ts", message }] }],
      },
    });
    expect(isEditorAgentVerificationResult(withMessage("bad\u0000message"))).toBe(false);
    expect(
      isEditorAgentVerificationResult(
        withMessage("😀".repeat(VERIFICATION_FAILURE_MESSAGE_MAX_CHARS)),
      ),
    ).toBe(false);
  });

  it("returns an exact deep projection with unknown nested properties removed", () => {
    const base = toRedactedVerificationReport(
      report({ locations: [{ file: "src/a.ts", line: 3, message: "TS2322" }] }),
    );
    const parsed = parseEditorAgentVerificationResult({
      outcome: "completed",
      secret: "TOP_LEVEL_SECRET",
      report: {
        ...base,
        secret: "REPORT_SECRET",
        counts: { ...base.counts, secret: "COUNTS_SECRET" },
        steps: base.steps.map((step) => ({
          ...step,
          secret: "STEP_SECRET",
          locations: step.locations?.map((location) => ({
            ...location,
            secret: "LOCATION_SECRET",
          })),
        })),
      },
    });
    expect(parsed).toEqual({ outcome: "completed", report: base });
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
  });
});
