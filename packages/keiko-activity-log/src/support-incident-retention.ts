import { join } from "node:path";
import {
  ACTIVITY_LOG_DIRECTORY_NAME,
  MAX_SUPPORT_INCIDENT_RECORD_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  readActivityLogPolicyRecord,
  resolveActivityLogStorageConfig,
} from "./activity-log-store.js";
import type { ServerLogEnv } from "./log-level.js";

// One maximal record and its two opaque owning-id claims reserve bytes atomically through the
// existing exclusive-create slot. Filesystem allocation overhead follows the store's byte policy.
const CANDIDATE_RESERVATION_BYTES = MAX_SUPPORT_INCIDENT_RECORD_BYTES + 2 * 32;
export interface SupportIncidentRetentionPolicy {
  readonly capacity: number;
  readonly automaticCapacity: number;
  readonly browserCapacity: number;
  readonly retentionBytes: number;
}

/** Reuses the one cooperating-process Activity Log policy; no independent count configuration. */
export function supportIncidentRetentionPolicy(
  stateDir: string,
  env: ServerLogEnv = process.env,
): SupportIncidentRetentionPolicy {
  const directory = join(stateDir, ACTIVITY_LOG_DIRECTORY_NAME);
  const policy =
    readActivityLogPolicyRecord(directory, directory, { requireReadable: true }) ??
    resolveActivityLogStorageConfig(env);
  const capacity = Math.floor(policy.retentionBytes / CANDIDATE_RESERVATION_BYTES);
  return {
    capacity,
    automaticCapacity: Math.floor((capacity * 3) / 4),
    browserCapacity: Math.floor(capacity / 4),
    retentionBytes: policy.retentionBytes,
  };
}
