// Repository-only controls for resetting the built Activity Log graph consumed by other packages.
// They remain internal and must never become part of the production package entry point.
import { supportIncidentRetentionPolicy } from "../../packages/keiko-activity-log/src/support-incident-retention.js";
import {
  claimSupportIncidentSlot,
  ensureSupportIncidentDirectory,
  listSupportIncidentClaims,
  releaseSupportIncidentSlot,
} from "../../packages/keiko-activity-log/src/support-incident-store.js";

/** Reserve every ordinary slot and the publication reserve with young, non-evictable claims. */
export function occupySupportIncidentRetentionForTests(stateDir: string): number {
  const { capacity } = supportIncidentRetentionPolicy(stateDir);
  if (capacity > 16)
    throw new RangeError(
      "Set a small KEIKO_LOG_RETENTION_BYTES fixture policy before reserving slots",
    );
  ensureSupportIncidentDirectory(stateDir);
  for (let slot = 0; slot <= capacity; slot += 1) {
    const incidentId = slot.toString(16).padStart(32, "0");
    if (!claimSupportIncidentSlot(stateDir, slot, incidentId)) {
      throw new TypeError("Fixture could not reserve diagnostic retention bytes");
    }
  }
  return capacity;
}

export function supportIncidentReservationsForTests(stateDir: string): readonly string[] {
  return listSupportIncidentClaims(stateDir)
    .map((claim) => `${claim.fileName}:${claim.incidentId ?? "unpublished"}`)
    .sort();
}

export function releaseSupportIncidentReservationForTests(stateDir: string, slot: number): void {
  releaseSupportIncidentSlot(stateDir, slot);
}

export { resetActivityLogReadinessForTests } from "../../packages/keiko-activity-log/dist/activity-log-readiness.js";
export {
  installActivityLogTestWriter,
  resetServerLogger,
} from "../../packages/keiko-activity-log/dist/server-logger.js";
export { resetServerLogFailureNotices } from "../../packages/keiko-activity-log/dist/server-log.js";
export {
  drainSupportIncidentCandidates,
  setSupportIncidentTriggerForTests,
} from "../../packages/keiko-activity-log/dist/support-incident.js";
