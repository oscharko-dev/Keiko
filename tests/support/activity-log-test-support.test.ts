import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { supportIncidentSlotClaimFileName } from "@oscharko-dev/keiko-contracts/runtime/observability";
import * as incidentStore from "../../packages/keiko-activity-log/src/support-incident-store.js";
import {
  recordUserReportedIncident,
  dismissSupportIncident,
} from "../../packages/keiko-activity-log/src/support-incident.js";
import { closeFileServerLogSinks } from "../../packages/keiko-activity-log/src/server-log.js";
import { occupySupportIncidentRetentionForTests } from "./activity-log-test-support.js";

const roots: string[] = [];
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-retention-fixture-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  closeFileServerLogSinks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("rejects an unbounded fixture policy before making incident files", () => {
  vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", undefined);
  const claim = vi.spyOn(incidentStore, "claimSupportIncidentSlot").mockReturnValue(true);
  const root = fixtureRoot();
  expect(() => occupySupportIncidentRetentionForTests(root)).toThrow(RangeError);
  expect(claim).not.toHaveBeenCalled();
  expect(readdirSync(root)).toEqual([]);
});
it("reserves the real small fixture policy capacity", () => {
  vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
  const root = fixtureRoot();
  const capacity = occupySupportIncidentRetentionForTests(root);
  expect(capacity).toBeGreaterThan(0);
  expect(incidentStore.listSupportIncidentClaims(root)).toHaveLength(capacity + 1);
  expect(existsSync(root)).toBe(true);
});

it("proves real quota refusal and preserves all fixture claims until explicit release", () => {
  vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
  const root = fixtureRoot();
  const capacity = occupySupportIncidentRetentionForTests(root);
  const before = incidentStore.listSupportIncidentClaims(root);
  expect(
    before.some((entry) => entry.fileName === supportIncidentSlotClaimFileName(capacity)),
  ).toBe(true);
  expect(recordUserReportedIncident(root)).toEqual({
    status: "rejected",
    reason: "quota-exhausted",
  });
  expect(incidentStore.listSupportIncidentClaims(root)).toEqual(before);
  incidentStore.releaseSupportIncidentSlot(root, capacity);
  expect(recordUserReportedIncident(root)).toEqual({
    status: "rejected",
    reason: "quota-exhausted",
  });
  incidentStore.releaseSupportIncidentSlot(root, capacity - 1);
  const created = recordUserReportedIncident(root);
  if (created.status !== "created")
    throw new TypeError("Expected admission after two slots were released");
  expect(dismissSupportIncident(root, created.incidentId)).toBe("dismissed");
  const remaining = incidentStore.listSupportIncidentClaims(root);
  const released = new Set([
    supportIncidentSlotClaimFileName(capacity),
    supportIncidentSlotClaimFileName(capacity - 1),
  ]);
  expect(remaining).toEqual(before.filter((entry) => !released.has(entry.fileName)));
});
