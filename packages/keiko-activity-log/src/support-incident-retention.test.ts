import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import * as childProcesses from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
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
  completePreparedSupportIncident,
  readSupportIncident,
  dismissSupportIncident,
  drainSupportIncidentCandidates,
} from "./support-incident.js";

import { supportIncidentRetentionPolicy } from "./support-incident-retention.js";
import {
  ensureSupportIncidentDirectory,
  claimSupportIncidentSlot,
  listSupportIncidentClaims,
} from "./support-incident-store.js";
import {
  MAX_ACTIVITY_LOG_PINS,
  listActivityLogDirectory,
  readActivityLogPolicyRecord,
  readActivityLogPins,
  writeActivityLogPinRecord,
  writeActivityLogPolicyRecord,
} from "./activity-log-store.js";
import * as incidentStore from "./support-incident-store.js";
import * as serverLog from "./server-log.js";
import * as artifactFiles from "@oscharko-dev/keiko-security/fs-hardening";
import * as filesystem from "node:fs";
import { causeChain } from "./stack-frames.js";

import {
  attachActivityLogEventRegistration,
  activityLogOperationSchema,
  ACTIVITY_LOG_ERROR_KINDS,
  supportIncidentFileName,
  supportIncidentSlotClaimFileName,
  supportIncidentFingerprintClaimFileName,
  ACTIVITY_LOG_STORE_POLICY_FILE_NAME,
  SUPPORT_INCIDENT_TTL_MS,
  type SupportIncidentRecord,
  type SupportReportEvent,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  createDesktopSupportReport,
  createPreparedDesktopSupportReport,
  prepareManualSupportReportIncident,
} from "./reader/support-desktop-report.js";
import { parseSupportReport, analyzeSupportReport } from "./reader/support-report.js";

import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";

vi.mock("@oscharko-dev/keiko-security/fs-hardening", async (importOriginal) => {
  const actual = await importOriginal<typeof artifactFiles>();
  // Preserve the production error class identity: a class spy would make real primitive errors
  // fail the consumer's instanceof guard while only synthetic errors passed it.
  return { ...actual, removeSafeArtifactFile: vi.fn(actual.removeSafeArtifactFile) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>();
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    openSync: vi.fn(actual.openSync),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcesses>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const actualChildProcesses = await vi.importActual<typeof childProcesses>("node:child_process");
const actualArtifactFiles = await vi.importActual<typeof artifactFiles>(
  "@oscharko-dev/keiko-security/fs-hardening",
);
const actualFilesystem = await vi.importActual<typeof filesystem>("node:fs");
let stateDir: string;
beforeEach(() => {
  vi.mocked(filesystem.fsyncSync).mockImplementation(actualFilesystem.fsyncSync);
  vi.mocked(filesystem.openSync).mockImplementation(actualFilesystem.openSync);
  vi.mocked(childProcesses.spawnSync).mockImplementation(actualChildProcesses.spawnSync);
  vi.mocked(artifactFiles.removeSafeArtifactFile).mockImplementation(
    actualArtifactFiles.removeSafeArtifactFile,
  );
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

type RetirementFault = "inspection-open" | "start-write" | "pin-release";
function injectRetirementFault(stage: RetirementFault, failure: Error): void {
  if (stage === "inspection-open") {
    vi.spyOn(incidentStore, "readSupportIncidentRecord").mockImplementationOnce(() => {
      throw failure;
    });
    vi.spyOn(serverLog, "createFileServerLogSink").mockImplementationOnce(() => {
      throw new actualArtifactFiles.SafeArtifactFileError("activity-log", "open-failed");
    });
  } else if (stage === "start-write") {
    vi.spyOn(serverLog, "createFileServerLogSink").mockReturnValueOnce({
      write: (): void => {
        throw failure;
      },
    });
  } else {
    vi.spyOn(serverLog, "releaseActivityLogPin").mockImplementationOnce(() => {
      throw failure;
    });
  }
}

function occupyPublicationReserve(): readonly SupportIncidentRecord[] {
  vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
  const capacity = supportIncidentRetentionPolicy(stateDir).capacity;
  for (let index = 0; index < capacity; index += 1)
    expect(recordUserReportedIncident(stateDir).status).toBe("created");
  vi.spyOn(incidentStore, "removeSupportIncidentRecord").mockImplementationOnce(() => {
    throw new Error("simulated post-publication retirement failure");
  });
  expect(recordUserReportedIncident(stateDir).status).toBe("created");
  const retained = listSupportIncidents(stateDir, { readOnly: true });
  expect(retained).toHaveLength(capacity + 1);
  return retained;
}

function expectPeerRecoveryEvidence(result: ReturnType<typeof recordUserReportedIncident>): void {
  const text = readPersistedActivityLog(stateDir);
  if (result.status === "created") {
    expect(
      expectActivityLogProof(
        "support.incident.created.emitted-line",
        persistedActivityLogLines(text, "support.incident.created").at(-1) ?? "",
      ),
    ).toMatchObject({
      correlationId: "fresh-slot-retry",
      incidentId: result.incidentId,
      trigger: "user-report",
    });
  } else {
    expect(
      expectActivityLogProof(
        "support.incident.rejected.emitted-line",
        persistedActivityLogLines(text, "support.incident.rejected").at(-1) ?? "",
      ),
    ).toMatchObject({
      correlationId: "fresh-slot-retry",
      rejectionReason: "quota-exhausted",
      trigger: "user-report",
      errorKind: "rate-limited",
    });
  }
}

/** Fill unrelated pin stock without repeatedly creating and scanning unrelated incidents. */
function occupyDiagnosticPinReserve(): void {
  const owner = recordUserReportedIncident(stateDir, { correlationId: "pin-release-owner" });
  if (owner.status !== "created") throw new Error("Expected owned incident");
  const directory = join(stateDir, "logs");
  const pin = readActivityLogPins(listActivityLogDirectory(directory), directory)[0]?.record;
  if (pin === undefined) throw new Error("Expected produced pin");
  for (let index = 0; index < MAX_ACTIVITY_LOG_PINS - 2; index += 1) {
    writeActivityLogPinRecord(directory, directory, {
      ...pin,
      pinId: index.toString(16).padStart(24, "0"),
      reason: "durable-batch",
    });
  }
  expect(listActivityLogDirectory(directory).pins).toHaveLength(MAX_ACTIVITY_LOG_PINS - 1);
}

function expectLegacyRecoveryOwnership(
  prior: readonly SupportIncidentRecord[],
  created: SupportIncidentRecord,
): void {
  const expected = [...prior.slice(2), created];
  const actual = listSupportIncidents(stateDir, { readOnly: true });
  expect(actual.map((record) => record.incidentId).sort()).toEqual(
    expected.map((record) => record.incidentId).sort(),
  );
  expect(
    listSupportIncidentClaims(stateDir)
      .map((claim) => claim.incidentId)
      .sort(),
  ).toEqual(expected.map((record) => record.incidentId).sort());
  expect(
    listActivityLogDirectory(join(stateDir, "logs"))
      .pins.map((entry) => entry.pinId)
      .sort(),
  ).toEqual(expected.map((record) => record.pin.pinId).sort());
  const expired = persistedActivityLogLines(
    readPersistedActivityLog(stateDir),
    "support.incident.expired",
  );
  expect(expired).toHaveLength(2);
  expect(
    expired.map((line) => expectActivityLogProof("support.incident.expired.emitted-line", line)),
  ).toEqual(
    prior.slice(0, 2).map((record): unknown =>
      expect.objectContaining({
        incidentId: record.incidentId,
        expiryReason: "retention",
        removalStatus: "removed",
        claimsStatus: "released",
        pinRelease: "released",
        openIncidentCount: expected.length,
        completeness: "complete",
      }),
    ),
  );
}

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

function queuePublicationFailure(): void {
  const op = "coding-runtime.readiness.failed";
  const registration = activityLogOperationSchema(op);
  if (registration === undefined) throw new TypeError("Expected registered failure operation");
  createFileServerLogSink(stateDir).write(
    attachActivityLogEventRegistration(
      {
        level: "error",
        category: "process",
        op,
        correlationId: "failed-registered-publication",
        parentCorrelationId: "publication-parent",
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

function expectRejectedPublicationCleanup(
  reason: "record-too-large" | "store-unavailable",
  trigger: "user-report" | "registered-failure",
): void {
  expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual([]);
  expect(listSupportIncidentClaims(stateDir)).toEqual([]);
  expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([]);
  const text = readPersistedActivityLog(stateDir);
  const failures = persistedActivityLogLines(text, "support.incident.rejected");
  expect(failures).toHaveLength(1);
  expect(
    expectActivityLogProof("support.incident.rejected.emitted-line", failures[0] ?? ""),
  ).toMatchObject({
    rejectionReason: reason,
    trigger,
    correlationId:
      trigger === "user-report" ? "failed-manual-publication" : "failed-registered-publication",
    openIncidentCount: 0,
  });
  expect(text).not.toContain("private-publication-detail");
}

function expectRetirementStarted(
  text: string,
  incidentId: string,
  incidentState: "candidate" | "reported",
): void {
  const started = persistedActivityLogLines(text, "support.incident.retirement-started");
  expect(started).toHaveLength(1);
  expect(
    expectActivityLogProof("support.incident.retirement-started.emitted-line", started[0] ?? ""),
  ).toMatchObject({
    incidentId,
    incidentState,
    correlationId: "new-retirement-request",
    parentCorrelationId: "original-retirement",
  });
}

function expectEvictionReportReference(
  record: SupportIncidentRecord,
  field: "evictingIncidentId" | "evictedIncidentId",
  privateId: string,
): void {
  const response = createPreparedDesktopSupportReport(stateDir, record);
  const report = parseSupportReport(response.reportJson);
  expect(analyzeSupportReport(response.reportJson).analysis.evidence.classification).toBe(
    "supported",
  );
  const text = inflateSync(Buffer.from(report.evidence.payload, "base64")).toString("utf8");
  const events = JSON.parse(text) as readonly SupportReportEvent[];
  const referencing = events.find((event) => event.record[field] === report.incident.incidentId);
  expect(report.incident.incidentId).toBe(record.incidentId);
  expect(referencing).toBeDefined();
  expect(text).not.toContain(privateId);
  if (field === "evictingIncidentId")
    expect(referencing?.record.evictingCorrelationId).toBe(
      report.incident.correlation.rootCorrelationId,
    );
}

function expectRolledLifecycle(text: string): void {
  const rolled = expectActivityLogProof(
    "support.incident.expired.emitted-line",
    persistedActivityLogLines(text, "support.incident.expired").at(-1) ?? "",
  );
  expect(rolled).toMatchObject({
    correlationId: "retired-candidate",
    evictingCorrelationId: "fresh-candidate",
  });
  expect(rolled).not.toHaveProperty("parentCorrelationId");
}

function expectClosedRetirementReport(correlationId: string): void {
  const response = createDesktopSupportReport(stateDir, correlationId);
  const parsed = parseSupportReport(response.reportJson);
  const analyzed = analyzeSupportReport(response.reportJson);
  expect(analyzed.analysis.evidence.classification).toBe("supported");
  expect(analyzed.analysis.sufficiency.classes.flatMap((entry) => entry.reasons)).not.toContain(
    "lifecycle-start-missing",
  );
  // The canonical parser above validated this event array. Inspect event identities directly:
  // analyzer timelines also contain descendants and intentionally omit each line's own ID.
  const text = inflateSync(Buffer.from(parsed.evidence.payload, "base64")).toString("utf8");
  const events = JSON.parse(text) as readonly SupportReportEvent[];
  const started = events.find((event) => event.record.op === "support.incident.retirement-started");
  const dismissed = events.find((event) => event.record.op === "support.incident.dismissed");
  const pin = events.find((event) => event.record.op === "activity-log.pin.expired");
  expect(typeof started?.record.correlationId).toBe("string");
  expect(typeof pin?.record.correlationId).toBe("string");
  expect(started?.record.correlationId).not.toBe(pin?.record.correlationId);
  expect(started?.record.parentCorrelationId).toBe(pin?.record.correlationId);
  expect(dismissed?.record).toMatchObject({
    correlationId: started?.record.correlationId,
    parentCorrelationId: pin?.record.correlationId,
  });
  expect(text).not.toContain("original-retirement");
  expect(text).not.toContain("new-retirement-request");
}

describe("rolling diagnostic candidate retention", () => {
  it.each([
    ["list", "manual"],
    ["admission", "manual"],
    ["list", "registered"],
    ["admission", "registered"],
  ] as const)(
    "shortens an immutable historical 336h record and pin at 24h during %s for %s",
    (action, trigger) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const created =
        trigger === "manual"
          ? recordUserReportedIncident(stateDir, { correlationId: "historical-expiry" })
          : recordRegisteredFailureIncident(stateDir, {
              op: "coding-runtime.readiness.failed",
              errorKind: "unavailable",
              correlationId: "historical-expiry",
            });
      if (created?.status !== "created") throw new Error("Expected candidate");
      const legacy = {
        ...created.record,
        expiresAtMs: created.record.createdAtMs + 336 * 60 * 60_000,
      };
      const directory = incidentStore.supportIncidentDirectory(stateDir);
      const payload = incidentStore.serializeSupportIncidentRecord(legacy);
      if (payload === undefined) throw new Error("Expected historical record payload");
      incidentStore.removeSupportIncidentRecord(stateDir, created.incidentId);
      incidentStore.writeSupportIncidentRecord(directory, payload, legacy.incidentId);
      const logDirectory = join(stateDir, "logs");
      const pin = readActivityLogPins(listActivityLogDirectory(logDirectory), logDirectory)[0];
      if (pin?.record === undefined) throw new Error("Expected produced pin");
      rmSync(pin.entry.path);
      writeActivityLogPinRecord(logDirectory, logDirectory, {
        ...pin.record,
        expiresAtMs: legacy.expiresAtMs,
      });
      now.mockReturnValue(legacy.createdAtMs + 23 * 60 * 60_000);
      expect(readSupportIncident(stateDir, legacy.incidentId)).toEqual(legacy);
      expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([legacy]);
      expect(readFileSync(join(directory, supportIncidentFileName(legacy.incidentId)))).toEqual(
        payload,
      );
      now.mockReturnValue(legacy.createdAtMs + SUPPORT_INCIDENT_TTL_MS);
      expect(readSupportIncident(stateDir, legacy.incidentId)).toBeUndefined();
      if (action === "admission")
        expect(recordUserReportedIncident(stateDir).status).toBe("created");
      else expect(listSupportIncidents(stateDir)).toEqual([]);
      expect(
        listSupportIncidentClaims(stateDir).some((claim) => claim.incidentId === legacy.incidentId),
      ).toBe(false);
      expect(
        listActivityLogDirectory(logDirectory).pins.some(
          (entry) => entry.pinId === legacy.pin.pinId,
        ),
      ).toBe(false);
      expect(existsSync(join(directory, supportIncidentFileName(legacy.incidentId)))).toBe(false);
      const ended = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.expired",
      );
      expect(ended.map((line): unknown => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          correlationId: "historical-expiry",
          expiryReason: "ttl-shortened",
          removalStatus: "removed",
          pinRelease: "released",
          completeness: "complete",
        }),
      );
    },
  );

  it.each([336, 400])(
    "uses ordinary expiry once the original %sh deadline has also elapsed",
    (hours) => {
      const created = recordUserReportedIncident(stateDir, { correlationId: "late-legacy-expiry" });
      if (created.status !== "created") throw new TypeError("Expected retained candidate");
      const legacy = {
        ...created.record,
        expiresAtMs: created.record.createdAtMs + 336 * 60 * 60_000,
      };
      const payload = incidentStore.serializeSupportIncidentRecord(legacy);
      if (payload === undefined) throw new TypeError("Expected historical record payload");
      incidentStore.removeSupportIncidentRecord(stateDir, legacy.incidentId);
      incidentStore.writeSupportIncidentRecord(
        incidentStore.supportIncidentDirectory(stateDir),
        payload,
        legacy.incidentId,
      );
      expect(
        listSupportIncidents(stateDir, { nowMs: legacy.createdAtMs + hours * 60 * 60_000 }),
      ).toEqual([]);
      const expired = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.expired",
      );
      expect(expired).toHaveLength(1);
      expect(
        expectActivityLogProof("support.incident.expired.emitted-line", expired[0] ?? ""),
      ).toMatchObject({
        incidentId: legacy.incidentId,
        expiryReason: "expired",
        removalStatus: "removed",
      });
    },
  );

  it.each(["dismissal", "expiry"] as const)(
    "treats an already released owned pin as complete during %s",
    (action) => {
      const created = recordUserReportedIncident(stateDir, { correlationId: "peer-pin-owner" });
      if (created.status !== "created" || created.record.pin.pinId === undefined)
        throw new TypeError("Expected pinned candidate");
      expect(
        serverLog.releaseActivityLogPin(stateDir, {
          pinId: created.record.pin.pinId,
          correlationId: "peer-pin-release",
        }).status,
      ).toBe("released");
      if (action === "dismissal")
        expect(dismissSupportIncident(stateDir, created.incidentId)).toBe("dismissed");
      else
        expect(listSupportIncidents(stateDir, { nowMs: created.record.expiresAtMs + 1 })).toEqual(
          [],
        );
      const op = action === "dismissal" ? "support.incident.dismissed" : "support.incident.expired";
      const ended = persistedActivityLogLines(readPersistedActivityLog(stateDir), op);
      expect(ended).toHaveLength(1);
      expect(JSON.parse(ended[0] ?? "{}")).toMatchObject({
        incidentId: created.incidentId,
        pinRelease: "not-pinned",
        completeness: "complete",
      });
      expect(listSupportIncidentClaims(stateDir)).toEqual([]);
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual([]);
    },
  );

  it.each(["dismissal", "preparation"] as const)(
    "releases its pin and records partial %s after an unsafe owned slot claim",
    (action) => {
      const created = recordUserReportedIncident(stateDir, { correlationId: "unsafe-claim-owner" });
      if (created.status !== "created") throw new TypeError("Expected pinned candidate");
      const slot = join(
        incidentStore.supportIncidentDirectory(stateDir),
        supportIncidentSlotClaimFileName(created.record.slotIndex),
      );
      rmSync(slot);
      mkdirSync(slot);
      const retire =
        action === "dismissal" ? dismissSupportIncident : completePreparedSupportIncident;
      expect(retire(stateDir, created.incidentId, { correlationId: "unsafe-claim-retire" })).toBe(
        "dismissed-incomplete",
      );
      expect(lstatSync(slot).isDirectory()).toBe(true);
      expect(incidentStore.readSupportIncidentRecord(stateDir, created.incidentId)).toBeUndefined();
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual([]);
      const ended = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.dismissed",
      );
      expect(ended).toHaveLength(1);
      expect(JSON.parse(ended[0] ?? "{}")).toMatchObject({
        level: "warn",
        errorKind: "unsafe-target",
        failureKind: "unsafe-target",
        correlationId: "unsafe-claim-retire",
        parentCorrelationId: "unsafe-claim-owner",
        removalStatus: "removed",
        claimsStatus: "failed",
        incidentState: action === "dismissal" ? "candidate" : "reported",
        pinRelease: "released",
        completeness: "partial",
      });
    },
  );

  it("still releases its owned slot after fingerprint-claim cleanup fails", () => {
    const created = recordRegisteredFailureIncident(stateDir, {
      op: "coding-runtime.readiness.failed",
      errorKind: "unavailable",
      correlationId: "failed-fingerprint-cleanup",
    });
    if (created?.status !== "created") throw new TypeError("Expected registered failure candidate");
    const failure = new artifactFiles.SafeArtifactFileError("manifest", "permission-unsafe");
    vi.spyOn(incidentStore, "releaseSupportIncidentFingerprintClaim").mockImplementationOnce(() => {
      throw failure;
    });
    const slot = vi.spyOn(incidentStore, "releaseSupportIncidentSlot");
    const notice = vi.spyOn(serverLog, "reportServerLogFailure");
    expect(completePreparedSupportIncident(stateDir, created.incidentId)).toBe(
      "dismissed-incomplete",
    );
    expect(notice).toHaveBeenCalledWith(failure, {
      op: "support.incident.dismissed",
      correlationId: "failed-fingerprint-cleanup",
    });
    expect(slot).toHaveBeenCalledExactlyOnceWith(
      stateDir,
      created.record.slotIndex,
      created.incidentId,
    );
    expect(listSupportIncidentClaims(stateDir).map((claim) => claim.fileName)).not.toContain(
      supportIncidentSlotClaimFileName(created.record.slotIndex),
    );
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual([]);
    const ended = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.dismissed",
    );
    expect(JSON.parse(ended[0] ?? "{}")).toMatchObject({
      pinRelease: "released",
      completeness: "partial",
    });
  });

  it.each(["expired-record", "orphan-list", "orphan-remove"] as const)(
    "preserves the actual sweep request correlation on a %s cleanup failure",
    (stage) => {
      const created = recordUserReportedIncident(stateDir, { correlationId: "sweep-owner" });
      if (created.status !== "created") throw new TypeError("Expected sweep fixture candidate");
      const failure = new TypeError("private-sweep-failure-canary");
      const notice = vi.spyOn(serverLog, "reportServerLogFailure");
      if (stage === "expired-record") {
        vi.spyOn(incidentStore, "removeSupportIncidentRecord").mockImplementationOnce(() => {
          throw failure;
        });
      } else if (stage === "orphan-list") {
        vi.spyOn(incidentStore, "listSupportIncidentClaims").mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        incidentStore.removeSupportIncidentRecord(stateDir, created.incidentId);
        const claim = listSupportIncidentClaims(stateDir)[0];
        if (claim === undefined) throw new TypeError("Expected owned orphan claim");
        const abandoned = new Date(Date.now() - 60_000);
        utimesSync(
          join(incidentStore.supportIncidentDirectory(stateDir), claim.fileName),
          abandoned,
          abandoned,
        );
        vi.spyOn(incidentStore, "removeSupportIncidentClaimFile").mockImplementationOnce(() => {
          throw failure;
        });
      }
      listSupportIncidents(stateDir, {
        nowMs: created.record.expiresAtMs,
        correlationId: "actual-sweep-request",
      });
      expect(notice).toHaveBeenCalledWith(failure, {
        op: "support.incident.expired",
        correlationId: "actual-sweep-request",
      });
    },
  );

  it("retains both actual claim errors while releasing the owned pin", () => {
    const created = recordRegisteredFailureIncident(stateDir, {
      op: "coding-runtime.readiness.failed",
      errorKind: "unavailable",
      correlationId: "two-claim-cleanup-errors",
    });
    if (created?.status !== "created") throw new TypeError("Expected registered failure candidate");
    const fingerprintError = new artifactFiles.SafeArtifactFileError(
      "manifest",
      "permission-unsafe",
    );
    const slotError = new artifactFiles.SafeArtifactFileError("manifest", "unsafe-target");
    vi.spyOn(incidentStore, "releaseSupportIncidentFingerprintClaim").mockImplementationOnce(() => {
      throw fingerprintError;
    });
    vi.spyOn(incidentStore, "releaseSupportIncidentSlot").mockImplementationOnce(() => {
      throw slotError;
    });
    const notice = vi.spyOn(serverLog, "reportServerLogFailure");
    expect(completePreparedSupportIncident(stateDir, created.incidentId)).toBe(
      "dismissed-incomplete",
    );
    expect(notice.mock.calls[0]?.[0]).toBeInstanceOf(AggregateError);
    expect(notice.mock.calls[0]?.[0]).toMatchObject({
      errors: [fingerprintError, slotError],
      cause: slotError,
    });
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual([]);
  });

  it.each(["replacement", "symlink"] as const)(
    "never removes a %s replacing its own failed publication inode",
    (substitution) => {
      const original = recordUserReportedIncident(stateDir);
      if (original.status !== "created") throw new Error("Expected original candidate");
      const claims = listSupportIncidentClaims(stateDir);
      const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
      const sentinel = join(stateDir, "foreign-file.txt");
      writeFileSync(sentinel, "foreign file remains intact", { mode: 0o600 });
      let replacedPath: string | undefined;
      const publish = incidentStore.writeSupportIncidentRecord;
      vi.spyOn(incidentStore, "writeSupportIncidentRecord").mockImplementationOnce((...args) => {
        replacedPath = join(args[0], supportIncidentFileName(args[2]));
        vi.mocked(filesystem.fsyncSync).mockImplementationOnce(() => {
          if (replacedPath === undefined) throw new Error("Expected owned publication path");
          rmSync(replacedPath);
          if (substitution === "symlink") symlinkSync(sentinel, replacedPath);
          else writeFileSync(replacedPath, "peer replacement", { mode: 0o600 });
          throw new Error("simulated durability failure during substitution");
        });
        publish(...args);
      });
      expect(recordUserReportedIncident(stateDir)).toEqual({
        status: "rejected",
        reason: "store-unavailable",
      });
      if (replacedPath === undefined) throw new Error("Expected substituted path");
      expect(lstatSync(replacedPath).isSymbolicLink()).toBe(substitution === "symlink");
      expect(readFileSync(sentinel, "utf8")).toBe("foreign file remains intact");
      if (substitution === "replacement")
        expect(readFileSync(replacedPath, "utf8")).toBe("peer replacement");
      expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([original.record]);
      expect(listSupportIncidentClaims(stateDir)).toEqual(claims);
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);
    },
  );

  it.each(["removed", "refused"] as const)(
    "preserves the original durability error when owned cleanup is %s",
    (cleanup) => {
      const source = recordUserReportedIncident(stateDir);
      if (source.status !== "created") throw new Error("Expected producer fixture");
      const newId = "a".repeat(32);
      const payload = incidentStore.serializeSupportIncidentRecord({
        ...source.record,
        incidentId: newId,
      });
      if (payload === undefined) throw new Error("Expected producer payload");
      const publicationError = new Error("simulated fsync failure");
      const cleanupError = new artifactFiles.SafeArtifactFileError("manifest", "permission-unsafe");
      vi.mocked(filesystem.fsyncSync).mockImplementationOnce(() => {
        throw publicationError;
      });
      if (cleanup === "refused")
        vi.mocked(artifactFiles.removeSafeArtifactFile).mockImplementationOnce(() => {
          throw cleanupError;
        });
      expect(() => {
        incidentStore.writeSupportIncidentRecord(
          incidentStore.supportIncidentDirectory(stateDir),
          payload,
          newId,
        );
      }).toThrow(
        cleanup === "refused"
          ? expect.objectContaining({
              errors: [publicationError, cleanupError],
              cause: publicationError,
            })
          : publicationError,
      );
      const path = join(
        incidentStore.supportIncidentDirectory(stateDir),
        supportIncidentFileName(newId),
      );
      expect(existsSync(path)).toBe(cleanup === "refused");
      if (cleanup === "refused") expect(readFileSync(path)).toEqual(payload);
      expect(incidentStore.readSupportIncidentRecord(stateDir, source.incidentId)).toEqual(
        source.record,
      );
    },
  );

  it("keeps the durability failure in the real candidate's reduced cause chain after cleanup also fails", () => {
    const source = recordUserReportedIncident(stateDir);
    if (source.status !== "created") throw new Error("Expected retained producer fixture");
    const publicationError = new RangeError("private durability detail");
    const cleanupError = new artifactFiles.SafeArtifactFileError("manifest", "permission-unsafe");
    const actualWrite = incidentStore.writeSupportIncidentRecord;
    vi.spyOn(incidentStore, "writeSupportIncidentRecord").mockImplementationOnce((...args) => {
      vi.mocked(filesystem.fsyncSync).mockImplementationOnce(() => {
        throw publicationError;
      });
      vi.mocked(artifactFiles.removeSafeArtifactFile).mockImplementationOnce(() => {
        throw cleanupError;
      });
      actualWrite(...args);
    });
    const notice = vi.spyOn(serverLog, "reportServerLogFailure");
    expect(
      recordUserReportedIncident(stateDir, { correlationId: "failed-durable-candidate" }),
    ).toEqual({ status: "rejected", reason: "store-unavailable" });
    const failure = notice.mock.calls[0]?.[0];
    expect(failure).toMatchObject({
      errors: [publicationError, cleanupError],
      cause: publicationError,
    });
    expect(causeChain(failure)).toEqual(["RangeError"]);
    expect(incidentStore.readSupportIncidentRecord(stateDir, source.incidentId)).toEqual(
      source.record,
    );
    expect(readPersistedActivityLog(stateDir)).not.toContain("private durability detail");
  });

  it("preserves prior durable candidates and removes only its own new record after fsync fails", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    const capacity = supportIncidentRetentionPolicy(stateDir).capacity;
    for (let index = 0; index < capacity; index += 1)
      expect(recordUserReportedIncident(stateDir).status).toBe("created");
    const records = listSupportIncidents(stateDir, { readOnly: true });
    const claims = listSupportIncidentClaims(stateDir);
    const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
    const publish = incidentStore.writeSupportIncidentRecord;
    vi.spyOn(incidentStore, "writeSupportIncidentRecord").mockImplementationOnce((...args) => {
      vi.mocked(filesystem.fsyncSync).mockImplementationOnce(() => {
        throw new Error("simulated candidate durability failure");
      });
      publish(...args);
    });
    expect(recordUserReportedIncident(stateDir)).toEqual({
      status: "rejected",
      reason: "store-unavailable",
    });
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(records);
    expect(incidentStore.listSupportIncidentEntries(stateDir)).toHaveLength(records.length);
    expect(listSupportIncidentClaims(stateDir)).toEqual(claims);
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);
    expect(recordUserReportedIncident(stateDir).status).toBe("created");
    expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(capacity);
  });

  it.each(["bytes", "pins"] as const)(
    "preserves every prior candidate and pin after failed publication under %s pressure",
    (pressure) => {
      if (pressure === "bytes") vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
      const count =
        pressure === "bytes"
          ? supportIncidentRetentionPolicy(stateDir).capacity
          : MAX_ACTIVITY_LOG_PINS;
      for (let index = 0; index < count; index += 1) {
        expect(
          recordUserReportedIncident(stateDir, {
            correlationId: `prior-publication-${String(index)}`,
          }).status,
        ).toBe("created");
      }
      const records = listSupportIncidents(stateDir, { readOnly: true });
      const claims = listSupportIncidentClaims(stateDir);
      const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
      vi.spyOn(incidentStore, "writeSupportIncidentRecord").mockImplementationOnce(() => {
        throw new Error("simulated durable publication failure");
      });
      expect(recordUserReportedIncident(stateDir, { correlationId: "failed-replacement" })).toEqual(
        { status: "rejected", reason: "store-unavailable" },
      );
      expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(records);
      expect(listSupportIncidentClaims(stateDir)).toEqual(claims);
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);

      const recovered = recordUserReportedIncident(stateDir, { correlationId: "recovered-write" });
      expect(recovered.status).toBe("created");
      if (recovered.status !== "created") throw new Error("Expected recovered candidate");
      expect(recovered.record.pin.status).toBe("pinned");
      const retained = listSupportIncidents(stateDir, { readOnly: true });
      expect(retained).toHaveLength(records.length);
      expect(retained.map((record) => record.incidentId)).toContain(recovered.incidentId);
      expect(retained.map((record) => record.incidentId)).not.toContain(records[0]?.incidentId);
    },
    60_000,
  );

  it("does not steal a peer's in-flight publication reserve before either write is durable", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    const capacity = supportIncidentRetentionPolicy(stateDir).capacity;
    for (let index = 0; index < capacity; index += 1)
      expect(recordUserReportedIncident(stateDir).status).toBe("created");
    const original = listSupportIncidents(stateDir, { readOnly: true });
    const claims = listSupportIncidentClaims(stateDir);
    const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
    let peer: ReturnType<typeof recordUserReportedIncident> | undefined;
    vi.spyOn(incidentStore, "writeSupportIncidentRecord").mockImplementationOnce(() => {
      peer = recordUserReportedIncident(stateDir, { correlationId: "concurrent-publication" });
      throw new Error("simulated interrupted publication");
    });
    expect(recordUserReportedIncident(stateDir)).toEqual({
      status: "rejected",
      reason: "store-unavailable",
    });
    expect(peer).toEqual({ status: "rejected", reason: "quota-exhausted" });
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(original);
    expect(listSupportIncidentClaims(stateDir)).toEqual(claims);
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);
    expect(recordUserReportedIncident(stateDir).status).toBe("created");
    expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(capacity);
  });

  it("preserves prior evidence while another process competes for the publication reserve", () => {
    const peerStateDir = process.env.KEIKO_TEST_PUBLICATION_PEER_STATE;
    if (peerStateDir !== undefined) {
      expect(recordUserReportedIncident(peerStateDir)).toEqual({
        status: "rejected",
        reason: "quota-exhausted",
      });
      return;
    }
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    const capacity = supportIncidentRetentionPolicy(stateDir).capacity;
    for (let index = 0; index < capacity; index += 1)
      expect(recordUserReportedIncident(stateDir).status).toBe("created");
    const records = listSupportIncidents(stateDir, { readOnly: true });
    const claims = listSupportIncidentClaims(stateDir);
    const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
    vi.spyOn(incidentStore, "writeSupportIncidentRecord").mockImplementationOnce(() => {
      const peer = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json"))),
          "run",
          "--root",
          fileURLToPath(new URL("..", import.meta.url)),
          "src/support-incident-retention.test.ts",
          "-t",
          "another process competes",
          "--reporter=json",
        ],
        {
          env: { ...process.env, KEIKO_TEST_PUBLICATION_PEER_STATE: stateDir },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      expect(peer.error).toBeUndefined();
      expect(peer.status, peer.stdout + peer.stderr).toBe(0);
      expect(JSON.parse(peer.stdout)).toMatchObject({
        success: true,
        numPassedTests: 1,
        numFailedTests: 0,
      });
      throw new Error("simulated publication failure after concurrent admission");
    });
    expect(recordUserReportedIncident(stateDir)).toEqual({
      status: "rejected",
      reason: "store-unavailable",
    });
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(records);
    expect(listSupportIncidentClaims(stateDir)).toEqual(claims);
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);
    expect(recordUserReportedIncident(stateDir).status).toBe("created");
    expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(capacity);
  }, 60_000);

  it.each(["claim", "publication"] as const)(
    "records the exact displaced candidate when reserve recovery is followed by failed %s",
    (failureStage) => {
      const prior = occupyPublicationReserve();
      const victim = prior[0];
      if (victim === undefined) throw new TypeError("Expected a retained recovery victim");
      let replacementId: string | undefined;
      if (failureStage === "claim") {
        vi.spyOn(incidentStore, "claimSupportIncidentSlot").mockImplementationOnce(
          (_dir, _slot, id) => {
            replacementId = id;
            return false;
          },
        );
      } else {
        vi.spyOn(incidentStore, "writeSupportIncidentRecord").mockImplementationOnce(
          (_dir, _text, id) => {
            replacementId = id;
            throw new Error("simulated replacement publication failure");
          },
        );
      }
      expect(
        recordUserReportedIncident(stateDir, { correlationId: "failed-reserve-replacement" }),
      ).toEqual({
        status: "rejected",
        reason: failureStage === "claim" ? "quota-exhausted" : "store-unavailable",
      });
      expect(
        listSupportIncidents(stateDir, { readOnly: true }).map((record) => record.incidentId),
      ).toEqual(prior.slice(1).map((record) => record.incidentId));
      const text = readPersistedActivityLog(stateDir);
      const expired = expectActivityLogProof(
        "support.incident.expired.emitted-line",
        persistedActivityLogLines(text, "support.incident.expired").at(-1) ?? "",
      );
      expect(expired).toMatchObject({
        incidentId: victim.incidentId,
        correlationId: victim.correlation.rootCorrelationId,
        expiryReason: "retention",
        retentionCause: "slot-pressure",
        evictingCorrelationId: "failed-reserve-replacement",
        evictingIncidentId: replacementId,
        removalStatus: "removed",
        pinRelease: "released",
      });
      expect(
        expectActivityLogProof(
          "support.incident.rejected.emitted-line",
          persistedActivityLogLines(text, "support.incident.rejected").at(-1) ?? "",
        ),
      ).toMatchObject({
        correlationId: "failed-reserve-replacement",
        evictedIncidentId: victim.incidentId,
        openIncidentCount: prior.length - 1,
      });
      if (replacementId === undefined)
        throw new TypeError("Expected assigned replacement identity");
      expectEvictionReportReference(victim, "evictedIncidentId", replacementId);
    },
  );

  it("does not report an eviction when the occupied reserve victim cannot be removed", () => {
    const prior = occupyPublicationReserve();
    vi.spyOn(incidentStore, "removeSupportIncidentRecord").mockImplementationOnce(() => {
      throw new Error("simulated recovery victim refusal");
    });
    expect(
      recordUserReportedIncident(stateDir, { correlationId: "refused-victim-removal" }),
    ).toEqual({ status: "rejected", reason: "quota-exhausted" });
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(prior);
    const text = readPersistedActivityLog(stateDir);
    const rejected = expectActivityLogProof(
      "support.incident.rejected.emitted-line",
      persistedActivityLogLines(text, "support.incident.rejected").at(-1) ?? "",
    );
    expect(rejected).toMatchObject({
      correlationId: "refused-victim-removal",
      openIncidentCount: prior.length,
    });
    expect(rejected).not.toHaveProperty("evictedIncidentId");
    expect(
      expectActivityLogProof(
        "support.incident.expired.emitted-line",
        persistedActivityLogLines(text, "support.incident.expired").at(-1) ?? "",
      ),
    ).toMatchObject({
      removalStatus: "failed",
      retentionCause: "slot-pressure",
      completeness: "partial",
    });
  });

  it("recovers an occupied publication reserve after a durable replacement could not retire its predecessor", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    const capacity = supportIncidentRetentionPolicy(stateDir).capacity;
    for (let index = 0; index < capacity; index += 1)
      expect(recordUserReportedIncident(stateDir).status).toBe("created");
    const prior = listSupportIncidents(stateDir, { readOnly: true });
    vi.spyOn(incidentStore, "removeSupportIncidentRecord").mockImplementationOnce(() => {
      throw new Error("simulated post-publication retirement failure");
    });
    const published = recordUserReportedIncident(stateDir, {
      correlationId: "occupied-reserve-publication",
    });
    if (published.status !== "created") throw new TypeError("Expected durable replacement");
    expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(capacity + 1);
    const recovery = recordUserReportedIncident(stateDir, {
      correlationId: "occupied-reserve-recovery",
    });
    expect(recovery.status).toBe("created");
    if (recovery.status !== "created") throw new TypeError("Expected recovered admission");
    const retained = listSupportIncidents(stateDir, { readOnly: true });
    expect(retained).toHaveLength(capacity);
    expect(retained.map((record) => record.incidentId)).toEqual([
      ...prior.slice(2).map((record) => record.incidentId),
      published.incidentId,
      recovery.incidentId,
    ]);
    expect(listSupportIncidentClaims(stateDir)).toHaveLength(capacity);
    const expired = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.expired",
    ).map((line) => JSON.parse(line) as { completeness: string; pinRelease: string });
    expect(expired).toEqual([
      expect.objectContaining({ completeness: "partial" }),
      expect.objectContaining({ completeness: "complete", pinRelease: "released" }),
      expect.objectContaining({ completeness: "complete", pinRelease: "released" }),
    ]);
    expect(
      listActivityLogDirectory(join(stateDir, "logs"))
        .pins.map((pin) => pin.pinId)
        .sort(),
    ).toEqual(retained.map((record) => record.pin.pinId).sort());
  });

  it.each(["available", "reclaimed"] as const)(
    "rechecks a peer-freed slot that is %s before the exclusive recovery claim",
    (state) => {
      const retained = occupyPublicationReserve();
      const oldest = retained[0];
      if (oldest === undefined) throw new TypeError("Expected retained peer owner");
      const peerId = "e".repeat(32);
      const readNames = incidentStore.listSupportIncidentSlotIndexes;
      const claims = vi.spyOn(incidentStore, "claimSupportIncidentSlot");
      const listing = vi
        .spyOn(incidentStore, "listSupportIncidentSlotIndexes")
        .mockImplementationOnce((dir) => {
          const stale = readNames(dir);
          expect(
            dismissSupportIncident(dir, oldest.incidentId, { correlationId: "peer-slot-release" }),
          ).toBe("dismissed");
          return stale;
        })
        .mockImplementationOnce((dir) => {
          const refreshed = readNames(dir);
          if (state === "reclaimed")
            expect(claimSupportIncidentSlot(dir, oldest.slotIndex, peerId)).toBe(true);
          return refreshed;
        });
      const result = recordUserReportedIncident(stateDir, { correlationId: "fresh-slot-retry" });
      expect(result.status).toBe(state === "available" ? "created" : "rejected");
      expect(listing).toHaveBeenCalledTimes(state === "available" ? 3 : 2);
      if (result.status === "created") {
        expect(
          incidentStore.readSupportIncidentSlotClaim(stateDir, result.record.slotIndex),
        ).toMatchObject({
          incidentId: result.incidentId,
        });
        expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(
          retained.length - 1,
        );
      } else {
        expect(result.reason).toBe("quota-exhausted");
        expect(
          incidentStore.readSupportIncidentSlotClaim(stateDir, oldest.slotIndex),
        ).toMatchObject({
          incidentId: peerId,
        });
        expect(claims).toHaveNthReturnedWith(1, true);
        expect(claims).toHaveNthReturnedWith(2, false);
        expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(retained.slice(1));
      }
      expectPeerRecoveryEvidence(result);
    },
  );

  it("does not treat an unreadable retained record as a peer withdrawal after its claim vanishes", () => {
    const retained = occupyPublicationReserve();
    const oldest = retained[0];
    if (oldest === undefined) throw new TypeError("Expected retained peer owner");
    const target = join(
      incidentStore.supportIncidentDirectory(stateDir),
      supportIncidentFileName(oldest.incidentId),
    );
    const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
    const readNames = incidentStore.listSupportIncidentSlotIndexes;
    vi.spyOn(incidentStore, "listSupportIncidentSlotIndexes").mockImplementationOnce((dir) => {
      const stale = readNames(dir);
      incidentStore.releaseSupportIncidentSlot(dir, oldest.slotIndex, oldest.incidentId);
      writeFileSync(target, "");
      return stale;
    });
    expect(recordUserReportedIncident(stateDir)).toEqual({
      status: "rejected",
      reason: "quota-exhausted",
    });
    expect(lstatSync(target).size).toBe(0);
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(retained.slice(1));
  });

  it.each(["unpublished", "torn", "mismatched"] as const)(
    "never retires durable stock while the occupied reserve includes a %s peer claim",
    (fault) => {
      const retained = occupyPublicationReserve();
      const owner = retained[0];
      if (owner === undefined) throw new TypeError("Expected durable owner");
      const slot = join(
        incidentStore.supportIncidentDirectory(stateDir),
        supportIncidentSlotClaimFileName(owner.slotIndex),
      );
      if (fault === "unpublished")
        incidentStore.removeSupportIncidentRecord(stateDir, owner.incidentId);
      else writeFileSync(slot, fault === "torn" ? "" : "f".repeat(32));
      const records = listSupportIncidents(stateDir, { readOnly: true });
      const claims = listSupportIncidentClaims(stateDir);
      const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
      expect(recordUserReportedIncident(stateDir)).toEqual({
        status: "rejected",
        reason: "quota-exhausted",
      });
      expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(records);
      expect(listSupportIncidentClaims(stateDir)).toEqual(claims);
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);
    },
  );

  it("keeps a concurrently reclaimed slot owned by its new publisher during reserve recovery", () => {
    const retained = occupyPublicationReserve();
    const oldest = retained[0];
    if (oldest === undefined) throw new TypeError("Expected durable owner");
    const peerId = "d".repeat(32);
    const pin = pinActivityLogWindow(stateDir, {
      scope: { kind: "window", fromMs: oldest.window.fromMs, toMs: oldest.window.toMs },
      expiresAtMs: oldest.expiresAtMs,
      reason: "incident",
      correlationId: "reclaimed-slot-peer",
    });
    if (pin.status !== "pinned") throw new TypeError("Expected peer pin");
    const peer = {
      ...oldest,
      incidentId: peerId,
      pin: {
        status: "pinned" as const,
        pinId: pin.pinId,
        pinnedSegmentCount: pin.pinnedSegmentCount,
        pinnedBytes: pin.pinnedBytes,
        evidenceLostBeforePin: false,
      },
    };
    const remove = incidentStore.removeSupportIncidentRecord;
    vi.spyOn(incidentStore, "removeSupportIncidentRecord").mockImplementationOnce((dir, id) => {
      remove(dir, id);
      incidentStore.releaseSupportIncidentSlot(stateDir, oldest.slotIndex, oldest.incidentId);
      expect(claimSupportIncidentSlot(stateDir, oldest.slotIndex, peerId)).toBe(true);
      const payload = incidentStore.serializeSupportIncidentRecord(peer);
      if (payload === undefined) throw new TypeError("Expected peer record payload");
      incidentStore.writeSupportIncidentRecord(
        incidentStore.supportIncidentDirectory(stateDir),
        payload,
        peerId,
      );
    });
    expect(recordUserReportedIncident(stateDir)).toEqual({
      status: "rejected",
      reason: "quota-exhausted",
    });
    expect(incidentStore.readSupportIncidentRecord(stateDir, peerId)).toEqual(peer);
    expect(
      listActivityLogDirectory(join(stateDir, "logs")).pins.map((item) => item.pinId),
    ).toContain(pin.pinId);
    expect(listSupportIncidentClaims(stateDir)).toContainEqual(
      expect.objectContaining({
        incidentId: peerId,
        fileName: supportIncidentSlotClaimFileName(oldest.slotIndex),
      }),
    );
    expect(
      listSupportIncidents(stateDir, { readOnly: true }).map((record) => record.incidentId),
    ).toEqual(expect.arrayContaining(retained.slice(1).map((record) => record.incidentId)));
  });

  it.each(["replacement", "symlink"] as const)(
    "preserves a peer %s installed after opening the retirement target during reserve recovery",
    (substitution) => {
      const retained = occupyPublicationReserve();
      const oldest = retained[0];
      if (oldest === undefined) throw new TypeError("Expected durable owner");
      const target = join(
        incidentStore.supportIncidentDirectory(stateDir),
        supportIncidentFileName(oldest.incidentId),
      );
      const sentinel = join(stateDir, "active-peer-sentinel");
      writeFileSync(sentinel, "active peer sentinel", { mode: 0o600 });
      vi.mocked(artifactFiles.removeSafeArtifactFile).mockImplementationOnce(
        (path, options, shouldRemove) => {
          actualArtifactFiles.removeSafeArtifactFile(path, options, (descriptor): boolean => {
            if (shouldRemove !== undefined && !shouldRemove(descriptor)) return false;
            rmSync(target);
            if (substitution === "symlink") symlinkSync(sentinel, target);
            else writeFileSync(target, "active peer replacement", { mode: 0o600 });
            return true;
          });
        },
      );
      const claims = listSupportIncidentClaims(stateDir);
      const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
      expect(recordUserReportedIncident(stateDir)).toEqual({
        status: "rejected",
        reason: "quota-exhausted",
      });
      expect(readFileSync(sentinel, "utf8")).toBe("active peer sentinel");
      expect(lstatSync(target).isSymbolicLink()).toBe(substitution === "symlink");
      if (substitution === "replacement")
        expect(readFileSync(target, "utf8")).toBe("active peer replacement");
      expect(listSupportIncidentClaims(stateDir)).toEqual(claims);
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);
      const expired = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.expired",
      );
      expect(JSON.parse(expired.at(-1) ?? "{}")).toMatchObject({
        incidentId: oldest.incidentId,
        removalStatus: "failed",
        completeness: "partial",
      });
    },
  );

  it("recovers a fully occupied durable legacy byte pool without external release", () => {
    const smaller = supportIncidentRetentionPolicy(stateDir, {
      KEIKO_LOG_RETENTION_BYTES: "65536",
    });
    for (let index = 0; index <= smaller.capacity; index += 1)
      expect(recordUserReportedIncident(stateDir).status).toBe("created");
    // A prior producer used every slot in the pool. Preserve its actual descriptors and pins,
    // while placing their claims at those old closed indexes before the smaller policy is loaded.
    for (const [index, record] of listSupportIncidents(stateDir, { readOnly: true }).entries()) {
      incidentStore.removeSupportIncidentRecord(stateDir, record.incidentId);
      incidentStore.releaseSupportIncidentSlot(stateDir, record.slotIndex, record.incidentId);
      expect(claimSupportIncidentSlot(stateDir, index, record.incidentId)).toBe(true);
      const payload = incidentStore.serializeSupportIncidentRecord({ ...record, slotIndex: index });
      if (payload === undefined) throw new Error("Expected valid legacy record");
      incidentStore.writeSupportIncidentRecord(
        incidentStore.supportIncidentDirectory(stateDir),
        payload,
        record.incidentId,
      );
    }
    closeFileServerLogSinks();
    const directory = join(stateDir, "logs");
    const policy = readActivityLogPolicyRecord(directory, directory);
    if (policy === undefined) throw new Error("Expected governing policy");
    rmSync(join(directory, ACTIVITY_LOG_STORE_POLICY_FILE_NAME));
    writeActivityLogPolicyRecord(directory, directory, { ...policy, retentionBytes: 65536 });
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    const records = listSupportIncidents(stateDir, { readOnly: true });
    const created = recordUserReportedIncident(stateDir);
    if (created.status !== "created") throw new TypeError("Expected recovered legacy admission");
    expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(smaller.capacity);
    expectLegacyRecoveryOwnership(records, created.record);
  });

  it.each(["corrupt", "unsafe-permissions"] as const)(
    "refuses an alternate admission policy when the governing policy is %s",
    (fault) => {
      expect(recordUserReportedIncident(stateDir).status).toBe("created");
      closeFileServerLogSinks();
      const directory = join(stateDir, "logs");
      expect(readActivityLogPolicyRecord(directory, directory)).not.toBeUndefined();
      const path = join(directory, ACTIVITY_LOG_STORE_POLICY_FILE_NAME);
      if (fault === "corrupt") writeFileSync(path, "not a policy", { mode: 0o600 });
      else chmodSync(path, 0o644);
      expect(() =>
        supportIncidentRetentionPolicy(stateDir, { KEIKO_LOG_RETENTION_BYTES: "65536" }),
      ).toThrow(artifactFiles.SafeArtifactFileError);
      const retainedIds = listSupportIncidents(stateDir, { readOnly: true }).map(
        (record) => record.incidentId,
      );
      expect(recordUserReportedIncident(stateDir)).toEqual({
        status: "rejected",
        reason: "store-unavailable",
      });
      expect(
        listSupportIncidents(stateDir, { readOnly: true }).map((record) => record.incidentId),
      ).toEqual(retainedIds);
    },
  );

  it("does not sweep retained candidates when completing an unretained manual descriptor", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    ensureSupportIncidentDirectory(stateDir);
    const policy = supportIncidentRetentionPolicy(stateDir);
    for (let index = 0; index < policy.capacity; index += 1) {
      expect(claimSupportIncidentSlot(stateDir, index, "a".repeat(32))).toBe(true);
    }
    const descriptor = prepareManualSupportReportIncident(stateDir, "transient-manual-report");
    expect(descriptor).not.toHaveProperty("slotIndex");
    const claims = listSupportIncidentClaims(stateDir);
    const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
    const listing = vi.spyOn(incidentStore, "listSupportIncidentEntries");

    expect(completePreparedSupportIncident(stateDir, descriptor.incidentId)).toBe("not-found");
    expect(listing).not.toHaveBeenCalled();
    expect(listSupportIncidentClaims(stateDir)).toEqual(claims);
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);
  });

  it("does not retain a published pin when a manual candidate write fails", () => {
    vi.spyOn(incidentStore, "writeSupportIncidentRecord").mockImplementation(() => {
      throw new Error("simulated candidate publication failure");
    });
    expect(
      recordUserReportedIncident(stateDir, { correlationId: "failed-manual-publication" }),
    ).toEqual({ status: "rejected", reason: "store-unavailable" });
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual([]);
    expect(listSupportIncidentClaims(stateDir)).toEqual([]);
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([]);
  });

  it.each(["user-report", "registered-failure"] as const)(
    "releases the newly published pin after a %s record exceeds the byte limit",
    (trigger) => {
      const serialize = vi.spyOn(incidentStore, "serializeSupportIncidentRecord");
      serialize.mockImplementationOnce((record) => {
        expect(record.pin.status).toBe("pinned");
        expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toHaveLength(1);
        return undefined;
      });
      const result =
        trigger === "user-report"
          ? recordUserReportedIncident(stateDir, { correlationId: "failed-manual-publication" })
          : recordRegisteredFailureIncident(stateDir, {
              op: "coding-runtime.readiness.failed",
              errorKind: "unavailable",
              correlationId: "failed-registered-publication",
              parentCorrelationId: "publication-parent",
            });
      expect(result).toEqual({ status: "rejected", reason: "record-too-large" });
      expect(serialize).toHaveBeenCalledOnce();
      expectRejectedPublicationCleanup("record-too-large", trigger);
    },
  );

  it.each(["record-too-large", "store-unavailable"] as const)(
    "releases the actual retry pin when queued registered publication fails with %s",
    (reason) => {
      setSupportIncidentTriggerForTests(true);
      const pin = vi.spyOn(serverLog, "pinActivityLogWindow").mockReturnValueOnce({
        status: "rejected",
        reason: "storage-unavailable",
      });
      if (reason === "record-too-large")
        vi.spyOn(incidentStore, "serializeSupportIncidentRecord").mockReturnValueOnce(undefined);
      else
        vi.spyOn(incidentStore, "writeSupportIncidentRecord").mockImplementationOnce(() => {
          throw new RangeError("private-publication-detail");
        });
      queuePublicationFailure();
      expect(pin).toHaveBeenCalledOnce();
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual([]);
      drainSupportIncidentCandidates();
      expect(pin).toHaveBeenCalledTimes(2);
      expect(pin.mock.results[1]).toMatchObject({ type: "return", value: { status: "pinned" } });
      expectRejectedPublicationCleanup(reason, "registered-failure");
      const text = readPersistedActivityLog(stateDir);
      const releases = persistedActivityLogLines(text, "activity-log.pin.expired");
      expect(releases).toHaveLength(1);
      expect(
        expectActivityLogProof("activity-log.pin.expired.emitted-line", releases[0] ?? ""),
      ).toMatchObject({
        correlationId: "failed-registered-publication",
        expiryReason: "released",
      });
      const source = persistedActivityLogLines(text, "coding-runtime.readiness.failed");
      expect(source).toHaveLength(1);
      expect(JSON.parse(source[0] ?? "")).toMatchObject({
        correlationId: "failed-registered-publication",
        parentCorrelationId: "publication-parent",
      });
    },
  );

  it.each(["record", "slot"] as const)(
    "finishes expiry when a peer removes the %s leaf immediately before the guarded open",
    (kind) => {
      const created = recordUserReportedIncident(stateDir, { correlationId: "peer-expiry-owner" });
      if (created.status !== "created") throw new Error("Expected candidate");
      const target = join(
        incidentStore.supportIncidentDirectory(stateDir),
        kind === "record"
          ? supportIncidentFileName(created.incidentId)
          : supportIncidentSlotClaimFileName(created.record.slotIndex),
      );
      const originalRemove = actualArtifactFiles.removeSafeArtifactFile;
      vi.spyOn(artifactFiles, "removeSafeArtifactFile").mockImplementation((path, ...args) => {
        if (path === target && existsSync(target)) rmSync(target);
        originalRemove(path, ...args);
      });
      expect(listSupportIncidents(stateDir, { nowMs: created.record.expiresAtMs + 1 })).toEqual([]);
      expect(listSupportIncidentClaims(stateDir)).toEqual([]);
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual([]);
      const ended = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.expired",
      );
      expect(ended.map((line): unknown => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          correlationId: "peer-expiry-owner",
          removalStatus: "removed",
          pinRelease: "released",
        }),
      );
    },
  );

  it.each(["record", "slot", "fingerprint"] as const)(
    "finishes expiry when a peer unlinks the %s leaf after the guarded descriptor opens",
    (kind) => {
      const created = recordRegisteredFailureIncident(stateDir, {
        op: "coding-runtime.readiness.failed",
        errorKind: "unavailable",
        correlationId: "opened-peer-expiry",
      });
      if (created?.status !== "created") throw new Error("Expected candidate");
      const names = {
        record: supportIncidentFileName(created.incidentId),
        slot: supportIncidentSlotClaimFileName(created.record.slotIndex),
        fingerprint: supportIncidentFingerprintClaimFileName(
          created.record.fingerprint.defectFingerprint,
        ),
      };
      const target = join(incidentStore.supportIncidentDirectory(stateDir), names[kind]);
      const expectedOpens = kind === "record" ? 2 : 1;
      let targetOpens = 0;
      vi.mocked(filesystem.openSync).mockImplementation((path, flags, mode) => {
        const descriptor = actualFilesystem.openSync(path, flags, mode);
        if (path === target && ++targetOpens === expectedOpens) rmSync(target);
        return descriptor;
      });
      expect(listSupportIncidents(stateDir, { nowMs: created.record.expiresAtMs + 1 })).toEqual([]);
      expect(targetOpens).toBe(expectedOpens);
      expect(listSupportIncidentClaims(stateDir)).toEqual([]);
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual([]);
      const ended = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.expired",
      );
      expect(ended.map((line): unknown => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          correlationId: "opened-peer-expiry",
          removalStatus: "removed",
          pinRelease: "released",
          completeness: "complete",
        }),
      );
    },
  );

  it("finishes expiry when a peer unlinks the record before the guarded helper mutation", () => {
    const created = recordUserReportedIncident(stateDir, { correlationId: "helper-peer-expiry" });
    if (created.status !== "created") throw new Error("Expected candidate");
    const target = join(
      incidentStore.supportIncidentDirectory(stateDir),
      supportIncidentFileName(created.incidentId),
    );
    let peerRemoved = false;
    vi.mocked(childProcesses.spawnSync).mockImplementation((command, args, options) => {
      if (args?.[0]?.endsWith("safe-artifact-directory-mutation.js") && !peerRemoved) {
        rmSync(target);
        peerRemoved = true;
      }
      return actualChildProcesses.spawnSync(command, args, options);
    });
    expect(listSupportIncidents(stateDir, { nowMs: created.record.expiresAtMs + 1 })).toEqual([]);
    expect(peerRemoved).toBe(true);
    expect(listSupportIncidentClaims(stateDir)).toEqual([]);
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual([]);
    const ended = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.expired",
    );
    expect(ended.map((line): unknown => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        correlationId: "helper-peer-expiry",
        removalStatus: "removed",
        pinRelease: "released",
        completeness: "complete",
      }),
    );
  });

  it.each(["read", "sweep"] as const)(
    "records a failed retirement %s before removal without losing ownership",
    (stage) => {
      const created = recordUserReportedIncident(stateDir, {
        correlationId: "original-retirement",
      });
      if (created.status !== "created") throw new TypeError("Expected manual candidate");
      const claims = listSupportIncidentClaims(stateDir);
      const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
      const error = new TypeError("private customer contents must not leave this process", {
        cause: new RangeError("private cause"),
      });
      error.stack =
        "TypeError: private contents\n    at retire (/private/work/packages/keiko-activity-log/dist/support-incident.js:20:4)";
      const method = stage === "read" ? "readSupportIncidentRecord" : "listSupportIncidentEntries";
      vi.spyOn(incidentStore, method).mockImplementationOnce(() => {
        throw error;
      });
      expect(
        dismissSupportIncident(stateDir, created.incidentId, {
          correlationId: "cancelled-retirement",
          retirementReason: "abandoned",
        }),
      ).toBe("failed");
      expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([created.record]);
      expect(listSupportIncidentClaims(stateDir)).toEqual(claims);
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);
      const lines = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.retirement-failed",
      );
      expect(lines).toHaveLength(1);
      const line = expectActivityLogProof(
        "support.incident.retirement-failed.emitted-line",
        lines[0] ?? "",
      );
      expect(line).toMatchObject({
        incidentId: created.incidentId,
        correlationId: "cancelled-retirement",
        failureStage: stage,
        reason: "abandoned",
        errorKind: "internal",
        failureKind: "TypeError",
        completeness: "partial",
        loss: "none",
        frames: ["packages/keiko-activity-log/dist/support-incident.js:20:4"],
        causeChain: ["RangeError"],
      });
      expect(line).not.toHaveProperty("openIncidentCount");
      expect(lines[0]).not.toContain("private customer");
    },
  );

  it.each(["inspection-open", "start-write", "pin-release"] as const)(
    "contains a retirement %s failure on the independent diagnostic fallback",
    (stage) => {
      const created = recordUserReportedIncident(stateDir, { correlationId: "fallback-owner" });
      if (created.status !== "created") throw new TypeError("Expected manual candidate");
      const failure = new TypeError("private retirement failure");
      failure.stack =
        "TypeError: private contents\n    at retire (/private/work/packages/keiko-activity-log/dist/support-incident.js:20:4)";
      injectRetirementFault(stage, failure);
      const stderr = vi.spyOn(process.stderr, "write");
      expect(
        completePreparedSupportIncident(stateDir, created.incidentId, {
          correlationId: "fallback-retirement",
        }),
      ).toBe("failed");
      const notices = stderr.mock.calls.flatMap(([value]) =>
        typeof value === "string" && value.startsWith("{")
          ? [JSON.parse(value) as Record<string, unknown>]
          : [],
      );
      expect(notices).toContainEqual(
        expect.objectContaining({
          op: "server-log.write-failed",
          correlationId: "fallback-retirement",
          errorKind: "internal",
          completeness: "unknown",
          loss: "event-dropped",
          frames: ["packages/keiko-activity-log/dist/support-incident.js:20:4"],
        }),
      );
      expect(JSON.stringify(notices)).not.toContain("private");
      expect(incidentStore.readSupportIncidentRecord(stateDir, created.incidentId)).toEqual(
        stage === "pin-release" ? undefined : created.record,
      );
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toHaveLength(1);
    },
  );

  it.each([64, 65, 128, 129])(
    "persists retirement failure evidence for a %i-character machine code",
    (length) => {
      const created = recordUserReportedIncident(stateDir, { correlationId: "bounded-code-owner" });
      if (created.status !== "created") throw new TypeError("Expected manual candidate");
      const code = "E".repeat(length);
      const failure = Object.assign(
        new TypeError("private retirement contents", {
          cause: new RangeError("private cause"),
        }),
        { code },
      );
      failure.stack =
        "TypeError: private contents\n    at retire (/private/work/packages/keiko-activity-log/dist/support-incident.js:20:4)";
      vi.spyOn(incidentStore, "readSupportIncidentRecord").mockImplementationOnce(() => {
        throw failure;
      });
      expect(
        dismissSupportIncident(stateDir, created.incidentId, {
          correlationId: "bounded-code-retirement",
        }),
      ).toBe("failed");
      const lines = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.retirement-failed",
      );
      expect(lines).toHaveLength(1);
      const line = expectActivityLogProof(
        "support.incident.retirement-failed.emitted-line",
        lines[0] ?? "",
      );
      expect(line).toMatchObject({
        incidentId: created.incidentId,
        correlationId: "bounded-code-retirement",
        failureStage: "read",
        errorKind: "internal",
        failureKind: length === 64 ? code : "TypeError",
        completeness: "partial",
        loss: "none",
        frames: ["packages/keiko-activity-log/dist/support-incident.js:20:4"],
        causeChain: ["RangeError"],
      });
      expect(lines[0]).not.toContain("private");
      if (length > 64) expect(lines[0]).not.toContain(code);
      expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([created.record]);
    },
  );

  it("preserves reported state and the actual failure when prepared removal fails", () => {
    const created = recordUserReportedIncident(stateDir, {
      correlationId: "prepared-removal-source",
    });
    if (created.status !== "created") throw new TypeError("Expected candidate");
    const failure = new TypeError("private deletion failure", {
      cause: new RangeError("private cause"),
    });
    failure.stack =
      "TypeError: private deletion failure\n    at retire (/private/customer/packages/keiko-activity-log/dist/support-incident.js:40:5)";
    vi.spyOn(incidentStore, "removeSupportIncidentRecord").mockImplementationOnce(() => {
      throw failure;
    });
    expect(
      completePreparedSupportIncident(stateDir, created.incidentId, {
        correlationId: "prepared-removal-attempt",
      }),
    ).toBe("failed");
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.dismissed",
    );
    expect(
      expectActivityLogProof("support.incident.dismissed.emitted-line", lines[0] ?? ""),
    ).toMatchObject({
      level: "warn",
      errorKind: "internal",
      failureKind: "TypeError",
      correlationId: "prepared-removal-attempt",
      parentCorrelationId: "prepared-removal-source",
      incidentState: "reported",
      removalStatus: "failed",
      claimsStatus: "not-attempted",
      pinRelease: "not-attempted",
      completeness: "partial",
      causeChain: ["RangeError"],
      frames: ["packages/keiko-activity-log/dist/support-incident.js:40:5"],
    });
    const started = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.retirement-started",
    );
    expect(JSON.parse(started[0] ?? "{}")).toMatchObject({
      correlationId: "prepared-removal-attempt",
      parentCorrelationId: "prepared-removal-source",
      incidentState: "reported",
    });
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([created.record]);
    expect(lines[0]).not.toContain("private");
  });

  it("never labels a prepared completion abandoned even with a structurally wider options object", () => {
    const created = recordUserReportedIncident(stateDir, {
      correlationId: "completion-reason-source",
    });
    if (created.status !== "created") throw new TypeError("Expected candidate");
    const options = {
      correlationId: "completion-reason-attempt",
      retirementReason: "abandoned" as const,
    };
    expect(completePreparedSupportIncident(stateDir, created.incidentId, options)).toBe(
      "dismissed",
    );
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.dismissed",
    );
    const line = expectActivityLogProof("support.incident.dismissed.emitted-line", lines[0] ?? "");
    expect(line).toMatchObject({
      incidentState: "reported",
      removalStatus: "removed",
      claimsStatus: "released",
    });
    expect(line).not.toHaveProperty("reason");
  });

  it("records failed abandoned withdrawal without claiming removal or touching the owned pin", () => {
    const created = recordUserReportedIncident(stateDir, {
      correlationId: "abandoned-owned-cause",
    });
    if (created.status !== "created") throw new Error("Expected real manual candidate");
    const claims = listSupportIncidentClaims(stateDir);
    const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
    vi.spyOn(incidentStore, "removeSupportIncidentRecord").mockImplementationOnce(() => {
      throw new artifactFiles.SafeArtifactFileError("manifest", "permission-unsafe");
    });
    expect(
      dismissSupportIncident(stateDir, created.incidentId, {
        correlationId: "cancelled-report-withdrawal",
        retirementReason: "abandoned",
      }),
    ).toBe("failed");
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([created.record]);
    expect(listSupportIncidentClaims(stateDir)).toEqual(claims);
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.dismissed",
    );
    expect(lines).toHaveLength(1);
    expect(
      expectActivityLogProof("support.incident.dismissed.emitted-line", lines[0] ?? ""),
    ).toMatchObject({
      correlationId: "cancelled-report-withdrawal",
      reason: "abandoned",
      removalStatus: "failed",
      pinRelease: "not-attempted",
      completeness: "partial",
    });
  });

  it("releases its owned pin and records partial expiry after a genuine claim-release failure", () => {
    const created = recordUserReportedIncident(stateDir, {
      correlationId: "claim-release-failure",
    });
    if (created.status !== "created") throw new Error("Expected candidate");
    vi.spyOn(incidentStore, "releaseSupportIncidentSlot").mockImplementationOnce(() => {
      throw new artifactFiles.SafeArtifactFileError("manifest", "permission-unsafe");
    });
    expect(listSupportIncidents(stateDir, { nowMs: created.record.expiresAtMs + 1 })).toEqual([]);
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual([]);
    const ended = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.expired",
    );
    expect(ended.map((line): unknown => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        correlationId: "claim-release-failure",
        level: "warn",
        errorKind: "internal",
        failureKind: "permission-unsafe",
        claimsStatus: "failed",
        removalStatus: "removed",
        pinRelease: "released",
        completeness: "partial",
      }),
    );
  });

  it.each(["open-failed", "permission-unsafe"] as const)(
    "preserves a present record after a genuine %s guarded removal failure",
    (kind) => {
      const created = recordUserReportedIncident(stateDir, { correlationId: "guarded-removal" });
      if (created.status !== "created") throw new Error("Expected candidate");
      const failure = new artifactFiles.SafeArtifactFileError("manifest", kind);
      vi.spyOn(artifactFiles, "removeSafeArtifactFile").mockImplementationOnce(() => {
        throw failure;
      });
      expect(() => {
        incidentStore.removeSupportIncidentRecord(stateDir, created.incidentId);
      }).toThrow(failure);
      expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(1);
      expect(listSupportIncidentClaims(stateDir)).not.toEqual([]);
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toHaveLength(1);
    },
  );

  it.each(["replacement", "symlink"] as const)(
    "refuses peer absence beneath a %s trusted directory",
    (kind) => {
      const created = recordUserReportedIncident(stateDir);
      if (created.status !== "created") throw new Error("Expected candidate");
      const directory = incidentStore.supportIncidentDirectory(stateDir);
      const originalDirectory = join(stateDir, "original-incident-directory");
      vi.mocked(artifactFiles.removeSafeArtifactFile).mockImplementationOnce((path, ...args) => {
        renameSync(directory, originalDirectory);
        if (kind === "replacement") mkdirSync(directory, { mode: 0o700 });
        else symlinkSync(originalDirectory, directory);
        actualArtifactFiles.removeSafeArtifactFile(path, ...args);
      });
      expect(() => {
        incidentStore.removeSupportIncidentRecord(stateDir, created.incidentId);
      }).toThrow();
      expect(existsSync(join(originalDirectory, supportIncidentFileName(created.incidentId)))).toBe(
        true,
      );
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toHaveLength(1);
    },
  );

  it.each(["permission-unsafe", "read-failed"] as const)(
    "preserves a genuine %s error even when its record leaf subsequently disappears",
    (kind) => {
      const created = recordUserReportedIncident(stateDir);
      if (created.status !== "created") throw new Error("Expected candidate");
      const target = join(
        incidentStore.supportIncidentDirectory(stateDir),
        supportIncidentFileName(created.incidentId),
      );
      const failure = new artifactFiles.SafeArtifactFileError("manifest", kind);
      vi.mocked(artifactFiles.removeSafeArtifactFile).mockImplementationOnce(() => {
        rmSync(target);
        throw failure;
      });
      expect(() => {
        incidentStore.removeSupportIncidentRecord(stateDir, created.incidentId);
      }).toThrow(failure);
      expect(listSupportIncidentClaims(stateDir)).not.toEqual([]);
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toHaveLength(1);
    },
  );

  it("does not treat a missing trusted directory as an idempotent leaf removal", () => {
    const created = recordUserReportedIncident(stateDir, { correlationId: "missing-store-root" });
    if (created.status !== "created") throw new Error("Expected candidate");
    rmSync(incidentStore.supportIncidentDirectory(stateDir), { recursive: true });
    expect(() => {
      incidentStore.removeSupportIncidentRecord(stateDir, created.incidentId);
    }).toThrow();
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toHaveLength(1);
  });

  it("does not retire live evidence for expired pins arriving after publication", () => {
    const original = recordUserReportedIncident(stateDir, { correlationId: "live-pin-owner" });
    if (original.status !== "created") throw new Error("Expected original incident");
    const directory = join(stateDir, "logs");
    const pin = readActivityLogPins(listActivityLogDirectory(directory), directory)[0]?.record;
    if (pin === undefined) throw new Error("Expected produced pin");
    const writeRecord = incidentStore.writeSupportIncidentRecord;
    vi.spyOn(incidentStore, "writeSupportIncidentRecord").mockImplementationOnce((...args) => {
      writeRecord(...args);
      for (let index = 0; index < MAX_ACTIVITY_LOG_PINS - 2; index += 1) {
        writeActivityLogPinRecord(directory, directory, {
          ...pin,
          pinId: index.toString(16).padStart(24, "0"),
          createdAtMs: original.record.createdAtMs - 10_000,
          expiresAtMs: original.record.createdAtMs - 1,
        });
      }
    });
    const next = recordUserReportedIncident(stateDir, { correlationId: "next-live-pin-owner" });
    if (next.status !== "created") throw new Error("Expected next incident");
    expect(next.record.pin.status).toBe("pinned");
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual([
      original.record,
      next.record,
    ]);
    expect(listActivityLogDirectory(directory).pins).toHaveLength(MAX_ACTIVITY_LOG_PINS);
    expect(
      persistedActivityLogLines(readPersistedActivityLog(stateDir), "support.incident.expired"),
    ).toEqual([]);
  });

  it("names the actual new publisher when only the diagnostic pin ceiling retires an old candidate", () => {
    occupyDiagnosticPinReserve();
    const prior = listSupportIncidents(stateDir, { readOnly: true });
    const victim = prior[0];
    if (victim === undefined) throw new TypeError("Expected an owned pin candidate");
    const next = recordUserReportedIncident(stateDir, { correlationId: "pin-ceiling-replacement" });
    if (next.status !== "created") throw new TypeError("Expected a durable replacement");
    expect(
      listSupportIncidents(stateDir, { readOnly: true }).map((record) => record.incidentId),
    ).toEqual([next.incidentId]);
    expect(
      expectActivityLogProof(
        "support.incident.expired.emitted-line",
        persistedActivityLogLines(
          readPersistedActivityLog(stateDir),
          "support.incident.expired",
        ).at(-1) ?? "",
      ),
    ).toMatchObject({
      incidentId: victim.incidentId,
      correlationId: "pin-release-owner",
      retentionCause: "pin-ceiling",
      evictingCorrelationId: "pin-ceiling-replacement",
      evictingIncidentId: next.incidentId,
      removalStatus: "removed",
      pinRelease: "released",
    });
    expectEvictionReportReference(next.record, "evictingIncidentId", victim.incidentId);
  });

  it("reuses actual freed pin capacity despite an unrelated retained slot cleanup failure", () => {
    occupyDiagnosticPinReserve();
    vi.spyOn(incidentStore, "releaseSupportIncidentSlot").mockImplementationOnce(() => {
      throw new TypeError("simulated slot cleanup failure after publication");
    });
    const next = recordUserReportedIncident(stateDir, { correlationId: "pin-claim-failure-next" });
    if (next.status !== "created") throw new TypeError("Expected new pinned candidate");
    expect(next.record.pin.status).toBe("pinned");
    const following = recordUserReportedIncident(stateDir, {
      correlationId: "pin-claim-failure-following",
    });
    if (following.status !== "created") throw new TypeError("Expected subsequent pinned candidate");
    expect(following.record.pin.status).toBe("pinned");
    const ended = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.expired",
    );
    expect(ended.map((line): unknown => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        removalStatus: "removed",
        claimsStatus: "failed",
        pinRelease: "released",
        completeness: "partial",
      }),
    );
  });

  it("does not claim recovered pin pressure when the owned pin release was rejected", () => {
    occupyDiagnosticPinReserve();
    vi.spyOn(serverLog, "releaseActivityLogPin").mockReturnValueOnce({
      status: "rejected",
      reason: "removal-failed",
    });
    const request = vi.spyOn(serverLog, "pinActivityLogWindow");
    const next = recordUserReportedIncident(stateDir, { correlationId: "pin-release-new-request" });
    expect(next.status).toBe("created");
    if (next.status !== "created") throw new Error("Expected degraded candidate");
    expect(next.record.pin.status).toBe("pinned");
    expect(request).toHaveBeenCalledOnce();
    // The successful pin consumes the reserve; a refused old-pin release must not pretend it
    // recovered capacity for the next request, which keeps its genuine rejected outcome.
    const following = recordUserReportedIncident(stateDir);
    if (following.status !== "created") throw new Error("Expected degraded candidate");
    expect(following.record.pin.status).toBe("rejected");
    expect(request).toHaveBeenCalledTimes(2);
    const ended = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.expired",
    );
    expect(ended.map((line): unknown => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        removalStatus: "removed",
        pinRelease: "rejected",
        completeness: "partial",
      }),
    );
  });

  it("preserves manual and server failure pins when a browser candidate rolls its own oldest class", () => {
    const manual = recordUserReportedIncident(stateDir, { correlationId: "protected-manual" });
    const server = recordRegisteredFailureIncident(stateDir, {
      op: "coding-runtime.readiness.failed",
      errorKind: "unavailable",
      correlationId: "protected-server",
      frames: ["packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js:710:9"],
    });
    if (manual.status !== "created" || server?.status !== "created")
      throw new Error("Expected protected candidates");
    const browserIds: string[] = [];
    for (let index = 2; index < MAX_ACTIVITY_LOG_PINS; index += 1) {
      const candidate = recordRegisteredFailureIncident(stateDir, {
        op: "client.diagnostic",
        errorKind: "internal",
        correlationId: `browser-${String(index)}`,
        clientKind: "boundary",
        renderFailure: "window-body",
      });
      if (candidate?.status !== "created") throw new Error("Expected browser candidate");
      browserIds.push(candidate.incidentId);
    }
    const newest = recordRegisteredFailureIncident(stateDir, {
      op: "client.diagnostic",
      errorKind: "internal",
      correlationId: "new-browser",
      clientKind: "boundary",
      renderFailure: "window-body",
    });
    expect(newest?.status).toBe("created");
    const retainedIds = listSupportIncidents(stateDir, { readOnly: true }).map(
      (entry) => entry.incidentId,
    );
    expect(retainedIds).toContain(manual.incidentId);
    expect(retainedIds).toContain(server.incidentId);
    expect(retainedIds).not.toContain(browserIds[0]);
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toHaveLength(
      MAX_ACTIVITY_LOG_PINS - 1,
    );
  }, 60_000);

  it("never replaces a server failure slot to admit a lower-priority browser diagnostic", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    const policy = supportIncidentRetentionPolicy(stateDir);
    for (let index = 0; index < policy.browserCapacity; index += 1) {
      const server = recordRegisteredFailureIncident(stateDir, {
        op: "coding-runtime.readiness.failed",
        errorKind: ACTIVITY_LOG_ERROR_KINDS[index],
        correlationId: `protected-server-${String(index)}`,
        frames: [
          `packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js:${String(710 + index)}:9`,
        ],
      });
      expect(server?.status).toBe("created");
    }
    const before = listSupportIncidents(stateDir, { readOnly: true });
    const browser = recordRegisteredFailureIncident(stateDir, {
      op: "client.diagnostic",
      errorKind: "internal",
      correlationId: "no-browser-victim",
      clientKind: "boundary",
      renderFailure: "window-body",
    });
    expect(browser).toEqual({ status: "rejected", reason: "quota-exhausted" });
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(before);
  });
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
    const replacement = recordUserReportedIncident(stateDir, {
      correlationId: "slot-pressure-replacement",
    });
    if (replacement.status !== "created") throw new TypeError("Expected durable replacement");
    const retained = listSupportIncidents(stateDir, { readOnly: true });
    expect(retained).toHaveLength(capacity);
    expect(retained.some((record) => record.incidentId === first.incidentId)).toBe(false);
    expect(
      expectActivityLogProof(
        "support.incident.expired.emitted-line",
        persistedActivityLogLines(
          readPersistedActivityLog(stateDir),
          "support.incident.expired",
        ).at(-1) ?? "",
      ),
    ).toMatchObject({
      incidentId: first.incidentId,
      correlationId: first.record.correlation.rootCorrelationId,
      retentionCause: "slot-pressure",
      evictingCorrelationId: "slot-pressure-replacement",
      evictingIncidentId: replacement.incidentId,
      pinRelease: "released",
    });
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
      expectRolledLifecycle(text);
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

  it.each(["manual", "registered-child"] as const)(
    "keeps %s expiry on its original lifecycle during a different sweep request",
    (kind) => {
      const original =
        kind === "manual"
          ? recordUserReportedIncident(stateDir, { correlationId: "expiry-original" })
          : recordRegisteredFailureIncident(stateDir, {
              op: "client.diagnostic",
              errorKind: "internal",
              correlationId: "expiry-original",
              parentCorrelationId: "expiry-original-parent",
              clientKind: "boundary",
              renderFailure: "window-body",
            });
      if (original?.status !== "created") throw new TypeError("Expected expiry fixture candidate");
      expect(
        listSupportIncidents(stateDir, {
          nowMs: original.record.expiresAtMs,
          correlationId: "different-sweep-request",
        }),
      ).toEqual([]);
      const text = readPersistedActivityLog(stateDir);
      const expired = persistedActivityLogLines(text, "support.incident.expired");
      expect(expired).toHaveLength(1);
      const expiredRecord: unknown = JSON.parse(expired[0] ?? "");
      expect(expiredRecord).not.toHaveProperty("retentionCause");
      expect(expiredRecord).not.toHaveProperty("evictingCorrelationId");
      expect(expiredRecord).not.toHaveProperty("evictingIncidentId");
      expect(
        expectActivityLogProof("support.incident.expired.emitted-line", expired[0] ?? ""),
      ).toMatchObject({
        incidentId: original.incidentId,
        correlationId: "expiry-original",
        expiryReason: "expired",
        removalStatus: "removed",
      });
      expect(JSON.parse(expired[0] ?? "{}")).not.toHaveProperty("parentCorrelationId");
      expect(expired[0]).not.toContain("different-sweep-request");
      const analysis = analyzeSupportReport(
        createDesktopSupportReport(stateDir, "expiry-original").reportJson,
      );
      expect(analysis.analysis.evidence.classification).toBe("supported");
      expect(analysis.analysis.sufficiency.classes.flatMap((entry) => entry.reasons)).not.toContain(
        "lifecycle-start-missing",
      );
    },
  );

  it.each([
    ["prepared", "manual"],
    ["dismissed", "manual"],
    ["prepared", "registered-child"],
    ["dismissed", "registered-child"],
  ] as const)("closes a %s %s pin under its original owning correlation", (action, kind) => {
    const first =
      kind === "manual"
        ? recordUserReportedIncident(stateDir, { correlationId: "original-retirement" })
        : recordRegisteredFailureIncident(stateDir, {
            op: "client.diagnostic",
            errorKind: "internal",
            correlationId: "original-retirement",
            parentCorrelationId: "original-parent",
            clientKind: "boundary",
            renderFailure: "window-body",
          });
    if (first?.status !== "created") throw new Error("Expected original candidate");
    const pinPath = join(stateDir, "logs", `pin-${first.record.pin.pinId ?? "missing"}.json`);
    expect(existsSync(pinPath)).toBe(true);
    const retire = action === "prepared" ? completePreparedSupportIncident : dismissSupportIncident;
    expect(retire(stateDir, first.incidentId, { correlationId: "new-retirement-request" })).toBe(
      "dismissed",
    );
    expect(existsSync(pinPath)).toBe(false);
    const text = readPersistedActivityLog(stateDir);
    const releases = persistedActivityLogLines(text, "activity-log.pin.expired").map(
      (line) => JSON.parse(line) as unknown,
    );
    expect(releases).toContainEqual(
      expect.objectContaining({ correlationId: "original-retirement" }),
    );
    expect(releases).not.toContainEqual(
      expect.objectContaining({ correlationId: "new-retirement-request" }),
    );
    expectRetirementStarted(
      text,
      first.record.incidentId,
      action === "prepared" ? "reported" : "candidate",
    );
    const actions = persistedActivityLogLines(text, "support.incident.dismissed").map(
      (line) => JSON.parse(line) as unknown,
    );
    expect(actions).toContainEqual(
      expect.objectContaining({ correlationId: "new-retirement-request" }),
    );
    for (const correlationId of ["original-retirement", "new-retirement-request"]) {
      expectClosedRetirementReport(correlationId);
    }
  });

  it("preserves a peer slot reclaimed while the original record is being retired", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
    const capacity = supportIncidentRetentionPolicy(stateDir).capacity;
    const first = recordUserReportedIncident(stateDir, { correlationId: "original-slot-owner" });
    if (first.status !== "created") throw new Error("Expected original candidate");
    for (let index = 1; index < capacity; index += 1) recordUserReportedIncident(stateDir);
    const oldClaim = listSupportIncidentClaims(stateDir).find(
      (claim) => claim.incidentId === first.incidentId,
    );
    if (oldClaim === undefined) throw new Error("Expected original claim");
    const abandoned = new Date(Date.now() - 60_000);
    utimesSync(
      join(incidentStore.supportIncidentDirectory(stateDir), oldClaim.fileName),
      abandoned,
      abandoned,
    );
    const originalRemove = incidentStore.removeSupportIncidentRecord;
    let peer: ReturnType<typeof recordUserReportedIncident> | undefined;
    vi.spyOn(incidentStore, "removeSupportIncidentRecord").mockImplementationOnce(
      (directory, id) => {
        originalRemove(directory, id);
        peer = recordUserReportedIncident(stateDir, { correlationId: "new-peer-slot-owner" });
      },
    );
    expect(completePreparedSupportIncident(stateDir, first.incidentId)).toBe("dismissed");
    expect(peer?.status).toBe("created");
    if (peer?.status !== "created") throw new Error("Expected peer candidate");
    const peerId = peer.incidentId;
    expect(listSupportIncidentClaims(stateDir).some((claim) => claim.incidentId === peerId)).toBe(
      true,
    );
    expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(capacity);
  });

  it.each(["slot", "fingerprint"] as const)(
    "preserves a replaced %s claim against the old owner",
    (kind) => {
      ensureSupportIncidentDirectory(stateDir);
      const oldOwner = "a".repeat(32);
      const peerOwner = "b".repeat(32);
      const fingerprint = "c".repeat(64);
      const claim = (owner: string): boolean =>
        kind === "slot"
          ? incidentStore.claimSupportIncidentSlot(stateDir, 0, owner)
          : incidentStore.claimSupportIncidentFingerprint(stateDir, fingerprint, owner);
      const release = (owner?: string): void => {
        if (kind === "slot") {
          incidentStore.releaseSupportIncidentSlot(stateDir, 0, owner);
        } else {
          incidentStore.releaseSupportIncidentFingerprintClaim(stateDir, fingerprint, owner);
        }
      };
      expect(claim(oldOwner)).toBe(true);
      release();
      expect(claim(peerOwner)).toBe(true);
      release(oldOwner);
      expect(listSupportIncidentClaims(stateDir)).toMatchObject([{ incidentId: peerOwner }]);
      release(peerOwner);
      expect(listSupportIncidentClaims(stateDir)).toEqual([]);
    },
  );

  it("preserves a fresh torn peer claim when an orphan snapshot is stale", () => {
    ensureSupportIncidentDirectory(stateDir);
    expect(incidentStore.claimSupportIncidentSlot(stateDir, 0, "a".repeat(32))).toBe(true);
    const initial = listSupportIncidentClaims(stateDir)[0];
    if (initial === undefined) throw new Error("Expected original claim");
    const path = join(incidentStore.supportIncidentDirectory(stateDir), initial.fileName);
    writeFileSync(path, "", { mode: 0o600 });
    const abandoned = new Date(Date.now() - 60_000);
    utimesSync(path, abandoned, abandoned);
    const stale = listSupportIncidentClaims(stateDir)[0];
    if (stale === undefined) throw new Error("Expected torn claim");
    incidentStore.removeSupportIncidentClaimFile(stateDir, stale.fileName);
    writeFileSync(path, "", { mode: 0o600 });
    incidentStore.removeSupportIncidentClaimFile(stateDir, stale.fileName, stale);
    expect(existsSync(path)).toBe(true);
  });

  it("attempts only free reservation candidates without materializing a huge configured pool", () => {
    vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", String(Number.MAX_SAFE_INTEGER));
    const claim = vi.spyOn(incidentStore, "claimSupportIncidentSlot");
    expect(recordUserReportedIncident(stateDir).status).toBe("created");
    expect(claim).toHaveBeenCalledTimes(1);
    expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(1);
  });
  it("does not roll retained evidence for a duplicate observed failure at pin capacity", () => {
    const evidence = {
      op: "coding-runtime.readiness.failed",
      errorKind: "unavailable",
      correlationId: "fresh-protected-failure",
      frames: ["packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js:710:9"],
    };
    const original = recordRegisteredFailureIncident(stateDir, evidence);
    if (original?.status !== "created") throw new Error("Expected original failure");
    for (let index = 1; index < MAX_ACTIVITY_LOG_PINS - 1; index += 1)
      expect(recordUserReportedIncident(stateDir).status).toBe("created");
    const before = listSupportIncidents(stateDir, { readOnly: true });
    const pins = listActivityLogDirectory(join(stateDir, "logs")).pins.map((pin) => pin.pinId);
    persistFreshFailure();
    setSupportIncidentTriggerForTests(true);
    const registration = activityLogOperationSchema(evidence.op);
    if (registration === undefined) throw new Error("Expected operation registration");
    createFileServerLogSink(stateDir).write(
      attachActivityLogEventRegistration(
        {
          level: "error",
          category: "process",
          op: evidence.op,
          correlationId: "duplicate-observed-failure",
          errorKind: evidence.errorKind,
          extra: {
            phase: "endpoint",
            frames: evidence.frames,
            causeChain: ["Error"],
            completeness: "complete",
            loss: "none",
          },
        },
        registration,
      ),
    );
    drainSupportIncidentCandidates();
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(before);
    expect(listActivityLogDirectory(join(stateDir, "logs")).pins.map((pin) => pin.pinId)).toEqual(
      pins,
    );
    expect(
      persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.deduplicated",
      ),
    ).toHaveLength(1);
  }, 60_000);

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
    expect(retained).toHaveLength(MAX_ACTIVITY_LOG_PINS - 1);
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
