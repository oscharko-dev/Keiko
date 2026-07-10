import { describe, expect, it } from "vitest";
import {
  isEditorAgentVerificationResult,
  parseEditorAgentVerificationRunRequest,
  toRedactedVerificationReport,
} from "./editor-agent-verification.js";
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
});
