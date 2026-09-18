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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Simulates "a retention pass racing the gap" (#3533 review 4050605915): armed for one test, the
// next directory listing taken through the real `listActivityLogDirectory` -- the same read
// `pinIncidentWindow`'s before/after snapshots and retention itself use -- also deletes a sealed
// segment as a side effect, as if a concurrent maintenance pass (this process's own next segment
// admission, or another process sharing stateDir) removed it between the trigger observing the
// window and its pin actually covering it. Every other call is an untouched passthrough.
const retentionRace = vi.hoisted(() => ({
  targetPath: undefined as string | undefined,
  armed: false,
}));

vi.mock("./activity-log-store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./activity-log-store.js")>();
  const { unlinkSync } = await import("node:fs");
  return {
    ...original,
    listActivityLogDirectory: (
      directory: string,
    ): ReturnType<typeof original.listActivityLogDirectory> => {
      const listing = original.listActivityLogDirectory(directory);
      if (retentionRace.armed && retentionRace.targetPath !== undefined) {
        retentionRace.armed = false;
        unlinkSync(retentionRace.targetPath);
      }
      return listing;
    },
  };
});

// Simulates "a second process wins the race" (#3533 review 4050606506): armed for one test, the
// next directory snapshot createCandidate's sweep takes is captured FIRST (this call's own stale,
// pre-race view), and only THEN does the armed hook run -- so a concurrent occurrence can fully
// publish (claim, write, evidence) before this call proceeds to its own atomic claim attempt,
// exactly the window the old entries-scan dedup and quota missed. Every other call is untouched.
const dedupRace = vi.hoisted(() => ({
  onStaleSnapshot: undefined as (() => void) | undefined,
}));

// Simulates a claim the orphan sweep cannot remove (permissions, a vanished directory): armed for
// one test, every claim removal fails and the sweep reports it instead of clearing the claim.
const claimRemoval = vi.hoisted(() => ({ blocked: false }));

vi.mock("./support-incident-store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./support-incident-store.js")>();
  return {
    ...original,
    listSupportIncidentEntries: (
      stateDir: string,
    ): ReturnType<typeof original.listSupportIncidentEntries> => {
      const staleSnapshot = original.listSupportIncidentEntries(stateDir);
      const hook = dedupRace.onStaleSnapshot;
      dedupRace.onStaleSnapshot = undefined;
      hook?.();
      return staleSnapshot;
    },
    removeSupportIncidentClaimFile: (stateDir: string, fileName: string): void => {
      if (claimRemoval.blocked) throw new Error("claim removal blocked by the test");
      original.removeSupportIncidentClaimFile(stateDir, fileName);
    },
  };
});

import {
  ACTIVITY_LOG_DIRECTORY_NAME,
  ACTIVITY_LOG_OPERATION_SURFACES,
  SUPPORT_INCIDENT_DIRECTORY_NAME,
  activityLogOperationSchema,
  attachActivityLogEventRegistration,
  defectFingerprintPreimage,
  isSupportIncidentId,
  parseSupportIncidentFileName,
  parseSupportIncidentRecord,
  supportIncidentFileName,
  supportIncidentFingerprintClaimFileName,
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
// A namespace import alongside the named one above: vi.spyOn needs a live binding it can swap for
// exactly one call (#3533 audit, dismiss's declared "not-pinned"/"rejected" pin-release outcomes).
// server-log.ts imports support-incident.ts back for the sink's trigger hook, so a factory-based
// vi.mock("./server-log.js", ...) here never took effect against that circular import; spying on
// the resolved namespace after both modules finish loading works around it.
import * as serverLogModule from "./server-log.js";
import {
  claimSupportIncidentFingerprint,
  claimSupportIncidentSlot,
  ensureSupportIncidentDirectory,
} from "./support-incident-store.js";
import {
  MAX_REGISTERED_FAILURE_INCIDENTS,
  SUPPORT_INCIDENT_IN_FLIGHT_GRACE_MS,
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
// SHA-256 of the v1 preimage of (tools-workflows, FAILURE_OP, unavailable, FRAMES).
const GOLDEN_FAILURE_FINGERPRINT =
  "7a18258e2761c06fc058ff77d9335f3f6747abac74de4e3a5b73b45cc6677b08";

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
    retentionRace.targetPath = undefined;
    retentionRace.armed = false;
    dedupRace.onStaleSnapshot = undefined;
    claimRemoval.blocked = false;
    rmSync(stateDir, { recursive: true, force: true });
  });

  // Backdates a store file past the in-flight grace: a file whose writer crashed long ago, as
  // opposed to one another process may still be writing.
  function abandon(name: string): void {
    const pastSeconds = (Date.now() - SUPPORT_INCIDENT_IN_FLIGHT_GRACE_MS - 1_000) / 1_000;
    utimesSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME, name), pastSeconds, pastSeconds);
  }

  function lines(op: string): readonly string[] {
    return persistedActivityLogLines(readPersistedActivityLog(stateDir), op);
  }

  // Real incident-<32 hex>.json records only, never a fingerprint- or slot-claim file: the
  // closed-grammar parse also recognizes claims (state-paths.ts needs it to), so this mirrors the
  // production isSupportIncidentId guard rather than counting every file the store owns.
  function storeNames(): readonly string[] {
    return [...readdirSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME))]
      .filter((name) => isSupportIncidentId(parseSupportIncidentFileName(name)))
      .sort((left, right) => left.localeCompare(right, "en-US"));
  }

  // Every name in the store directory, unfiltered: proves a foreign file is left exactly alone.
  function allStoreNames(): readonly string[] {
    return [...readdirSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME))].sort((left, right) =>
      left.localeCompare(right, "en-US"),
    );
  }

  function claimNames(): readonly string[] {
    return [...readdirSync(join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME))]
      .filter((name) => {
        const parsed = parseSupportIncidentFileName(name);
        return parsed !== undefined && !isSupportIncidentId(parsed);
      })
      .sort((left, right) => left.localeCompare(right, "en-US"));
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
      expect(again).toEqual({
        status: "deduplicated",
        incidentId: first.incidentId,
        record: first,
      });
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

  describe("cross-process dedup and quota atomicity", () => {
    it("claims a fingerprint exactly once when two attempts race (#3533 review 4050606506)", () => {
      ensureSupportIncidentDirectory(stateDir);
      expect(
        claimSupportIncidentFingerprint(stateDir, GOLDEN_FAILURE_FINGERPRINT, "a".repeat(32)),
      ).toBe(true);
      expect(
        claimSupportIncidentFingerprint(stateDir, GOLDEN_FAILURE_FINGERPRINT, "b".repeat(32)),
      ).toBe(false);
    });

    it("claims a quota slot exactly once when two attempts race (#3533 review 4050606506)", () => {
      ensureSupportIncidentDirectory(stateDir);
      expect(claimSupportIncidentSlot(stateDir, 3, "a".repeat(32))).toBe(true);
      expect(claimSupportIncidentSlot(stateDir, 3, "b".repeat(32))).toBe(false);
    });

    it("deduplicates onto a concurrent occurrence that published between this call's stale snapshot and its own claim attempt (#3533 review 4050606506)", () => {
      const evidence = { op: FAILURE_OP, errorKind: "unavailable", frames: FRAMES };
      let concurrent: SupportIncidentCreation | undefined;
      dedupRace.onStaleSnapshot = (): void => {
        // The "second process": it fully claims, writes and evidences its own occurrence of the
        // IDENTICAL defect while this call still holds only its own stale, pre-race snapshot.
        concurrent = recordRegisteredFailureIncident(stateDir, {
          ...evidence,
          correlationId: "concurrent-process",
        });
      };
      const result = recordRegisteredFailureIncident(stateDir, {
        ...evidence,
        correlationId: "this-process",
      });
      expect(dedupRace.onStaleSnapshot).toBeUndefined(); // the hook fired exactly once
      expect(concurrent?.status).toBe("created");
      const winner = created(concurrent).record;
      expect(result).toEqual({
        status: "deduplicated",
        incidentId: winner.incidentId,
        record: winner,
      });
      expect(storeNames()).toHaveLength(1);
      expect(lines("support.incident.created")).toHaveLength(1);
      expect(lines("support.incident.deduplicated")).toHaveLength(1);
    });

    it("recovers a fingerprint and slot claim orphaned by a crash between claiming and writing the record", () => {
      ensureSupportIncidentDirectory(stateDir);
      const orphanId = "c".repeat(32);
      expect(claimSupportIncidentFingerprint(stateDir, GOLDEN_FAILURE_FINGERPRINT, orphanId)).toBe(
        true,
      );
      expect(claimSupportIncidentSlot(stateDir, 9, orphanId)).toBe(true);
      expect(claimNames()).toHaveLength(2);
      for (const name of claimNames()) abandon(name);

      expect(listSupportIncidents(stateDir)).toEqual([]); // runs the expiry/orphan sweep

      expect(claimNames()).toHaveLength(0);
      // Both the fingerprint and the slot are free again for a fresh occurrence.
      expect(
        claimSupportIncidentFingerprint(stateDir, GOLDEN_FAILURE_FINGERPRINT, "d".repeat(32)),
      ).toBe(true);
      expect(claimSupportIncidentSlot(stateDir, 9, "d".repeat(32))).toBe(true);
    });

    it("leaves the claims of an occurrence another process is still publishing alone (#3533 review 4050606506)", () => {
      ensureSupportIncidentDirectory(stateDir);
      const inFlightId = "c".repeat(32);
      claimSupportIncidentFingerprint(stateDir, GOLDEN_FAILURE_FINGERPRINT, inFlightId);
      claimSupportIncidentSlot(stateDir, 9, inFlightId);

      expect(listSupportIncidents(stateDir)).toEqual([]); // runs the expiry/orphan sweep

      expect(claimNames()).toHaveLength(2);
      expect(
        claimSupportIncidentFingerprint(stateDir, GOLDEN_FAILURE_FINGERPRINT, "d".repeat(32)),
      ).toBe(false);
      expect(claimSupportIncidentSlot(stateDir, 9, "d".repeat(32))).toBe(false);
    });

    it("deduplicates onto an occurrence another process is still publishing instead of taking over its claim (#3533 review 4050606506)", () => {
      ensureSupportIncidentDirectory(stateDir);
      const inFlightId = "c".repeat(32);
      claimSupportIncidentFingerprint(stateDir, GOLDEN_FAILURE_FINGERPRINT, inFlightId);

      const result = recordRegisteredFailureIncident(stateDir, {
        op: FAILURE_OP,
        errorKind: "unavailable",
        frames: FRAMES,
        correlationId: "second-process",
      });

      expect(result).toEqual({ status: "deduplicated", incidentId: inFlightId, record: undefined });
      expect(storeNames()).toEqual([]);
      expect(claimNames()).toEqual([
        supportIncidentFingerprintClaimFileName(GOLDEN_FAILURE_FINGERPRINT),
      ]);
      expect(lines("support.incident.created")).toHaveLength(0);
      const line = expectActivityLogProof(
        "support.incident.deduplicated.emitted-line",
        lines("support.incident.deduplicated")[0] ?? "",
      );
      expect(line).toMatchObject({
        incidentId: inFlightId,
        defectFingerprint: GOLDEN_FAILURE_FINGERPRINT,
        trigger: "registered-failure",
        correlationId: "second-process",
      });
    });

    it("gives up rather than publish a second record while the holder has not written its claim yet", () => {
      ensureSupportIncidentDirectory(stateDir);
      const claimPath = join(
        stateDir,
        SUPPORT_INCIDENT_DIRECTORY_NAME,
        supportIncidentFingerprintClaimFileName(GOLDEN_FAILURE_FINGERPRINT),
      );
      writeFileSync(claimPath, "", { mode: 0o600 }); // exclusive-created, id not written yet

      const result = recordRegisteredFailureIncident(stateDir, {
        op: FAILURE_OP,
        errorKind: "unavailable",
        frames: FRAMES,
      });

      expect(result).toEqual({ status: "rejected", reason: "store-unavailable" });
      expect(storeNames()).toEqual([]);
      expect(claimNames()).toHaveLength(1);
    });

    it("gives up rather than publish a second record when an abandoned claim cannot be cleared", () => {
      ensureSupportIncidentDirectory(stateDir);
      claimSupportIncidentFingerprint(stateDir, GOLDEN_FAILURE_FINGERPRINT, "c".repeat(32));
      for (const name of claimNames()) abandon(name);
      claimRemoval.blocked = true;

      const result = recordRegisteredFailureIncident(stateDir, {
        op: FAILURE_OP,
        errorKind: "unavailable",
        frames: FRAMES,
      });

      expect(result).toEqual({ status: "rejected", reason: "store-unavailable" });
      expect(storeNames()).toEqual([]);
      expect(claimNames()).toHaveLength(1);
    });
  });

  describe("the incident window pin", () => {
    it("is already published before recordRegisteredFailureIncident returns", () => {
      const { record } = created(
        recordRegisteredFailureIncident(stateDir, {
          op: FAILURE_OP,
          errorKind: "unavailable",
          frames: FRAMES,
        }),
      );
      expect(record.pin.status).toBe("pinned");
      expect(record.pin.evidenceLostBeforePin).toBe(false);
      expect(lines("activity-log.pin.created")).toHaveLength(1);
    });

    it("marks evidenceLostBeforePin when a maintenance pass removes a sealed segment inside the window before the pin covers it (#3533 review 4050605915)", () => {
      // A sealed segment that will fall inside the next incident's [-15min, +5min] window.
      createFileServerLogSink(stateDir).write(failureEvent({ correlationId: "prior-occurrence" }));
      closeFileServerLogSinks();
      const directory = join(stateDir, ACTIVITY_LOG_DIRECTORY_NAME);
      const sealedName = readdirSync(directory).find(
        (name) => name.endsWith(".jsonl") && !name.endsWith(".active.jsonl"),
      );
      if (sealedName === undefined) throw new Error("fixture: expected a sealed segment on disk");
      retentionRace.targetPath = join(directory, sealedName);
      retentionRace.armed = true;

      const { record } = created(
        recordRegisteredFailureIncident(stateDir, {
          op: FAILURE_OP,
          errorKind: "unavailable",
          correlationId: "racing-occurrence",
          frames: ["packages/keiko-server/dist/race/m0.js:1:1"],
        }),
      );

      expect(retentionRace.armed).toBe(false); // the race fired exactly once
      expect(record.pin.status).toBe("pinned");
      expect(record.pin.evidenceLostBeforePin).toBe(true);
      const line = expectActivityLogProof(
        "support.incident.created.emitted-line",
        lines("support.incident.created")[0] ?? "",
      );
      expect(line).toMatchObject({ evidenceLostBeforePin: true, completeness: "partial" });
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
      abandon(supportIncidentFileName(tornId));
      expect(listSupportIncidents(stateDir)).toEqual([]);
      expect(allStoreNames()).toEqual(["notes.txt"]);
      expect(
        persistedActivityLogLines(readPersistedActivityLog(stateDir), "support.incident.expired"),
      ).toHaveLength(1);
      expect(JSON.parse(lines("support.incident.expired")[0] ?? "{}")).toMatchObject({
        incidentId: tornId,
        expiryReason: "invalid-record",
        removalStatus: "removed",
      });
    });

    it("leaves an unreadable record another process may still be writing alone", () => {
      const directory = join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const inFlightId = "f".repeat(32);
      // Exclusive-created by its writer, which has not written the record's bytes yet.
      writeFileSync(join(directory, supportIncidentFileName(inFlightId)), "", { mode: 0o600 });

      expect(listSupportIncidents(stateDir)).toEqual([]);

      expect(allStoreNames()).toEqual([supportIncidentFileName(inFlightId)]);
      expect(lines("support.incident.expired")).toHaveLength(0);
    });

    it("never interprets a record of another schema version (a newer Keiko) and sweeps it", () => {
      const { record } = created(recordUserReportedIncident(stateDir));
      const directory = join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME);
      const futureId = "e".repeat(32);
      writeFileSync(
        join(directory, supportIncidentFileName(futureId)),
        JSON.stringify({ ...record, schemaVersion: 2, incidentId: futureId }),
        { mode: 0o600 },
      );
      abandon(supportIncidentFileName(futureId));
      expect(readSupportIncident(stateDir, futureId)).toBeUndefined();
      expect(listSupportIncidents(stateDir)).toEqual([record]);
      expect(JSON.parse(lines("support.incident.expired")[0] ?? "{}")).toMatchObject({
        incidentId: futureId,
        expiryReason: "invalid-record",
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

    it("reports a not-pinned release when the candidate's own pin was never created (#3533 audit)", () => {
      vi.spyOn(serverLogModule, "pinActivityLogWindow").mockReturnValueOnce({
        status: "rejected",
        reason: "storage-unavailable",
      });
      const { record } = created(recordUserReportedIncident(stateDir));
      expect(record.pin).toMatchObject({ status: "rejected", pinnedSegmentCount: 0 });
      expect(record.pin.pinId).toBeUndefined();

      expect(dismissSupportIncident(stateDir, record.incidentId)).toBe("dismissed");
      const line = expectActivityLogProof(
        "support.incident.dismissed.emitted-line",
        lines("support.incident.dismissed")[0] ?? "",
      );
      expect(line).toMatchObject({ incidentId: record.incidentId, pinRelease: "not-pinned" });
      // No pin ever existed, so nothing to expire either.
      expect(lines("activity-log.pin.expired")).toHaveLength(0);
    });

    it("reports a rejected release when releasing the pin itself fails (#3533 audit)", () => {
      const { record } = created(recordUserReportedIncident(stateDir));
      expect(record.pin.status).toBe("pinned");
      vi.spyOn(serverLogModule, "releaseActivityLogPin").mockReturnValueOnce({
        status: "rejected",
        reason: "not-found",
      });

      expect(dismissSupportIncident(stateDir, record.incidentId)).toBe("dismissed");
      expect(listSupportIncidents(stateDir)).toEqual([]); // the record itself is still removed
      const line = expectActivityLogProof(
        "support.incident.dismissed.emitted-line",
        lines("support.incident.dismissed")[0] ?? "",
      );
      expect(line).toMatchObject({
        incidentId: record.incidentId,
        pinRelease: "rejected",
        completeness: "partial",
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
    it("publishes the window pin inside the sink's write, but defers the record to the next turn", async () => {
      setSupportIncidentTriggerForTests(true);
      createFileServerLogSink(stateDir).write(failureEvent());
      // The window is already protected before write() returns: no later maintenance pass -- this
      // process's own next segment admission, or a second process sharing stateDir -- can run
      // against an unpinned window (#3533 review 4050605915). Only the record itself is deferred.
      expect(lines("activity-log.pin.created")).toHaveLength(1);
      expect(listSupportIncidents(stateDir)).toEqual([]);
      expect(lines("support.incident.created")).toHaveLength(0);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const [incident] = listSupportIncidents(stateDir);
      expect(incident).toMatchObject({
        trigger: "registered-failure",
        fingerprint: { op: FAILURE_OP, errorKind: "unavailable", frameCount: 1 },
        correlation: { rootCorrelationId: "failure-correlation-1", childCorrelationIds: [] },
        pin: { status: "pinned", evidenceLostBeforePin: false },
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

    it("releases the trigger's own pin when the deferred step finds a duplicate", async () => {
      setSupportIncidentTriggerForTests(true);
      const sink = createFileServerLogSink(stateDir);
      sink.write(failureEvent());
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(listSupportIncidents(stateDir)).toHaveLength(1);

      // A second occurrence of the identical defect also pins its own window synchronously (the
      // trigger always pre-pins before it knows whether this will be a duplicate) and is then
      // deduplicated onto the open incident in the deferred step, so the redundant second pin must
      // be released rather than sit and hold segments until its own 14-day TTL.
      setSupportIncidentTriggerForTests(true); // clears the one-per-minute suppression memory
      sink.write(failureEvent({ correlationId: "second-occurrence" }));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(listSupportIncidents(stateDir)).toHaveLength(1);
      expect(lines("support.incident.deduplicated")).toHaveLength(1);
      expect(lines("activity-log.pin.created")).toHaveLength(2);
      const released = lines("activity-log.pin.expired")
        .map((text) => JSON.parse(text) as { expiryReason?: string })
        .filter((entry) => entry.expiryReason === "released");
      expect(released).toHaveLength(1);
    });

    it("ignores warn-level failures, and the whole trigger under the test-writer marker", () => {
      setSupportIncidentTriggerForTests(true);
      createFileServerLogSink(stateDir).write(failureEvent({ level: "warn" }));
      setSupportIncidentTriggerForTests(undefined);
      createFileServerLogSink(stateDir).write(failureEvent());
      drainSupportIncidentCandidates();
      expect(listSupportIncidents(stateDir)).toEqual([]);
    });

    it("suppresses a failure storm of one defect to a single evaluation, with no rejection evidence", () => {
      setSupportIncidentTriggerForTests(true);
      const sink = createFileServerLogSink(stateDir);
      for (let index = 0; index < 5; index += 1) sink.write(failureEvent());
      drainSupportIncidentCandidates();
      expect(listSupportIncidents(stateDir)).toHaveLength(1);
      expect(lines("support.incident.deduplicated")).toHaveLength(0);
      // A suppressed recurrence loses no evidence -- the first occurrence already pinned the
      // window -- so, unlike a rate-limited evaluation, it is not itself an evidenced rejection.
      expect(lines("support.incident.rejected")).toHaveLength(0);
    });

    it("caps evaluations across distinct defects per rolling minute, evidencing the overflow once (#3533 audit)", () => {
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
      // 3 distinct new defects were dropped purely by the shared per-minute cap: evidenced once,
      // never once per dropped evaluation (#3533 audit: "rate-limited evaluations vanish silently").
      expect(lines("support.incident.rejected")).toHaveLength(1);
      const line = expectActivityLogProof(
        "support.incident.rejected.emitted-line",
        lines("support.incident.rejected")[0] ?? "",
      );
      expect(line).toMatchObject({
        rejectionReason: "evaluation-rate-limited",
        trigger: "registered-failure",
        errorKind: "rate-limited",
        completeness: "partial",
        loss: "event-dropped",
      });
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

  it("pins algorithm version 1: any drift must bump DEFECT_FINGERPRINT_ALGORITHM_VERSION", () => {
    // Golden values. If this fails, the fingerprint algorithm changed incompatibly: bump the
    // version (fingerprints of different versions are never compared) instead of editing these.
    expect(
      computeDefectFingerprint({
        surface: "unattributed",
        op: "unattributed",
        errorKind: "unknown",
        frames: [],
      }),
    ).toBe("6e372bd5ff10f6b663533afe15aa6b4c8f487e9d4e2532a1b390be02dfbfde99");
    expect(
      computeDefectFingerprint({
        surface: "tools-workflows",
        op: FAILURE_OP,
        errorKind: "unavailable",
        frames: FRAMES,
      }),
    ).toBe(GOLDEN_FAILURE_FINGERPRINT);
  });

  it("never copies an event body into the record: hostile values are reduced or dropped", () => {
    const { record } = created(
      recordRegisteredFailureIncident(stateDir, {
        op: FAILURE_OP,
        errorKind: "Request to https://api.example.com failed for alice@example.com",
        correlationId: "/Users/alice/secret-project",
        parentCorrelationId: "Bearer sk-live-abcdefghijklmnop",
        frames: ["/Users/alice/keiko/packages/keiko-server/dist/a.js:1:1", "prompt: tell me"],
      }),
    );
    const persisted = readFileSync(
      join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME, supportIncidentFileName(record.incidentId)),
      "utf8",
    );
    for (const hostile of ["example.com", "alice", "/Users", "prompt", "sk-live", "https"]) {
      expect(persisted).not.toContain(hostile);
    }
    expect(record.fingerprint).toMatchObject({ errorKind: "unknown", frameCount: 0 });
    expect(record.correlation).toEqual({ childCorrelationIds: [] });
  });
});
