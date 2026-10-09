import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeLogText,
  analyzeSupportReport,
  buildSupportReport,
  DEFAULT_SUPPORT_QUERY_LIMITS,
  serializeSupportReport,
} from "@oscharko-dev/keiko-activity-log/reader";
import {
  recordUserReportedIncident,
  supportIncidentSegmentFiles,
} from "@oscharko-dev/keiko-activity-log";
import { supportIncidentPrivateProjection } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  executeSupportQuery,
  resolveSupportSelection,
} from "../../packages/keiko-cli/src/support-query-cli.js";
import { resolveSupportIncident } from "../../packages/keiko-cli/src/support-incident.js";
import { runConnectedRetrievalEval } from "../../packages/keiko-server/src/grounded-eval-support.js";
import {
  INCIDENT_FEATURE_PATH,
  INCIDENT_RETRIEVAL_FILES,
} from "../../scripts/check-retrieval-quality.mjs";
import { resetServerLogger } from "../support/activity-log-test-support.js";
import { readPersistedActivityLog } from "../support/activity-log-proof.js";
import { expectActivityLogScenario } from "../support/activity-log-scenario.js";

const CORRELATION_ID = "connected-context-retrieval-miss-fixture";
const REQUIRED_OPS = [
  "search.connected-context.started",
  "search.connected-context.source-details",
  "search.connected-context.completion-details",
  "search.connected-context.completed",
  "search.citations.reconciled",
];

async function driveHealthyAsk(): Promise<void> {
  const { pack } = await runConnectedRetrievalEval({
    files: INCIDENT_RETRIEVAL_FILES,
    query: `Which fields are required in ${INCIDENT_FEATURE_PATH}?`,
    correlationId: CORRELATION_ID,
    answer: `The feature requires an approval flag. [${INCIDENT_FEATURE_PATH}:6-8]`,
  });
  expect(pack.files.some((file) => file.scopePath === INCIDENT_FEATURE_PATH)).toBe(true);
  expect(pack.uncertainty.some((marker) => marker.kind === "uncited-answer")).toBe(false);
}

function assertHealthyEvidence(stateDir: string): void {
  const text = readPersistedActivityLog(stateDir);
  const analyzed = analyzeLogText(text);
  expect(analyzed.evidence.classification).toBe("supported");
  expect(analyzed.sufficiency.status).toBe("complete");
  expect(analyzed.findings ?? []).toEqual([]);
  const records = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const joined = records.filter((record) => record.correlationId === CORRELATION_ID);
  expect(joined.map((record) => record.op)).toEqual(expect.arrayContaining(REQUIRED_OPS));
  expect(joined.map((record) => record.op)).not.toContain("git.process.failed");
  const completed = joined.find((record) => record.op === "search.connected-context.completed");
  expect(completed).toMatchObject({ activityDetailStatus: "complete", coverageStatus: "complete" });
  expect(completed?.usageFilesRead).toBeGreaterThan(0);
  const details = joined.find((record) => record.op === "search.connected-context.source-details");
  expect(typeof details?.omittedLowRelevanceCount).toBe("number");
  expect(typeof completed?.omittedCount).toBe("number");
  expect(text).not.toContain(INCIDENT_FEATURE_PATH);
  expect(text).not.toContain("approval flag");
}

async function reconstructUserReportedAsk(
  stateDir: string,
  correlationId: string,
): Promise<ReturnType<typeof analyzeSupportReport>> {
  const creation = recordUserReportedIncident(stateDir, { correlationId });
  if (creation.status === "rejected" || creation.record === undefined)
    throw new Error("expected retained user-reported incident");
  const record = creation.record;
  const selection = await resolveSupportSelection(
    { incidentId: creation.incidentId, filter: {} },
    stateDir,
  );
  const query = executeSupportQuery(stateDir, selection, DEFAULT_SUPPORT_QUERY_LIMITS, {
    trigger: "query",
  }).result;
  const incident = supportIncidentPrivateProjection(
    resolveSupportIncident(record, supportIncidentSegmentFiles(stateDir, record), stateDir),
  );
  return analyzeSupportReport(serializeSupportReport(buildSupportReport(incident, query)));
}

describe("Activity Log scenario: connected-context retrieval incident (#3882)", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-connected-context-scenario-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
    resetServerLogger();
  });
  afterEach(() => {
    resetServerLogger();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reconstructs a healthy grounded ask with the real reader and joined body-free counters", async () => {
    await driveHealthyAsk();
    assertHealthyEvidence(stateDir);
    const report = await reconstructUserReportedAsk(stateDir, CORRELATION_ID);
    expect(report.analysis.evidence.classification).toBe("supported");
    expect(report.analysis.sufficiency.status).toBe("complete");
    expect(report.analysis.findings ?? []).toEqual([]);
    expect(report.selection).toMatchObject({
      status: "insufficient",
      reasons: ["no-registered-failure"],
    });
  });

  it("reconstructs a genuine dependency failure in a complete canonical report", async () => {
    const startedAtMs = Date.now();
    await expect(
      runConnectedRetrievalEval({
        files: INCIDENT_RETRIEVAL_FILES,
        query: `Which fields are required in ${INCIDENT_FEATURE_PATH}?`,
        correlationId: CORRELATION_ID,
        detectWorkspace: () => {
          throw new TypeError("synthetic workspace dependency failure");
        },
      }),
    ).rejects.toThrow(TypeError);
    const trace = await expectActivityLogScenario("memory-knowledge.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["search.connected-context.started", "search.connected-context.failed"],
    });
    expect(trace.failureClasses).toContain("connected-context-retrieval");
  });
});
