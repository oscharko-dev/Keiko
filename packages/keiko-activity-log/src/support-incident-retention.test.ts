import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  completePreparedSupportIncident,
  dismissSupportIncident,
  drainSupportIncidentCandidates,
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
  ACTIVITY_LOG_ERROR_KINDS,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  createDesktopSupportReport,
  prepareManualSupportReportIncident,
} from "./reader/support-desktop-report.js";
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
      MAX_ACTIVITY_LOG_PINS,
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
    const actions = persistedActivityLogLines(text, "support.incident.dismissed").map(
      (line) => JSON.parse(line) as unknown,
    );
    expect(actions).toContainEqual(
      expect.objectContaining({ correlationId: "new-retirement-request" }),
    );
    const analyzed = analyzeSupportReport(
      createDesktopSupportReport(stateDir, "original-retirement").reportJson,
    );
    expect(analyzed.analysis.evidence.classification).toBe("supported");
    expect(analyzed.analysis.sufficiency.classes.flatMap((entry) => entry.reasons)).not.toContain(
      "lifecycle-start-missing",
    );
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
    for (let index = 1; index < MAX_ACTIVITY_LOG_PINS; index += 1)
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
