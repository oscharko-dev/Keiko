// SupportIncident candidates (#3533): both triggers through the production entry points, the
// incident-window pin, deduplication, quotas, expiry, torn-record recovery, dismissal, and the
// body-free lifecycle lines as the real file sink persists them.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_OPERATION_SURFACES,
  SUPPORT_INCIDENT_DIRECTORY_NAME,
  activityLogOperationSchema,
  attachActivityLogEventRegistration,
  defectFingerprintPreimage,
  parseSupportIncidentRecord,
  supportIncidentFileName,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import {
  closeFileServerLogSinks,
  createFileServerLogSink,
  resetServerLogFailureNotices,
  type ServerLogEvent,
} from "./server-log.js";
import {
  MAX_REGISTERED_FAILURE_INCIDENTS,
  SUPPORT_INCIDENT_TTL_MS,
  SUPPORT_INCIDENT_WINDOW_AFTER_MS,
  SUPPORT_INCIDENT_WINDOW_BEFORE_MS,
  computeDefectFingerprint,
  MAX_SUPPORT_INCIDENT_EVALUATIONS_PER_MINUTE,
  dismissSupportIncident,
  drainSupportIncidentCandidates,
  listSupportIncidents,
  observeSupportIncidentTrigger,
  readSupportIncident,
  recordRegisteredFailureIncident,
  recordUserReportedIncident,
  setSupportIncidentTriggerForTests,
  supportIncidentEligibleOperation,
  type SupportIncidentCreation,
} from "./support-incident.js";

// A registered keiko-server failure operation with a supported failure class and a frames field.
const FAILURE_OP = "coding-runtime.readiness.failed";
const FRAMES = [
  "packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js:710:9",
  "packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js:640:3",
];

function failureEvent(overrides: Partial<ServerLogEvent> = {}): ServerLogEvent {
  const registration = activityLogOperationSchema(FAILURE_OP);
  if (registration === undefined) throw new Error("fixture operation is not registered");
  return attachActivityLogEventRegistration(
    {
      level: "error",
      category: "process",
      op: FAILURE_OP,
      correlationId: "failure-correlation-1",
      errorKind: "unavailable",
      extra: {
        phase: "endpoint",
        frames: FRAMES,
        causeChain: ["Error"],
        completeness: "complete",
        loss: "none",
      },
      ...overrides,
    },
    registration,
  );
}

function created(
  result: SupportIncidentCreation | undefined,
): Extract<SupportIncidentCreation, { readonly status: "created" }> {
  if (result?.status !== "created")
    throw new Error(`expected a created incident, got ${String(result?.status)}`);
  return result;
}

describe("SupportIncident candidates", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-support-incident-"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    setSupportIncidentTriggerForTests(undefined);
    closeFileServerLogSinks();
    resetServerLogFailureNotices();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function lines(op: string): readonly string[] {
    return persistedActivityLogLines(readPersistedActivityLog(stateDir), op);
  }

  function storeNames(): readonly string[] {
    return [...readdirSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME))].sort((left, right) =>
      left.localeCompare(right, "en-US"),
    );
  }

  describe("the user-initiated trigger", () => {
    it("works without any failure event: records, pins, and evidences the candidate", () => {
      const { record } = created(recordUserReportedIncident(stateDir));
      expect(record).toMatchObject({
        trigger: "user-report",
        state: "candidate",
        fingerprint: {
          surface: "unattributed",
          op: "unattributed",
          errorKind: "unknown",
          frameCount: 0,
        },
      });
      expect(record.pin.status).toBe("pinned");
      expect(record.window.toMs - record.window.incidentAtMs).toBe(
        SUPPORT_INCIDENT_WINDOW_AFTER_MS,
      );
      expect(record.window.incidentAtMs - record.window.fromMs).toBe(
        SUPPORT_INCIDENT_WINDOW_BEFORE_MS,
      );
      expect(record.expiresAtMs - record.createdAtMs).toBe(SUPPORT_INCIDENT_TTL_MS);
      expect(lines("activity-log.pin.created")).toHaveLength(1);
      const line = expectActivityLogProof(
        "support.incident.created.emitted-line",
        lines("support.incident.created")[0] ?? "",
      );
      expect(line).toMatchObject({
        incidentId: record.incidentId,
        defectFingerprint: record.fingerprint.defectFingerprint,
        trigger: "user-report",
        pinStatus: "pinned",
        correlationId: record.correlation.rootCorrelationId,
      });
    });

    it("persists an owner-private record that parses against the closed schema", () => {
      const { record } = created(recordUserReportedIncident(stateDir));
      const directory = join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME);
      const path = join(directory, supportIncidentFileName(record.incidentId));
      expect(parseSupportIncidentRecord(JSON.parse(readFileSync(path, "utf8")))).toEqual(record);
      if (process.platform !== "win32") {
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        expect(statSync(path).mode & 0o077).toBe(0);
      }
    });

    it("never merges two explicit reports and mints a fresh random id per occurrence", () => {
      const first = created(recordUserReportedIncident(stateDir)).record;
      const second = created(recordUserReportedIncident(stateDir)).record;
      expect(second.incidentId).not.toBe(first.incidentId);
      expect(second.fingerprint.defectFingerprint).toBe(first.fingerprint.defectFingerprint);
      expect(storeNames()).toHaveLength(2);
    });
  });

  describe("the registered-failure trigger", () => {
    it("derives eligibility from the registry, not from a caller list", () => {
      expect(supportIncidentEligibleOperation(FAILURE_OP)).toBe(true);
      expect(supportIncidentEligibleOperation("support.analyze.classified")).toBe(false);
      expect(supportIncidentEligibleOperation("support.incident.rejected")).toBe(false);
      expect(supportIncidentEligibleOperation("not.a.registered.operation")).toBe(false);
      expect(
        recordRegisteredFailureIncident(stateDir, { op: "support.analyze.classified" }),
      ).toBeUndefined();
    });

    it("fingerprints surface, op, closed errorKind, and the normalized frames", () => {
      const { record } = created(
        recordRegisteredFailureIncident(stateDir, {
          op: FAILURE_OP,
          errorKind: "unavailable",
          correlationId: "child-correlation-1",
          parentCorrelationId: "root-correlation-1",
          frames: FRAMES,
        }),
      );
      expect(record.fingerprint).toMatchObject({
        surface: ACTIVITY_LOG_OPERATION_SURFACES[FAILURE_OP],
        op: FAILURE_OP,
        errorKind: "unavailable",
        frameCount: 1,
      });
      expect(record.fingerprint.defectFingerprint).toBe(
        computeDefectFingerprint({
          surface: ACTIVITY_LOG_OPERATION_SURFACES[FAILURE_OP] ?? "unattributed",
          op: FAILURE_OP,
          errorKind: "unavailable",
          frames: FRAMES,
        }),
      );
      expect(record.correlation).toEqual({
        rootCorrelationId: "root-correlation-1",
        childCorrelationIds: ["child-correlation-1"],
      });
    });

    it("maps an open errorKind outside the closed vocabulary to unknown", () => {
      const { record } = created(
        recordRegisteredFailureIncident(stateDir, { op: FAILURE_OP, errorKind: "ECONNREFUSED" }),
      );
      expect(record.fingerprint.errorKind).toBe("unknown");
    });

    it("deduplicates a recurrence onto the open incident without pinning again", () => {
      const evidence = { op: FAILURE_OP, errorKind: "unavailable", frames: FRAMES };
      const first = created(recordRegisteredFailureIncident(stateDir, evidence)).record;
      const again = recordRegisteredFailureIncident(stateDir, {
        ...evidence,
        correlationId: "later-occurrence",
      });
      expect(again).toEqual({ status: "deduplicated", record: first });
      expect(storeNames()).toHaveLength(1);
      expect(lines("activity-log.pin.created")).toHaveLength(1);
      const line = expectActivityLogProof(
        "support.incident.deduplicated.emitted-line",
        lines("support.incident.deduplicated")[0] ?? "",
      );
      expect(line).toMatchObject({
        incidentId: first.incidentId,
        correlationId: "later-occurrence",
      });
    });

    it("keeps different defects apart", () => {
      created(
        recordRegisteredFailureIncident(stateDir, { op: FAILURE_OP, errorKind: "unavailable" }),
      );
      created(recordRegisteredFailureIncident(stateDir, { op: FAILURE_OP, errorKind: "timeout" }));
      expect(storeNames()).toHaveLength(2);
    });
  });

  describe("quotas", () => {
    function fillAutomaticQuota(): void {
      for (let index = 0; index < MAX_REGISTERED_FAILURE_INCIDENTS; index += 1) {
        created(
          recordRegisteredFailureIncident(stateDir, {
            op: FAILURE_OP,
            errorKind: "unavailable",
            frames: [`packages/keiko-server/dist/quota/m${String(index)}.js:1:1`],
          }),
        );
      }
    }

    it("rejects a new automatic candidate at the quota with body-free loss evidence", () => {
      fillAutomaticQuota();
      const rejected = recordRegisteredFailureIncident(stateDir, {
        op: FAILURE_OP,
        errorKind: "internal",
        correlationId: "over-quota-1",
      });
      expect(rejected).toEqual({ status: "rejected", reason: "quota-exhausted" });
      expect(storeNames()).toHaveLength(MAX_REGISTERED_FAILURE_INCIDENTS);
      const line = expectActivityLogProof(
        "support.incident.rejected.emitted-line",
        lines("support.incident.rejected")[0] ?? "",
      );
      expect(line).toMatchObject({
        rejectionReason: "quota-exhausted",
        trigger: "registered-failure",
        openIncidentCount: MAX_REGISTERED_FAILURE_INCIDENTS,
        completeness: "partial",
        loss: "event-dropped",
        errorKind: "rate-limited",
        correlationId: "over-quota-1",
      });
    }, 60_000);

    it("keeps a reserve so a failure flood never blocks an explicit report", () => {
      fillAutomaticQuota();
      expect(recordUserReportedIncident(stateDir).status).toBe("created");
    }, 60_000);
  });

  describe("expiry, recovery, and dismissal", () => {
    it("expires an unreported candidate predictably and says so", () => {
      const { record } = created(recordUserReportedIncident(stateDir));
      expect(listSupportIncidents(stateDir, { nowMs: record.expiresAtMs - 1 })).toEqual([record]);
      expect(listSupportIncidents(stateDir, { nowMs: record.expiresAtMs })).toEqual([]);
      expect(storeNames()).toEqual([]);
      const line = expectActivityLogProof(
        "support.incident.expired.emitted-line",
        lines("support.incident.expired")[0] ?? "",
      );
      expect(line).toMatchObject({
        incidentId: record.incidentId,
        expiryReason: "expired",
        removalStatus: "removed",
        defectFingerprint: record.fingerprint.defectFingerprint,
        openIncidentCount: 0,
      });
    });

    it("reads one open record by id and nothing else", () => {
      const { record } = created(recordUserReportedIncident(stateDir));
      expect(readSupportIncident(stateDir, record.incidentId)).toEqual(record);
      expect(readSupportIncident(stateDir, "0".repeat(32))).toBeUndefined();
      expect(readSupportIncident(stateDir, "../../escape")).toBeUndefined();
      expect(
        readSupportIncident(stateDir, record.incidentId, { nowMs: record.expiresAtMs }),
      ).toBeUndefined();
    });

    it("recovers a torn record left by a crash mid-write", () => {
      const directory = join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const tornId = "f".repeat(32);
      writeFileSync(join(directory, supportIncidentFileName(tornId)), '{"schemaVersion":1,"incid', {
        mode: 0o600,
      });
      writeFileSync(join(directory, "notes.txt"), "not a Keiko record", { mode: 0o600 });
      expect(listSupportIncidents(stateDir)).toEqual([]);
      expect(storeNames()).toEqual(["notes.txt"]);
      expect(
        persistedActivityLogLines(readPersistedActivityLog(stateDir), "support.incident.expired"),
      ).toHaveLength(1);
      expect(JSON.parse(lines("support.incident.expired")[0] ?? "{}")).toMatchObject({
        incidentId: tornId,
        expiryReason: "invalid-record",
        removalStatus: "removed",
      });
    });

    it("dismisses only on an explicit request and evidences it", () => {
      const { record } = created(recordUserReportedIncident(stateDir));
      expect(dismissSupportIncident(stateDir, "0".repeat(32))).toBe("not-found");
      expect(
        dismissSupportIncident(stateDir, record.incidentId, { correlationId: "dismiss-action-1" }),
      ).toBe("dismissed");
      expect(listSupportIncidents(stateDir)).toEqual([]);
      const line = expectActivityLogProof(
        "support.incident.dismissed.emitted-line",
        lines("support.incident.dismissed")[0] ?? "",
      );
      expect(line).toMatchObject({
        incidentId: record.incidentId,
        incidentState: "candidate",
        pinRelease: "released",
        openIncidentCount: 0,
        correlationId: "dismiss-action-1",
      });
      // The pin is released at once, so the window returns to ordinary retention.
      expect(JSON.parse(lines("activity-log.pin.expired")[0] ?? "{}")).toMatchObject({
        pinId: record.pin.pinId,
        expiryReason: "released",
        correlationId: "dismiss-action-1",
      });
    });

    it("rejects with store-unavailable evidence when the store cannot be created", () => {
      writeFileSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME), "occupied");
      expect(recordUserReportedIncident(stateDir, { correlationId: "blocked-store-1" })).toEqual({
        status: "rejected",
        reason: "store-unavailable",
      });
      expect(JSON.parse(lines("support.incident.rejected")[0] ?? "{}")).toMatchObject({
        rejectionReason: "store-unavailable",
        errorKind: "unavailable",
        correlationId: "blocked-store-1",
      });
    });
  });

  describe("the file-sink hook", () => {
    it("queues a persisted eligible failure and creates the candidate outside the write", async () => {
      setSupportIncidentTriggerForTests(true);
      createFileServerLogSink(stateDir).write(failureEvent());
      // Nothing happens inside the sink's own write: no pin, no seal, no store write.
      expect(lines("activity-log.pin.created")).toHaveLength(0);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const [incident] = listSupportIncidents(stateDir);
      expect(incident).toMatchObject({
        trigger: "registered-failure",
        fingerprint: { op: FAILURE_OP, errorKind: "unavailable", frameCount: 1 },
        correlation: { rootCorrelationId: "failure-correlation-1", childCorrelationIds: [] },
        pin: { status: "pinned" },
      });
      const ops = readPersistedActivityLog(stateDir)
        .split("\n")
        .filter((text) => text.length > 0)
        .map((text) => (JSON.parse(text) as { op: string }).op)
        .filter((op) =>
          [FAILURE_OP, "activity-log.pin.created", "support.incident.created"].includes(op),
        );
      expect(ops).toEqual([FAILURE_OP, "activity-log.pin.created", "support.incident.created"]);
    });

    it("ignores warn-level failures, and the whole trigger under the test-writer marker", () => {
      setSupportIncidentTriggerForTests(true);
      createFileServerLogSink(stateDir).write(failureEvent({ level: "warn" }));
      setSupportIncidentTriggerForTests(undefined);
      createFileServerLogSink(stateDir).write(failureEvent());
      drainSupportIncidentCandidates();
      expect(listSupportIncidents(stateDir)).toEqual([]);
    });

    it("suppresses a failure storm of one defect to a single evaluation", () => {
      setSupportIncidentTriggerForTests(true);
      const sink = createFileServerLogSink(stateDir);
      for (let index = 0; index < 5; index += 1) sink.write(failureEvent());
      drainSupportIncidentCandidates();
      expect(listSupportIncidents(stateDir)).toHaveLength(1);
      expect(lines("support.incident.deduplicated")).toHaveLength(0);
    });

    it("caps evaluations across distinct defects per rolling minute", () => {
      setSupportIncidentTriggerForTests(true);
      const sink = createFileServerLogSink(stateDir);
      for (let index = 0; index < MAX_SUPPORT_INCIDENT_EVALUATIONS_PER_MINUTE + 3; index += 1) {
        sink.write(
          failureEvent({
            extra: {
              phase: "endpoint",
              frames: [`packages/keiko-server/dist/storm/m${String(index)}.js:1:1`],
              causeChain: ["Error"],
              completeness: "complete",
              loss: "none",
            },
          }),
        );
      }
      drainSupportIncidentCandidates();
      expect(listSupportIncidents(stateDir)).toHaveLength(
        MAX_SUPPORT_INCIDENT_EVALUATIONS_PER_MINUTE,
      );
    });

    it("never throws into the sink when candidate creation fails", () => {
      setSupportIncidentTriggerForTests(true);
      writeFileSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME), "occupied");
      expect(() => {
        observeSupportIncidentTrigger(stateDir, failureEvent());
        drainSupportIncidentCandidates();
      }).not.toThrow();
      expect(JSON.parse(lines("support.incident.rejected")[0] ?? "{}")).toMatchObject({
        rejectionReason: "store-unavailable",
        correlationId: "failure-correlation-1",
      });
    });
  });

  it("keeps every identifier free of time, process, host, user, and path data", () => {
    const { record } = created(recordUserReportedIncident(stateDir));
    expect(record.incidentId).toMatch(/^[a-f0-9]{32}$/u);
    expect(record.fingerprint.defectFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      defectFingerprintPreimage({
        surface: "unattributed",
        op: "unattributed",
        errorKind: "unknown",
        frames: [],
      }),
    ).not.toMatch(new RegExp(`${String(process.pid)}|${stateDir.replaceAll("/", "\\/")}`, "u"));
  });
});
