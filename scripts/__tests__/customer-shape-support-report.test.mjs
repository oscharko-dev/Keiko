import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSupportReport } from "../../packages/keiko-activity-log/dist/reader/index.js";
import { runSupportCli } from "../../packages/keiko-cli/dist/support.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../tests/support/activity-log-segments.ts";
import {
  customerShapeSupportReportEvidence,
  customerShapeSupportReportCorrelations,
  customerShapeSupportTimelineEvidence,
} from "../lib/customer-shape-evidence.mjs";

const RUN = "synthetic-run";
const DIAGNOSTIC = {
  op: "server.diagnostic.failure",
  correlationId: "synthetic-request",
  parentCorrelationId: RUN,
  ts: "2026-10-03T12:00:00.001Z",
  seq: 2,
  pid: 4242,
  errorKind: "internal",
  frames: ["packages/keiko-server/dist/route.js:1:1"],
};
const FAILURE = {
  op: "coding-sidecar.gateway.turn-failed",
  runId: RUN,
  correlationId: DIAGNOSTIC.correlationId,
  parentCorrelationId: RUN,
  ts: "2026-10-03T12:00:00.000Z",
  seq: 1,
  pid: 4242,
  failureCode: "stream-incomplete",
};
const EVIDENCE = { diagnostic: DIAGNOSTIC, turnFailure: FAILURE };

// This fixture tests the qualification assertion, not the analyzer or its sufficiency formula.
// The installed journey supplies real report/seed output from the production CLI.
function reportFixture() {
  const failure = {
    op: FAILURE.op,
    ts: FAILURE.ts,
    seq: FAILURE.seq,
    pid: FAILURE.pid,
    parentCorrelationId: RUN,
    extra: { runId: RUN, failureCode: FAILURE.failureCode },
  };
  const sufficiency = { status: "complete", reasons: [] };
  return {
    kind: "keiko.support.report-analysis",
    schemaVersion: 1,
    authenticity: "unknown",
    reportDigest: "a".repeat(64),
    sourceArtifactDigest: "b".repeat(64),
    incident: { correlation: { rootCorrelationId: RUN, childCorrelationIds: [] } },
    selection: sufficiency,
    analysis: {
      sufficiency,
      evidence: { supportedLineCount: 2 },
      timelines: [
        { correlationId: DIAGNOSTIC.correlationId, lines: [structuredClone(DIAGNOSTIC), failure] },
        { correlationId: RUN, lines: [failure] },
      ],
    },
    seed: {
      correlationId: RUN,
      sourceArtifact: { sha256: "b".repeat(64), lineCount: 2 },
      timeline: [failure],
      stackFrames: DIAGNOSTIC.frames,
      warnings: ["no prompt/response body was ever logged by design"],
      sufficiency,
    },
  };
}

function qualify(report, evidence = EVIDENCE) {
  return customerShapeSupportReportEvidence(report, evidence, RUN, 1024, ["synthetic-secret"]);
}

describe("installed support-report diagnostic qualification", () => {
  it("qualifies the actual compressed CLI export without raw customer correlation labels", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-customer-report-")));
    try {
      const stateDir = join(root, "state");
      const process = fixtureProcess(4242, "aabbccdd");
      const now = Date.now();
      const correlationId = "CustomerPayrollTurn";
      const runId = "CustomerPayrollRun";
      const failure = fixtureLine(process, now, {
        op: FAILURE.op,
        correlationId,
        parentCorrelationId: runId,
        fields: {
          runId,
          revision: 1,
          state: "running",
          failureCode: FAILURE.failureCode,
          published: true,
          publicationReason: "published",
          runtimeRetry: "refused",
        },
      });
      const diagnostic = fixtureLine(process, now + 1, {
        op: DIAGNOSTIC.op,
        correlationId,
        parentCorrelationId: runId,
        errorKind: "internal",
        level: "error",
        fields: {
          diagnosticOperation: "coding-sidecar.gateway",
          diagnosticErrorClass: "Error",
          source: "coding-sidecar.gateway",
          frames: ["packages/keiko-server/dist/coding-sidecar-gateway.js:740:3"],
          causeChain: ["Error"],
        },
      });
      writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [failure, diagnostic]);
      const errors = [];
      const code = await runSupportCli(
        ["export", "--state-dir", stateDir, "--correlation-id", runId, "--out", root],
        { out: () => undefined, err: (line) => errors.push(line) },
        {},
        { cwd: root, controlActivityStateDir: join(root, "control") },
      );
      expect(code, errors.join("")).toBe(0);
      const file = readdirSync(root).find((name) => name.startsWith("keiko-support-v1-"));
      const content = readFileSync(join(root, file), "utf8");
      const report = analyzeSupportReport(content);
      expect(JSON.stringify(report)).not.toContain(runId);
      expect(JSON.stringify(report)).not.toContain(correlationId);
      const evidence = { diagnostic: JSON.parse(diagnostic), turnFailure: JSON.parse(failure) };
      expect(
        customerShapeSupportReportEvidence(report, evidence, runId, content.length, [runId]),
      ).toMatchObject({ errorKind: "internal", failureCode: "stream-incomplete", frameCount: 1 });
      const correlations = customerShapeSupportReportCorrelations(report, evidence, runId);
      expect(correlations.runId).toBe(report.incident.correlation.rootCorrelationId);
      const output = [];
      expect(
        await runSupportCli(
          ["analyze", join(root, file), "--correlation-id", correlations.diagnosticId, "--json"],
          { out: (line) => output.push(line), err: (line) => errors.push(line) },
          {},
          { cwd: root, controlActivityStateDir: join(root, "control") },
        ),
        errors.join(""),
      ).toBe(0);
      expect(
        customerShapeSupportTimelineEvidence(
          JSON.parse(output.join("")),
          report,
          correlations.diagnosticId,
          DIAGNOSTIC.op,
        ).lineCount,
      ).toBe(2);
      const unrelated = structuredClone(report);
      unrelated.incident.correlation.rootCorrelationId = "unrelated-run";
      expect(() =>
        customerShapeSupportReportEvidence(unrelated, evidence, runId, content.length, [runId]),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reports only closed failure values and reconstruction counts", () => {
    expect(qualify(reportFixture())).toEqual({
      selection: { status: "complete", reasons: [] },
      sufficiency: { status: "complete", reasons: [] },
      partialOperations: [],
      reportBytes: 1024,
      recordCount: 2,
      errorKind: "internal",
      failureCode: "stream-incomplete",
      frameCount: 1,
      causeCount: 0,
      seedLineCount: 1,
      gatewayAttemptCount: 0,
      seedWarningCount: 1,
    });
  });

  it.each([
    (report) => {
      report.kind = "raw-log";
    },
    (report) => {
      report.authenticity = "verified";
    },
    (report) => {
      report.reportDigest = "invalid";
    },
    (report) => {
      report.selection.reasons = ["lifecycle-start-missing"];
    },
    (report) => {
      report.selection.reasons = ["unreviewed-reason"];
    },
    (report) => {
      report.analysis.timelines[0].correlationId = RUN;
    },
    (report) => {
      report.analysis.timelines[0].lines[0].parentCorrelationId = "other-run";
    },
    (report) => {
      report.analysis.timelines[0].lines[0].frames = [];
    },
    (report) => {
      report.analysis.timelines[0].lines[0].frames = ["packages/keiko-server/dist/other.js:1:1"];
    },
    (report) => {
      report.analysis.timelines[0].lines[0].causeChain = ["error-kind:internal"];
    },
    (report) => {
      report.analysis.timelines[0].lines[0].errorKind = "timeout";
    },
    (report) => {
      report.analysis.timelines[1].lines[0].extra.failureCode = "provider-failed";
    },
    (report) => {
      report.analysis.timelines[1].lines[0].extra.runId = "other-run";
    },
    (report) => {
      delete report.seed;
    },
    (report) => {
      report.seed.sourceArtifact.sha256 = "c".repeat(64);
    },
    (report) => {
      report.seed.sourceArtifact.lineCount = 1;
    },
    (report) => {
      report.seed.timeline = [];
    },
    (report) => {
      report.seed.stackFrames = [];
    },
    (report) => {
      report.seed.warnings = [];
    },
    (report) => {
      report.seed.sufficiency.status = "degraded";
    },
    (report) => {
      report.seed.warnings.push("synthetic-secret");
    },
  ])("rejects a lost, mislinked, contradictory or content-bearing projection (%#)", (mutate) => {
    const report = reportFixture();
    mutate(report);
    expect(() => qualify(report)).toThrow();
  });

  it("retains honest missing-evidence status and actual replay/cause counts", () => {
    const report = reportFixture();
    report.selection = { status: "insufficient", reasons: ["lifecycle-start-missing"] };
    report.analysis.timelines[0].lines[0].causeChain = ["error-kind:internal"];
    report.seed.gatewayScript = { attempts: [{ outcome: "provider-error" }] };
    const evidence = {
      ...EVIDENCE,
      diagnostic: { ...DIAGNOSTIC, causeChain: ["error-kind:internal"] },
    };
    expect(qualify(report, evidence)).toMatchObject({
      selection: report.selection,
      causeCount: 1,
      gatewayAttemptCount: 1,
    });
  });

  it("names partial registered operations once and redacts an unreviewed operation", () => {
    const report = reportFixture();
    const partial = { op: "activity-log.segment.sealed", extra: { completeness: "partial" } };
    report.analysis.timelines[1].lines.push(partial, partial, {
      op: "unreviewed.synthetic-detail",
      extra: { completeness: "unknown" },
    });
    expect(qualify(report).partialOperations).toEqual([
      "activity-log.segment.sealed",
      "[redacted]",
    ]);
  });
});

function timelineFixture(report, correlationId = RUN) {
  const timeline = report.analysis.timelines.find((entry) => entry.correlationId === correlationId);
  return {
    kind: "keiko.support.report-timeline",
    schemaVersion: 1,
    authenticity: "unknown",
    analyzerVersion: "1.1.13",
    reportDigest: report.reportDigest,
    sourceArtifactDigest: report.sourceArtifactDigest,
    ...structuredClone(timeline),
    sufficiency: { status: "complete", reasons: [] },
  };
}

describe("installed support-report timeline qualification", () => {
  it("accepts the validated timeline of one correlation of the same report", () => {
    const report = reportFixture();
    expect(
      customerShapeSupportTimelineEvidence(timelineFixture(report), report, RUN, FAILURE.op),
    ).toEqual({ lineCount: 1, sufficiency: { status: "complete", reasons: [] } });
  });

  it("refuses another envelope, another report, another correlation or a missing operation", () => {
    const report = reportFixture();
    const refusals = [
      { ...timelineFixture(report), kind: "keiko.support.report-analysis" },
      { ...timelineFixture(report), reportDigest: "c".repeat(64) },
      timelineFixture(report, DIAGNOSTIC.correlationId),
      { ...timelineFixture(report), lines: [] },
      undefined,
    ];
    for (const timeline of refusals) {
      expect(() => customerShapeSupportTimelineEvidence(timeline, report, RUN, FAILURE.op)).toThrow(
        TypeError,
      );
    }
  });

  it("refuses a timeline whose sufficiency contradicts its own reasons", () => {
    const report = reportFixture();
    const timeline = {
      ...timelineFixture(report),
      sufficiency: { status: "complete", reasons: ["segment-unreadable"] },
    };
    expect(() => customerShapeSupportTimelineEvidence(timeline, report, RUN, FAILURE.op)).toThrow(
      "contradictory sufficiency",
    );
  });
});
