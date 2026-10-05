import { mkdtempSync, rmSync, openSync } from "node:fs";
import * as filesystem from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_ERROR_KINDS,
  supportIncidentSlotClaimFileName,
  type SupportIncidentRecord,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { closeFileServerLogSinks, resetServerLogFailureNotices } from "./server-log.js";
import {
  recordRegisteredFailureIncident,
  recordUserReportedIncident,
  listSupportIncidents,
  dismissSupportIncident,
  setSupportIncidentTriggerForTests,
} from "./support-incident.js";
import * as store from "./support-incident-store.js";
import * as serverLog from "./server-log.js";
import { supportIncidentRetentionPolicy } from "./support-incident-retention.js";
import { listActivityLogDirectory } from "./activity-log-store.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
const actualOpen = vi.mocked(openSync).getMockImplementation();
let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-incident-recovery-"));
  vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
  setSupportIncidentTriggerForTests(false);
});
afterEach(() => {
  closeFileServerLogSinks();
  resetServerLogFailureNotices();
  setSupportIncidentTriggerForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

type AutomaticClass = "server" | "browser";
function register(kind: AutomaticClass, index: number): SupportIncidentRecord {
  const created = recordRegisteredFailureIncident(stateDir, {
    op: kind === "browser" ? "client.diagnostic" : "coding-runtime.readiness.failed",
    errorKind: ACTIVITY_LOG_ERROR_KINDS[index],
    correlationId: `recovery-${kind}-${String(index)}`,
    ...(kind === "browser" ? { clientKind: "boundary", renderFailure: "window-body" } : {}),
  });
  if (created?.status !== "created") throw new TypeError("Expected distinct registered candidate");
  return created.record;
}

function occupiedClass(kind: AutomaticClass): {
  readonly candidates: readonly SupportIncidentRecord[];
  readonly protectedRecords: readonly SupportIncidentRecord[];
  readonly capacity: number;
} {
  const manual = recordUserReportedIncident(stateDir);
  if (manual.status !== "created") throw new TypeError("Expected protected manual candidate");
  const protectedRecords = [manual.record];
  const policy = supportIncidentRetentionPolicy(stateDir);
  const capacity = kind === "browser" ? policy.browserCapacity : policy.automaticCapacity;
  const candidates = Array.from({ length: capacity }, (_, index) => register(kind, index));
  if (kind === "browser") {
    const reserve = register("server", 0);
    protectedRecords.push(register("server", 1));
    expect(dismissSupportIncident(stateDir, reserve.incidentId)).toBe("dismissed");
  }
  vi.spyOn(store, "removeSupportIncidentRecord").mockImplementationOnce(() => {
    throw new TypeError("simulated retirement failure after durable publication");
  });
  candidates.push(register(kind, capacity));
  expect(listSupportIncidents(stateDir, { readOnly: true })).toHaveLength(
    capacity + 1 + protectedRecords.length,
  );
  return { candidates, protectedRecords, capacity };
}

function occupyProtectedClassReserve(kind: AutomaticClass): number {
  const policy = supportIncidentRetentionPolicy(stateDir);
  const capacity = kind === "browser" ? policy.browserCapacity : policy.automaticCapacity;
  const manualCount = kind === "browser" ? 1 : policy.capacity - capacity + 1;
  for (let index = 0; index < manualCount; index += 1)
    expect(recordUserReportedIncident(stateDir).status).toBe("created");
  for (let index = 0; index < capacity; index += 1) {
    if (kind === "server" && index === capacity - 1)
      vi.spyOn(store, "removeSupportIncidentRecord").mockImplementationOnce(() => {
        throw new TypeError("simulated interrupted class-share cleanup");
      });
    register(kind, index);
  }
  if (kind === "browser") register("server", 0);
  return capacity;
}

describe("durable class publication reserve recovery", () => {
  it("keeps ordinary admission to its preclaim and postpublication names-only reads", () => {
    const indexes = vi.spyOn(store, "listSupportIncidentSlotIndexes");
    expect(recordUserReportedIncident(stateDir).status).toBe("created");
    expect(indexes).toHaveBeenCalledTimes(2);
  });

  it.each(["server", "browser"] as const)(
    "recovers only the oldest %s owners with truthful full-store counts",
    (kind) => {
      const fixture = occupiedClass(kind);
      const allBefore = listSupportIncidents(stateDir, { readOnly: true });
      const claims = vi.spyOn(store, "listSupportIncidentClaims");
      const indexes = vi.spyOn(store, "listSupportIncidentSlotIndexes");
      const newest = register(kind, fixture.capacity + 1);
      expect.soft(claims).toHaveBeenCalledTimes(1);
      // Recovery additionally refreshes slot names once before its exclusive retry.
      expect.soft(indexes).toHaveBeenCalledTimes(3);
      const removed = fixture.candidates.slice(0, 2);
      const retained = listSupportIncidents(stateDir, { readOnly: true });
      expect(retained.map((record) => record.incidentId).sort()).toEqual(
        [...fixture.protectedRecords, ...fixture.candidates.slice(2), newest]
          .map((record) => record.incidentId)
          .sort(),
      );
      const retainedClaims = store.listSupportIncidentClaims(stateDir);
      const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
      for (const record of removed) {
        expect(retainedClaims.some((claim) => claim.incidentId === record.incidentId)).toBe(false);
        expect(pins.some((pin) => pin.pinId === record.pin.pinId)).toBe(false);
      }
      const expired = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.expired",
      );
      expect(
        expired
          .slice(-2)
          .map((line) => expectActivityLogProof("support.incident.expired.emitted-line", line)),
      ).toEqual(
        removed.map((record): unknown =>
          expect.objectContaining({
            incidentId: record.incidentId,
            expiryReason: "retention",
            openIncidentCount: allBefore.length - 1,
            removalStatus: "removed",
            claimsStatus: "released",
            pinRelease: "released",
            completeness: "complete",
          }),
        ),
      );
    },
  );

  it.each(["server", "browser"] as const)(
    "refuses %s recovery when protected owners occupy its low-index reserve without an eligible surplus",
    (kind) => {
      const capacity = occupyProtectedClassReserve(kind);
      const records = listSupportIncidents(stateDir, { readOnly: true });
      const claims = store.listSupportIncidentClaims(stateDir);
      const pins = listActivityLogDirectory(join(stateDir, "logs")).pins;
      expect(
        records.some(
          (record) =>
            record.slotIndex <= capacity &&
            (kind === "browser"
              ? record.fingerprint.op !== "client.diagnostic"
              : record.trigger === "user-report"),
        ),
      ).toBe(true);
      expect(
        recordRegisteredFailureIncident(stateDir, {
          op: kind === "browser" ? "client.diagnostic" : "coding-runtime.readiness.failed",
          errorKind: ACTIVITY_LOG_ERROR_KINDS[capacity + 1],
          correlationId: "protected-class-share",
          ...(kind === "browser" ? { clientKind: "boundary", renderFailure: "window-body" } : {}),
        }),
      ).toEqual({ status: "rejected", reason: "quota-exhausted" });
      expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(records);
      expect(store.listSupportIncidentClaims(stateDir)).toEqual(claims);
      expect(listActivityLogDirectory(join(stateDir, "logs")).pins).toEqual(pins);
      const rejected = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.rejected",
      );
      expect(
        expectActivityLogProof("support.incident.rejected.emitted-line", rejected.at(-1) ?? ""),
      ).toMatchObject({
        level: "warn",
        correlationId: "protected-class-share",
        rejectionReason: "quota-exhausted",
        trigger: "registered-failure",
        openIncidentCount: records.length,
        errorKind: "rate-limited",
        completeness: "partial",
        loss: "event-dropped",
        fingerprintAlgorithm: kind === "browser" ? 2 : 1,
      });
    },
  );

  it("declines a peer-vanished slot claim without inventing a store outage or retiring durable owners", () => {
    const fixture = occupiedClass("server");
    const owner = fixture.candidates[0];
    if (owner === undefined || actualOpen === undefined)
      throw new TypeError("Missing produced fixture");
    const target = join(
      store.supportIncidentDirectory(stateDir),
      supportIncidentSlotClaimFileName(owner.slotIndex),
    );
    let reads = 0;
    vi.mocked(filesystem.openSync).mockImplementation((...args) => {
      if (args[0] === target && ++reads === 2) rmSync(target);
      return actualOpen(...args);
    });
    const before = listSupportIncidents(stateDir, { readOnly: true });
    expect(
      recordRegisteredFailureIncident(stateDir, {
        op: "coding-runtime.readiness.failed",
        errorKind: ACTIVITY_LOG_ERROR_KINDS[fixture.capacity + 1],
        correlationId: "peer-vanished-recovery",
      }),
    ).toEqual({ status: "rejected", reason: "quota-exhausted" });
    expect(reads).toBe(2);
    expect(listSupportIncidents(stateDir, { readOnly: true })).toEqual(before);
  });
});

describe("publication reserve resource recovery", () => {
  it.each(["pin", "fingerprint"] as const)(
    "uses the released slot even when retiring its previous owner's %s is incomplete",
    (fault) => {
      const fixture = occupiedClass("server");
      const oldest = fixture.candidates[0];
      if (oldest === undefined) throw new TypeError("Missing oldest candidate");
      if (fault === "pin")
        vi.spyOn(serverLog, "releaseActivityLogPin").mockReturnValueOnce({
          status: "rejected",
          reason: "removal-failed",
        });
      else
        vi.spyOn(store, "releaseSupportIncidentFingerprintClaim").mockImplementationOnce(() => {
          throw new TypeError("simulated fingerprint-claim cleanup failure");
        });
      const newest = register("server", fixture.capacity + 1);
      expect(newest.slotIndex).toBe(oldest.slotIndex);
      const retained = listSupportIncidents(stateDir, { readOnly: true });
      expect(retained.map((record) => record.incidentId).sort()).toEqual(
        [...fixture.protectedRecords, ...fixture.candidates.slice(2), newest]
          .map((record) => record.incidentId)
          .sort(),
      );
      const expired = persistedActivityLogLines(
        readPersistedActivityLog(stateDir),
        "support.incident.expired",
      );
      const partial = expired.map((line): unknown => JSON.parse(line));
      expect(partial).toContainEqual(
        expect.objectContaining({
          incidentId: oldest.incidentId,
          removalStatus: "removed",
          claimsStatus: fault === "fingerprint" ? "failed" : "released",
          pinRelease: fault === "pin" ? "rejected" : "released",
          completeness: "partial",
        }),
      );
      expect(store.readSupportIncidentSlotClaim(stateDir, newest.slotIndex)?.incidentId).toBe(
        newest.incidentId,
      );
    },
  );

  it("recovers an occupied reserve whose oldest owner's pin was already released", () => {
    const fixture = occupiedClass("server");
    const oldest = fixture.candidates[0];
    if (oldest?.pin.pinId === undefined) throw new TypeError("Missing oldest pin");
    expect(
      serverLog.releaseActivityLogPin(stateDir, {
        pinId: oldest.pin.pinId,
        correlationId: "prior-owner-pin-release",
      }).status,
    ).toBe("released");
    const newest = register("server", fixture.capacity + 1);
    expect(newest.slotIndex).toBe(oldest.slotIndex);
    const expired = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "support.incident.expired",
    );
    expect(expired.map((line): unknown => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        incidentId: oldest.incidentId,
        removalStatus: "removed",
        claimsStatus: "released",
        pinRelease: "not-pinned",
        completeness: "complete",
      }),
    );
  });

  it("does not steal an unreleased slot or evict another owner after a slot cleanup failure", () => {
    const fixture = occupiedClass("server");
    const oldest = fixture.candidates[0];
    if (oldest === undefined) throw new TypeError("Missing oldest candidate");
    vi.spyOn(store, "releaseSupportIncidentSlot").mockImplementationOnce(() => {
      throw new TypeError("simulated slot claim cleanup failure");
    });
    expect(
      recordRegisteredFailureIncident(stateDir, {
        op: "coding-runtime.readiness.failed",
        errorKind: ACTIVITY_LOG_ERROR_KINDS[fixture.capacity + 1],
        correlationId: "unreleased-slot-recovery",
      }),
    ).toEqual({ status: "rejected", reason: "quota-exhausted" });
    expect(store.readSupportIncidentSlotClaim(stateDir, oldest.slotIndex)?.incidentId).toBe(
      oldest.incidentId,
    );
    expect(
      listSupportIncidents(stateDir, { readOnly: true })
        .map((record) => record.incidentId)
        .sort(),
    ).toEqual(
      [...fixture.protectedRecords, ...fixture.candidates.slice(1)]
        .map((record) => record.incidentId)
        .sort(),
    );
  });
});
