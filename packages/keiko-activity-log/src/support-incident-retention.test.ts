import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeFileServerLogSinks,
  createFileServerLogSink,
  resetServerLogFailureNotices,
  pinActivityLogWindow,
} from "./server-log.js";
import {
  listSupportIncidents,
  recordUserReportedIncident,
  recordRegisteredFailureIncident,
  setSupportIncidentTriggerForTests,
} from "./support-incident.js";

import { supportIncidentRetentionPolicy } from "./support-incident-retention.js";
import {
  ensureSupportIncidentDirectory,
  claimSupportIncidentSlot,
  listSupportIncidentClaims,
} from "./support-incident-store.js";
import { MAX_ACTIVITY_LOG_PINS, listActivityLogDirectory } from "./activity-log-store.js";
import * as incidentStore from "./support-incident-store.js";

import {
  attachActivityLogEventRegistration,
  activityLogOperationSchema,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createDesktopSupportReport } from "./reader/support-desktop-report.js";
import { parseSupportReport, analyzeSupportReport } from "./reader/support-report.js";

import {
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-incident-retention-"));
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  setSupportIncidentTriggerForTests(undefined);
  closeFileServerLogSinks();
  resetServerLogFailureNotices();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

function persistFreshFailure(): void {
  const op = "coding-runtime.readiness.failed";
  const registration = activityLogOperationSchema(op);
  if (registration === undefined) throw new Error("Expected registered fixture operation");
  setSupportIncidentTriggerForTests(false);
  createFileServerLogSink(stateDir).write(
    attachActivityLogEventRegistration(
      {
        level: "error",
        category: "process",
        op,
        correlationId: "fresh-protected-failure",
        errorKind: "unavailable",
        extra: {
          phase: "endpoint",
          frames: ["packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js:710:9"],
          causeChain: ["Error"],
          completeness: "complete",
          loss: "none",
        },
      },
      registration,
    ),
  );
}

describe("rolling diagnostic candidate retention", () => {
  it("admits the thirty-third manual candidate within the existing storage byte budget", () => {
    for (let index = 0; index < 33; index += 1) {
      expect(recordUserReportedIncident(stateDir).status).toBe("created");
    }
    expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(33);
  });

  it("expires unreported diagnostic candidates after twenty-four hours", () => {
    const nowMs = Date.now();
    expect(recordUserReportedIncident(stateDir, { nowMs }).status).toBe("created");
    expect(listSupportIncidents(stateDir, { nowMs: nowMs + 24 * 60 * 60 * 1000 })).toEqual([]);
  });
  it("rolls the oldest candidate and releases its pin when the governing byte buffer fills", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    const capacity = supportIncidentRetentionPolicy(stateDir).capacity;
    const first = recordUserReportedIncident(stateDir);
    if (first.status !== "created") throw new Error("Expected initial candidate");
    const pinPath = join(stateDir, "logs", `pin-${first.record.pin.pinId ?? "missing"}.json`);
    expect(existsSync(pinPath)).toBe(true);
    for (let index = 1; index < capacity; index += 1) {
      expect(recordUserReportedIncident(stateDir).status).toBe("created");
    }
    expect(recordUserReportedIncident(stateDir).status).toBe("created");
    const retained = listSupportIncidents(stateDir, { readOnly: true });
    expect(retained).toHaveLength(capacity);
    expect(retained.some((record) => record.incidentId === first.incidentId)).toBe(false);
    expect(existsSync(pinPath)).toBe(false);
    expect(
      listSupportIncidentClaims(stateDir).filter((claim) => claim.incidentId === first.incidentId),
    ).toEqual([]);
  });

  it("preserves legacy claims and never removes an in-flight peer reservation to admit a report", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    ensureSupportIncidentDirectory(stateDir);
    const capacity = supportIncidentRetentionPolicy(stateDir).capacity;
    for (let index = 0; index < capacity; index += 1) {
      expect(claimSupportIncidentSlot(stateDir, index, "a".repeat(32))).toBe(true);
    }
    expect(recordUserReportedIncident(stateDir)).toEqual({
      status: "rejected",
      reason: "quota-exhausted",
    });
    expect(listSupportIncidentClaims(stateDir)).toHaveLength(capacity);
    expect(claimSupportIncidentSlot(stateDir, 32, "b".repeat(32))).toBe(true);
    expect(claimSupportIncidentSlot(stateDir, 32, "c".repeat(32))).toBe(false);
  });

  it.each(["manual", "registered-child"] as const)(
    "joins rolled %s cleanup to its original correlation in canonical exports",
    (kind) => {
      vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
      const capacity = supportIncidentRetentionPolicy(stateDir).capacity;
      const first =
        kind === "manual"
          ? recordUserReportedIncident(stateDir, { correlationId: "retired-candidate" })
          : recordRegisteredFailureIncident(stateDir, {
              op: "client.diagnostic",
              errorKind: "internal",
              correlationId: "retired-candidate",
              parentCorrelationId: "retired-parent",
              clientKind: "boundary",
              renderFailure: "window-body",
            });
      if (first?.status !== "created") throw new Error("Expected initial candidate");
      const oldPinPath = join(stateDir, "logs", `pin-${first.record.pin.pinId ?? "missing"}.json`);
      expect(existsSync(oldPinPath)).toBe(true);
      for (let index = 1; index < capacity; index += 1) {
        expect(
          recordUserReportedIncident(stateDir, { correlationId: `filler-${String(index)}` }).status,
        ).toBe("created");
      }
      const fresh = recordUserReportedIncident(stateDir, { correlationId: "fresh-candidate" });
      if (fresh.status !== "created") throw new Error("Expected fresh candidate");
      expect(fresh.record.pin.status).toBe("pinned");
      expect(fresh.record.pin.evidenceLostBeforePin).toBe(false);
      expect(
        existsSync(join(stateDir, "logs", `pin-${fresh.record.pin.pinId ?? "missing"}.json`)),
      ).toBe(true);
      expect(existsSync(oldPinPath)).toBe(false);
      expect(
        listSupportIncidents(stateDir, { readOnly: true }).map((record) => record.incidentId),
      ).not.toContain(first.incidentId);
      const text = readPersistedActivityLog(stateDir);
      for (const op of ["activity-log.pin.expired", "support.incident.expired"]) {
        expect(
          persistedActivityLogLines(text, op).map((line) => JSON.parse(line) as unknown),
        ).toContainEqual(expect.objectContaining({ correlationId: "retired-candidate" }));
      }
      for (const correlationId of ["retired-candidate", "fresh-candidate"]) {
        const analyzed = analyzeSupportReport(
          createDesktopSupportReport(stateDir, correlationId).reportJson,
        );
        expect(analyzed.analysis.evidence.classification).toBe("supported");
        expect(
          analyzed.analysis.sufficiency.classes.flatMap((entry) => entry.reasons),
        ).not.toContain("lifecycle-start-missing");
        expect(analyzed.analysis.evidence.sequenceAnomalies).toEqual([]);
      }
    },
  );

  it("attempts only free reservation candidates without materializing a huge configured pool", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", String(Number.MAX_SAFE_INTEGER));
    const claim = vi.spyOn(incidentStore, "claimSupportIncidentSlot");
    expect(recordUserReportedIncident(stateDir).status).toBe("created");
    expect(claim).toHaveBeenCalledTimes(1);
    expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(1);
  });
  it("protects the sixty-fifth fresh causal error by rolling only the oldest diagnostic pin", () => {
    const ids: string[] = [];
    for (let index = 0; index <= MAX_ACTIVITY_LOG_PINS; index += 1) {
      if (index === MAX_ACTIVITY_LOG_PINS) persistFreshFailure();
      const result = recordRegisteredFailureIncident(
        stateDir,
        index === MAX_ACTIVITY_LOG_PINS
          ? {
              op: "coding-runtime.readiness.failed",
              errorKind: "unavailable",
              correlationId: "fresh-protected-failure",
              frames: ["packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js:710:9"],
            }
          : {
              op: "client.diagnostic",
              errorKind: "internal",
              correlationId: `causal-${String(index)}`,
              clientKind: "boundary",
              renderFailure: "window-body",
            },
      );
      expect(result?.status).toBe("created");
      if (result?.status !== "created") throw new Error("Expected causal candidate");
      expect(result.record.pin.status).toBe("pinned");
      ids.push(result.incidentId);
    }
    const retained = listSupportIncidents(stateDir, { readOnly: true });
    expect(retained).toHaveLength(MAX_ACTIVITY_LOG_PINS);
    expect(retained.some((record) => record.incidentId === ids[0])).toBe(false);
    expect(retained.some((record) => record.incidentId === ids.at(-1))).toBe(true);
    expect(
      persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "coding-runtime.readiness.failed",
      ),
    ).toHaveLength(1);
    const persisted = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "coding-runtime.readiness.failed",
    );
    expect(persisted[0]).toContain('"correlationId":"fresh-protected-failure"');
    const reportJson = createDesktopSupportReport(stateDir, "fresh-protected-failure").reportJson;
    const report = parseSupportReport(reportJson);
    expect(report.evidence.recordCount).toBeGreaterThan(0);
    expect(report.incident.incidentId).toBe(ids.at(-1));
    expect(analyzeSupportReport(reportJson).analysis.clusters.map((cluster) => cluster.op)).toEqual(
      expect.arrayContaining(["coding-runtime.readiness.failed"]),
    );
  }, 60_000);

  it("preserves foreign durable pins instead of claiming diagnostic pin pressure was recovered", () => {
    const nowMs = Date.now();
    for (let index = 0; index < MAX_ACTIVITY_LOG_PINS; index += 1) {
      expect(
        pinActivityLogWindow(stateDir, {
          scope: { kind: "window", fromMs: nowMs - 1, toMs: nowMs + 1 },
          expiresAtMs: nowMs + 60_000,
          reason: "durable-batch",
        }).status,
      ).toBe("pinned");
    }
    const before = listActivityLogDirectory(join(stateDir, "logs")).pins.map((pin) => pin.pinId);
    const candidate = recordUserReportedIncident(stateDir);
    expect(candidate.status).toBe("created");
    if (candidate.status !== "created") throw new Error("Expected diagnostic candidate");
    expect(candidate.record.pin.status).toBe("rejected");
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins.map((pin) => pin.pinId)).toEqual(
      before,
    );
  }, 60_000);
});
