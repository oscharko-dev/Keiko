import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_OPERATION_REGISTRY,
  activityLogEvent,
  supportIncidentFileName,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { serializeSupportIncidentRecord } from "./support-incident-store.js";
import {
  recordRegisteredFailureIncident,
  listSupportIncidents,
  dismissSupportIncident,
  drainSupportIncidentCandidates,
  setSupportIncidentTriggerForTests,
} from "./support-incident.js";
import {
  computeDefectFingerprint,
  registeredFailureFingerprintInput,
} from "./defect-fingerprint.js";
import { createFileServerLogSink, closeFileServerLogSinks } from "./server-log.js";
import { createDesktopSupportReport } from "./reader/support-desktop-report.js";
import { parseSupportReport, analyzeSupportReport } from "./reader/support-report.js";

const race = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined }));
vi.mock("./support-incident-store.js", async (original) => {
  const store = await original<typeof import("./support-incident-store.js")>();
  return {
    ...store,
    listSupportIncidentEntries: (
      stateDir: string,
    ): ReturnType<typeof store.listSupportIncidentEntries> => {
      const before = store.listSupportIncidentEntries(stateDir);
      const hook = race.hook;
      race.hook = undefined;
      hook?.();
      return before;
    },
  };
});
let stateDir: string;
beforeEach((): void => {
  stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-client-v2-"));
});
afterEach((): void => {
  race.hook = undefined;
  setSupportIncidentTriggerForTests(undefined);
  closeFileServerLogSinks();
  rmSync(stateDir, { recursive: true, force: true });
});
const FRAME = `dist/ui/static/_next/static/chunks/sha256-${"a".repeat(64)}.js:4:2`;
function facts(
  correlationId = "CustomerPayroll.xlsx",
): Parameters<typeof recordRegisteredFailureIncident>[1] {
  return {
    op: "client.diagnostic",
    errorKind: "internal",
    correlationId,
    parentCorrelationId: "CustomerNotebook.docx",
    clientKind: "boundary",
    renderFailure: "shell",
    frames: [FRAME],
  };
}
function created(
  correlationId: string,
): Extract<NonNullable<ReturnType<typeof recordRegisteredFailureIncident>>, { status: "created" }> {
  const result = recordRegisteredFailureIncident(stateDir, facts(correlationId));
  if (result?.status !== "created") throw new TypeError("Expected a created incident.");
  return result;
}
function incidentId(result: ReturnType<typeof recordRegisteredFailureIncident>): string {
  if (result === undefined || result.status === "rejected")
    throw new TypeError("Expected retained incident.");
  return result.incidentId;
}
type StageRegistration = Extract<
  (typeof ACTIVITY_LOG_OPERATION_REGISTRY)[number],
  { readonly op: "client.stage.started" | "client.stage.settled" }
>;
function writeStage(
  sink: ReturnType<typeof createFileServerLogSink>,
  op: "client.stage.started" | "client.stage.settled",
): void {
  const stage = ACTIVITY_LOG_OPERATION_REGISTRY.find(
    (entry): entry is StageRegistration =>
      (entry.op === "client.stage.started" || entry.op === "client.stage.settled") &&
      entry.op === op,
  );
  if (stage === undefined) throw new TypeError("Missing parent stage operation.");
  sink.write(
    activityLogEvent(
      stage,
      { correlationId: "CustomerNotebook.docx" },
      { stage: "editor-project-selection", ordinal: 1 },
    ),
  );
}
function writeFailure(frame = FRAME): void {
  const operation = ACTIVITY_LOG_OPERATION_REGISTRY.find(
    (entry) => entry.op === "client.diagnostic",
  );
  if (operation === undefined) throw new TypeError("Missing client diagnostic operation.");
  const sink = createFileServerLogSink(stateDir, { level: "debug" });
  writeStage(sink, "client.stage.started");
  sink.write(
    activityLogEvent(
      operation,
      {
        level: "error",
        errorKind: "internal",
        correlationId: "CustomerPayroll.xlsx",
        parentCorrelationId: "CustomerNotebook.docx",
      },
      {
        clientNoteDigest: "b".repeat(64),
        clientKind: "boundary",
        renderFailure: "shell",
        frames: [frame],
        errorClass: "Error",
        causeChain: ["TypeError"],
      },
    ),
  );
  writeStage(sink, "client.stage.settled");
  sink.close?.();
}
function report(): ReturnType<typeof parseSupportReport> {
  const response = createDesktopSupportReport(stateDir, "CustomerNotebook.docx");
  const parsed = parseSupportReport(response.reportJson);
  const extracted = inflateSync(Buffer.from(parsed.evidence.payload, "base64")).toString("utf8");
  expect(extracted).toContain(FRAME);
  expect(extracted).not.toContain("CustomerPayroll.xlsx");
  expect(extracted).not.toContain("CustomerNotebook.docx");
  expect(analyzeSupportReport(response.reportJson).selection.reasons).not.toContain(
    "evidence-not-retained",
  );
  return parsed;
}
describe("canonical client incident version compatibility and occurrence claims", (): void => {
  it("exports a raw browser chunk failure through the real sink and automatic trigger", (): void => {
    setSupportIncidentTriggerForTests(true);
    const rawFrame = "dist/ui/static/_next/static/chunks/customerpayroll.js:4:2";
    writeFailure(rawFrame);
    drainSupportIncidentCandidates();
    const [incident] = listSupportIncidents(stateDir);
    expect(incident?.fingerprint.frameCount).toBe(1);
    const response = createDesktopSupportReport(stateDir, "CustomerNotebook.docx");
    const parsed = parseSupportReport(response.reportJson);
    const extracted = inflateSync(Buffer.from(parsed.evidence.payload, "base64")).toString("utf8");
    expect(parsed.incident.frameCount).toBe(1);
    expect(analyzeSupportReport(response.reportJson).selection.status).toBe("complete");
    expect(extracted).toMatch(/chunks\/sha256-[a-f0-9]{64}\.js:4:2/u);
    expect(extracted).not.toContain("customerpayroll");
  });
  it("exports and reparses actual compressed v2 evidence with context and private causal joins", (): void => {
    writeFailure();
    created("CustomerPayroll.xlsx");
    const parsed = report();
    expect(parsed.incident.fingerprintAlgorithm).toBe(2);
    expect(parsed.incident.frameCount).toBe(1);
    expect(parsed.incident.correlation.childCorrelationIds).toHaveLength(1);
  });
  it("still verifies an authentic historical v1 fingerprint over the same retained line", (): void => {
    writeFailure();
    const current = created("CustomerPayroll.xlsx");
    const input = registeredFailureFingerprintInput(facts(), 1);
    const historical = {
      ...current.record,
      fingerprint: {
        ...current.record.fingerprint,
        algorithm: 1 as const,
        defectFingerprint: computeDefectFingerprint(input),
        frameCount: 0,
      },
    };
    const payload = serializeSupportIncidentRecord(historical);
    if (payload === undefined) throw new TypeError("Historical fixture must be valid.");
    const path = join(stateDir, "support-incidents", supportIncidentFileName(current.incidentId));
    writeFileSync(path, payload);
    expect(readFileSync(path)).toEqual(payload);
    expect(report().incident.fingerprintAlgorithm).toBe(1);
  });
  it("releases the occurrence claim on expiry as well as dismissal", (): void => {
    const first = created("expiry-first");
    expect(listSupportIncidents(stateDir, { nowMs: first.record.expiresAtMs })).toEqual([]);
    const next = created("expiry-first");
    expect(next.incidentId).not.toBe(first.incidentId);
    expect(dismissSupportIncident(stateDir, next.incidentId)).toBe("dismissed");
    expect(created("expiry-first").incidentId).not.toBe(next.incidentId);
  });
  it.each([true, false])(
    "keeps atomic concurrent occurrence claims (same correlation: %s)",
    (same): void => {
      let winner: ReturnType<typeof recordRegisteredFailureIncident>;
      race.hook = (): void => {
        winner = recordRegisteredFailureIncident(stateDir, facts("race-first"));
      };
      const other = recordRegisteredFailureIncident(
        stateDir,
        facts(same ? "race-first" : "race-second"),
      );
      expect(winner?.status).toBe("created");
      expect(other?.status).toBe(same ? "deduplicated" : "created");
      expect(listSupportIncidents(stateDir)).toHaveLength(same ? 1 : 2);
      if (same) expect(incidentId(other)).toBe(incidentId(winner));
    },
  );
});
