import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  UpdateHealthState,
  UpdateRecoverySnapshot,
  UpdateRecoverySnapshotEntry,
  UpdateStoreHealth,
} from "@oscharko-dev/keiko-contracts";
import {
  RELEASE_IMPACT_REMEDIATIONS,
  UPDATE_HEALTH_LABELS,
  UPDATE_LOCAL_STATE_SCHEMA_VERSION,
  UPDATE_STATE_STORES,
} from "@oscharko-dev/keiko-contracts";
import { UPDATE_DIR, type StateScan } from "./update-local-state-scan.js";

const SNAPSHOT_DIR = "snapshots";
const MANIFEST_FILE = "manifest.json";
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const STATE_DIR_STATUSES = ["absent", "directory", "symlink", "not-directory"] as const;

interface SnapshotVersionInput {
  readonly fromVersion: string;
  readonly toVersion: string;
}

export function retainedWarning(scan: StateScan): string | undefined {
  const ownedRetained = scan.retained.filter((node) => node.owned).length;
  if (ownedRetained === 0) return undefined;
  return `${String(ownedRetained)} Keiko-owned runtime state entr${ownedRetained === 1 ? "y is" : "ies are"} excluded from update recovery manifests because unsupported filesystem entries require review.`;
}

function snapshotRoot(stateDir: string): string {
  return join(stateDir, UPDATE_DIR, SNAPSHOT_DIR);
}

export function snapshotDir(stateDir: string, snapshotId: string): string {
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) throw new Error("invalid snapshot id");
  return join(snapshotRoot(stateDir), snapshotId);
}

export function snapshotManifestPath(stateDir: string, snapshotId: string): string {
  return join(snapshotDir(stateDir, snapshotId), MANIFEST_FILE);
}

function jsonRead(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasSnapshotEntryEnums(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.store === "string" &&
    (UPDATE_STATE_STORES as readonly string[]).includes(entry.store) &&
    typeof entry.health === "string" &&
    Object.hasOwn(UPDATE_HEALTH_LABELS, entry.health) &&
    typeof entry.remediation === "string" &&
    (RELEASE_IMPACT_REMEDIATIONS as readonly string[]).includes(entry.remediation)
  );
}

function hasSnapshotEntryFlags(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.affected === "boolean" &&
    typeof entry.userActionRequired === "boolean" &&
    typeof entry.snapshotEligible === "boolean"
  );
}

function hasSnapshotEntryCounts(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.ownedArtifactCount === "number" && typeof entry.retainedEntryCount === "number"
  );
}

function isSnapshotEntry(value: unknown): value is UpdateRecoverySnapshotEntry {
  if (!isRecord(value)) return false;
  return (
    hasSnapshotEntryEnums(value) && hasSnapshotEntryFlags(value) && hasSnapshotEntryCounts(value)
  );
}

function hasSnapshotManifestStrings(value: Record<string, unknown>, snapshotId: string): boolean {
  return (
    value.snapshotId === snapshotId &&
    typeof value.createdAt === "string" &&
    typeof value.fromVersion === "string" &&
    typeof value.toVersion === "string"
  );
}

function hasSnapshotManifestEnums(value: Record<string, unknown>): boolean {
  return (
    typeof value.stateDirStatus === "string" &&
    (STATE_DIR_STATUSES as readonly string[]).includes(value.stateDirStatus) &&
    typeof value.overallHealth === "string" &&
    Object.hasOwn(UPDATE_HEALTH_LABELS, value.overallHealth)
  );
}

function isSnapshotManifest(value: unknown, snapshotId: string): value is UpdateRecoverySnapshot {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === UPDATE_LOCAL_STATE_SCHEMA_VERSION &&
    value.status === "created" &&
    hasSnapshotManifestStrings(value, snapshotId) &&
    hasSnapshotManifestEnums(value) &&
    Array.isArray(value.entries) &&
    value.entries.every(isSnapshotEntry)
  );
}

function readSnapshotManifest(
  stateDir: string,
  snapshotId: string,
): UpdateRecoverySnapshot | undefined {
  const manifest = jsonRead(snapshotManifestPath(stateDir, snapshotId));
  return isSnapshotManifest(manifest, snapshotId) ? manifest : undefined;
}

export function validateSnapshot(stateDir: string, snapshotId: string): boolean {
  return readSnapshotManifest(stateDir, snapshotId) !== undefined;
}

export function pruneOlderSnapshots(stateDir: string, keepId: string): void {
  const root = snapshotRoot(stateDir);
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (name === keepId || !SNAPSHOT_ID_PATTERN.test(name)) continue;
    if (readSnapshotManifest(stateDir, name) !== undefined) {
      rmSync(snapshotDir(stateDir, name), { recursive: true, force: true });
    }
  }
}

export function failedSnapshot(input: {
  readonly request: SnapshotVersionInput;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly scan: StateScan;
  readonly health: UpdateHealthState;
}): UpdateRecoverySnapshot {
  return {
    schemaVersion: UPDATE_LOCAL_STATE_SCHEMA_VERSION,
    snapshotId: input.snapshotId,
    createdAt: input.createdAt,
    fromVersion: input.request.fromVersion,
    toVersion: input.request.toVersion,
    status: "failed",
    stateDirStatus: input.scan.status,
    overallHealth: input.health,
    entries: [],
    warnings: ["Runtime state root is unsafe to snapshot."],
  };
}

function snapshotEntries(
  stores: readonly UpdateStoreHealth[],
): readonly UpdateRecoverySnapshotEntry[] {
  return stores
    .filter(
      (store) => store.affected || store.ownedArtifactCount > 0 || store.retainedEntryCount > 0,
    )
    .map((store) => ({
      store: store.store,
      health: store.health,
      affected: store.affected,
      remediation: store.remediation,
      userActionRequired: store.userActionRequired,
      snapshotEligible: store.snapshotEligible,
      ownedArtifactCount: store.ownedArtifactCount,
      retainedEntryCount: store.retainedEntryCount,
    }));
}

export function createSnapshotManifest(input: {
  readonly request: SnapshotVersionInput;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly scan: StateScan;
  readonly stores: readonly UpdateStoreHealth[];
  readonly overallHealth: UpdateHealthState;
}): UpdateRecoverySnapshot {
  const retained = retainedWarning(input.scan);
  return {
    schemaVersion: UPDATE_LOCAL_STATE_SCHEMA_VERSION,
    snapshotId: input.snapshotId,
    createdAt: input.createdAt,
    fromVersion: input.request.fromVersion,
    toVersion: input.request.toVersion,
    status: "created",
    stateDirStatus: input.scan.status,
    overallHealth: input.overallHealth,
    entries: snapshotEntries(input.stores),
    warnings: retained === undefined ? [] : [retained],
  };
}
