import { chmodSync, statSync } from "node:fs";
import type { UpdateStateStore } from "@oscharko-dev/keiko-contracts";
import { CATEGORY_STORE, type StateScan } from "./update-local-state-scan.js";

export interface UpdateLocalStateRepairResult {
  readonly status: "completed" | "manual-review-required" | "not-applicable";
  readonly repairedArtifactCount: number;
  readonly retainedEntryCount: number;
  readonly warnings: readonly string[];
}

const SNAPSHOT_FILE_MODE = 0o600;
const SNAPSHOT_DIR_MODE = 0o700;

function chmodIfNeeded(path: string, mode: number): boolean {
  if (process.platform === "win32") return false;
  const current = statSync(path).mode & 0o777;
  if (current === mode) return false;
  chmodSync(path, mode);
  return true;
}

function nodeStore(scanStore: UpdateStateStore, stores: ReadonlySet<UpdateStateStore>): boolean {
  return stores.has(scanStore);
}

function emptyRepairResult(): UpdateLocalStateRepairResult {
  return {
    status: "not-applicable",
    repairedArtifactCount: 0,
    retainedEntryCount: 0,
    warnings: [],
  };
}

function blockedRepairResult(): UpdateLocalStateRepairResult {
  return {
    status: "manual-review-required",
    repairedArtifactCount: 0,
    retainedEntryCount: 0,
    warnings: ["Runtime state root is unavailable or unsafe to repair."],
  };
}

function retainedForRequestedStores(
  scan: StateScan,
  requested: ReadonlySet<UpdateStateStore>,
): StateScan["retained"] {
  return scan.retained.filter(
    (node) =>
      node.owned &&
      node.category !== undefined &&
      nodeStore(CATEGORY_STORE[node.category], requested),
  );
}

function repairNodeModes(scan: StateScan, requested: ReadonlySet<UpdateStateStore>): number {
  let repairedArtifactCount = 0;
  for (const directory of scan.directories) {
    if (nodeStore(CATEGORY_STORE[directory.category], requested)) {
      repairedArtifactCount += chmodIfNeeded(directory.absPath, SNAPSHOT_DIR_MODE) ? 1 : 0;
    }
  }
  for (const file of scan.files) {
    if (nodeStore(CATEGORY_STORE[file.category], requested)) {
      repairedArtifactCount += chmodIfNeeded(file.absPath, SNAPSHOT_FILE_MODE) ? 1 : 0;
    }
  }
  return repairedArtifactCount;
}

export function repairStateStores(
  scan: StateScan,
  stores: readonly UpdateStateStore[],
): UpdateLocalStateRepairResult {
  if (stores.length === 0) return emptyRepairResult();
  const requested = new Set(stores);
  if (scan.status !== "directory") return blockedRepairResult();
  const retained = retainedForRequestedStores(scan, requested);
  const repairedArtifactCount = repairNodeModes(scan, requested);
  const warnings =
    process.platform === "win32"
      ? ["POSIX permission repair is not applicable on Windows; host ACLs govern access."]
      : [];
  return {
    status: retained.length > 0 ? "manual-review-required" : "completed",
    repairedArtifactCount,
    retainedEntryCount: retained.length,
    warnings,
  };
}
