import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ReleaseImpactRemediation,
  UpdateCompatibilityScan,
  UpdateHealthState,
  UpdateRecoverySnapshot,
  UpdateReleaseImpactInput,
  UpdateRuntimeAuditEvent,
  UpdateRuntimeEventType,
  UpdateRuntimeState,
  UpdateStateStore,
  UpdateStoreHealth,
} from "@oscharko-dev/keiko-contracts";
import {
  UPDATE_HEALTH_LABELS,
  UPDATE_LOCAL_STATE_SCHEMA_VERSION,
  UPDATE_STATE_STORES,
} from "@oscharko-dev/keiko-contracts";
import {
  CATEGORY_STORE,
  UPDATE_DIR,
  canonicalStore,
  scanStateDir,
  type StateScan,
} from "./update-local-state-scan.js";
import {
  repairStateStores,
  type UpdateLocalStateRepairResult,
} from "./update-local-state-repair.js";
import {
  createSnapshotManifest,
  failedSnapshot,
  pruneOlderSnapshots,
  retainedWarning,
  snapshotDir,
  snapshotManifestPath,
  validateSnapshot,
} from "./update-local-state-snapshot.js";

interface AuditEventRecord {
  readonly event: UpdateRuntimeAuditEvent;
  readonly warning?: string | undefined;
}

interface StoreHealthDecision {
  readonly health: UpdateHealthState;
  readonly message: string;
}

interface ManagerContext {
  readonly stateDir: string;
  readonly now: () => number;
  readonly idFactory: () => string;
  readonly remediationLeaseStaleMs: number;
  readonly pidAlive: (pid: number) => boolean;
}

type AuditEventInput = Partial<
  Omit<UpdateRuntimeAuditEvent, "schemaVersion" | "eventId" | "type" | "occurredAt">
>;

export interface CreateUpdateSnapshotInput {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly impact?: UpdateReleaseImpactInput | undefined;
}

export interface UpdateLocalStateManager {
  readonly scanCompatibility: (impact?: UpdateReleaseImpactInput) => UpdateCompatibilityScan;
  readonly createRecoverySnapshot: (input: CreateUpdateSnapshotInput) => UpdateRecoverySnapshot;
  readonly validateRecoverySnapshot: (snapshotId: string) => boolean;
  readonly repairStores: (stores: readonly UpdateStateStore[]) => UpdateLocalStateRepairResult;
  readonly readRuntimeState: () => UpdateRuntimeState;
  readonly writeRuntimeState: (state: UpdateRuntimeState) => UpdateRuntimeState;
  readonly acquireRemediationLease: (actionId: string) => (() => void) | undefined;
  readonly recordAuditEvent: (
    type: UpdateRuntimeEventType,
    input?: AuditEventInput,
  ) => AuditEventRecord;
}

export interface UpdateLocalStateManagerOptions {
  readonly stateDir: string;
  readonly now?: (() => number) | undefined;
  readonly idFactory?: (() => string) | undefined;
  readonly remediationLeaseStaleMs?: number | undefined;
  readonly pidAlive?: ((pid: number) => boolean) | undefined;
}

export type { UpdateLocalStateRepairResult } from "./update-local-state-repair.js";

const RUNTIME_STATE_FILE = "runtime-state.json";
const AUDIT_LOG_FILE = "update-audit.jsonl";
const REMEDIATION_LEASE_DIR = "remediation-leases";
const DEFAULT_REMEDIATION_LEASE_STALE_MS = 24 * 60 * 60 * 1_000;
const SNAPSHOT_FILE_MODE = 0o600;
const SNAPSHOT_DIR_MODE = 0o700;

const STORE_LABELS: Readonly<Record<UpdateStateStore, string>> = {
  "ui-layout": "UI layout",
  "server-runtime": "Server runtime state",
  "durable-config": "Durable config",
  evidence: "Evidence and audit records",
  "memory-vault": "Memory Vault",
  "local-knowledge": "Local Knowledge",
  "workspace-references": "Workspace filesystem references",
  "package-install": "Package/install state",
};

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: SNAPSHOT_DIR_MODE });
  try {
    chmodSync(path, SNAPSHOT_DIR_MODE);
  } catch {
    // POSIX modes are best-effort on non-POSIX filesystems.
  }
}

function writePrivate(path: string, content: string): void {
  mkdirPrivate(dirname(path));
  writeFileSync(path, content, { encoding: "utf8", mode: SNAPSHOT_FILE_MODE });
  try {
    chmodSync(path, SNAPSHOT_FILE_MODE);
  } catch {
    // POSIX modes are best-effort on non-POSIX filesystems.
  }
}

function jsonRead<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function affectedStores(impact: UpdateReleaseImpactInput | undefined): Set<UpdateStateStore> {
  const out = new Set<UpdateStateStore>();
  for (const store of impact?.affectedStateStores ?? []) {
    const canonical = canonicalStore(store);
    if (canonical !== undefined) out.add(canonical);
  }
  for (const entry of impact?.stateImpact ?? []) {
    const canonical = canonicalStore(entry.store);
    if (canonical !== undefined) out.add(canonical);
  }
  return out;
}

function remediationFor(
  store: UpdateStateStore,
  impact: UpdateReleaseImpactInput | undefined,
): ReleaseImpactRemediation {
  const direct = impact?.stateImpact?.find(
    (entry) => canonicalStore(entry.store) === store,
  )?.remediation;
  return direct ?? impact?.remediation ?? "no-action-required";
}

function healthRank(health: UpdateHealthState): number {
  return {
    "unavailable-until-fixed": 4,
    "manual-review-required": 3,
    "needs-action": 2,
    ready: 1,
    "not-affected": 0,
  }[health];
}

function affectedStateSet(impact: UpdateReleaseImpactInput | undefined): Set<UpdateStateStore> {
  return affectedStores(impact);
}

function retainedForStore(scan: StateScan, store: UpdateStateStore): StateScan["retained"] {
  return scan.retained.filter(
    (node) => node.owned && node.category !== undefined && CATEGORY_STORE[node.category] === store,
  );
}

function actionRequiredForStore(
  store: UpdateStateStore,
  impact: UpdateReleaseImpactInput | undefined,
  affected: boolean,
): boolean {
  const direct = impact?.stateImpact?.find((entry) => canonicalStore(entry.store) === store);
  return direct?.userActionRequired ?? (affected && impact?.userActionRequired === true);
}

function decideStoreHealth(input: {
  readonly affected: boolean;
  readonly scanStatus: StateScan["status"];
  readonly retainedCount: number;
  readonly userActionRequired: boolean;
}): StoreHealthDecision {
  if (!input.affected) {
    return { health: "not-affected", message: "No reviewed update impact for this store." };
  }
  if (input.scanStatus !== "directory") {
    return {
      health: "manual-review-required",
      message: "Runtime state root is unavailable or unsafe to inspect.",
    };
  }
  if (input.retainedCount > 0) {
    return {
      health: "manual-review-required",
      message: "A Keiko-owned path is a symlink, hardlink, or unsupported entry and needs review.",
    };
  }
  if (input.userActionRequired) {
    return {
      health: "needs-action",
      message: "Reviewed release impact requires a local remediation action.",
    };
  }
  return { health: "ready", message: "Store can participate in the governed update path." };
}

function storeHealth(
  store: UpdateStateStore,
  scan: StateScan,
  impact: UpdateReleaseImpactInput | undefined,
): UpdateStoreHealth {
  const affected = affectedStateSet(impact).has(store);
  const files = scan.files.filter((node) => CATEGORY_STORE[node.category] === store);
  const storeRetained = retainedForStore(scan, store);
  const snapshotEligible = affected || files.length > 0 || storeRetained.length > 0;
  const remediation = remediationFor(store, impact);
  const userActionRequired = actionRequiredForStore(store, impact, affected);
  const decision = decideStoreHealth({
    affected,
    scanStatus: scan.status,
    retainedCount: storeRetained.length,
    userActionRequired,
  });
  return {
    store,
    label: STORE_LABELS[store],
    health: decision.health,
    healthLabel: UPDATE_HEALTH_LABELS[decision.health],
    affected,
    remediation,
    userActionRequired,
    snapshotEligible,
    ownedArtifactCount: files.length,
    retainedEntryCount: storeRetained.length,
    message: decision.message,
  };
}

function runtimeStatePath(stateDir: string): string {
  return join(stateDir, UPDATE_DIR, RUNTIME_STATE_FILE);
}

function auditLogPath(stateDir: string): string {
  return join(stateDir, UPDATE_DIR, AUDIT_LOG_FILE);
}

interface RemediationLeaseRecord {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

function remediationLeasePath(stateDir: string, actionId: string): string {
  const digest = createHash("sha256").update(actionId, "utf8").digest("hex");
  return join(stateDir, UPDATE_DIR, REMEDIATION_LEASE_DIR, `${digest}.json`);
}

function parseRemediationLease(value: unknown): RemediationLeaseRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Number.isInteger(record.pid) &&
    typeof record.token === "string" &&
    typeof record.acquiredAt === "string" &&
    Number.isFinite(Date.parse(record.acquiredAt))
    ? { pid: record.pid as number, token: record.token, acquiredAt: record.acquiredAt }
    : undefined;
}

function readRemediationLease(path: string): RemediationLeaseRecord | undefined {
  try {
    return parseRemediationLease(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function remediationLeaseStaleMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_REMEDIATION_LEASE_STALE_MS;
}

function remediationLeaseAgeMs(
  path: string,
  record: RemediationLeaseRecord | undefined,
  now: () => number,
): number | undefined {
  try {
    const timestamp = record === undefined ? statSync(path).mtimeMs : Date.parse(record.acquiredAt);
    return Math.max(0, now() - timestamp);
  } catch {
    return undefined;
  }
}

function remediationLeaseReclaimable(
  path: string,
  record: RemediationLeaseRecord | undefined,
  context: ManagerContext,
): boolean {
  if (record !== undefined && !context.pidAlive(record.pid)) return true;
  const ageMs = remediationLeaseAgeMs(path, record, context.now);
  return ageMs !== undefined && ageMs >= context.remediationLeaseStaleMs;
}

function discardRemediationLease(path: string, malformed: boolean, now: () => number): boolean {
  try {
    if (malformed) {
      const suffix = new Date(now()).toISOString().replace(/[:.]/g, "-");
      renameSync(path, `${path}.corrupt.${suffix}`);
    } else {
      unlinkSync(path);
    }
    return true;
  } catch {
    return false;
  }
}

function releaseRemediationLease(path: string, token: string): void {
  const claimedPath = `${path}.release.${token}`;
  try {
    // Atomically remove the canonical name before inspecting ownership. A replacement lease may be
    // created after this rename, but it can never be unlinked by this older release callback.
    renameSync(path, claimedPath);
  } catch {
    return;
  }
  if (readRemediationLease(claimedPath)?.token === token) {
    try {
      unlinkSync(claimedPath);
    } catch {
      // A settled lease may already have been removed by shutdown cleanup.
    }
    return;
  }
  try {
    // Restore a lease claimed by the wrong callback only when the canonical path is still free.
    // `link` is the no-replace operation that `rename` does not provide portably.
    linkSync(claimedPath, path);
    unlinkSync(claimedPath);
  } catch {
    // A newer canonical lease wins. Preserve the displaced record for diagnosis instead of
    // deleting a lease this callback does not own.
  }
}

function acquireRemediationLease(
  context: ManagerContext,
  actionId: string,
): (() => void) | undefined {
  const path = remediationLeasePath(context.stateDir, actionId);
  mkdirPrivate(dirname(path));
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(
        path,
        JSON.stringify({ pid: process.pid, token, acquiredAt: nowIso(context.now) }),
        {
          encoding: "utf8",
          flag: "wx",
          mode: SNAPSHOT_FILE_MODE,
        },
      );
      return (): void => {
        releaseRemediationLease(path, token);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const existing = readRemediationLease(path);
      if (!remediationLeaseReclaimable(path, existing, context)) return undefined;
      if (!discardRemediationLease(path, existing === undefined, context.now)) {
        return undefined;
      }
    }
  }
  return undefined;
}

function overallHealth(stores: readonly UpdateStoreHealth[]): UpdateHealthState {
  return stores.reduce<UpdateHealthState>(
    (worst, item) => (healthRank(item.health) > healthRank(worst) ? item.health : worst),
    "not-affected",
  );
}

function scanCompatibility(
  context: ManagerContext,
  impact: UpdateReleaseImpactInput | undefined,
): UpdateCompatibilityScan {
  const scan = scanStateDir(context.stateDir);
  const stores = UPDATE_STATE_STORES.map((store) => storeHealth(store, scan, impact));
  const warning = retainedWarning(scan);
  return {
    schemaVersion: UPDATE_LOCAL_STATE_SCHEMA_VERSION,
    scannedAt: nowIso(context.now),
    stateDirStatus: scan.status,
    stores,
    overallHealth: overallHealth(stores),
    warnings: warning === undefined ? [] : [warning],
  };
}

function createRecoverySnapshot(
  context: ManagerContext,
  input: CreateUpdateSnapshotInput,
): UpdateRecoverySnapshot {
  const scan = scanStateDir(context.stateDir);
  const snapshotId = context.idFactory();
  const createdAt = nowIso(context.now);
  const stores = UPDATE_STATE_STORES.map((store) => storeHealth(store, scan, input.impact));
  const health = overallHealth(stores);
  if (scan.status === "symlink" || scan.status === "not-directory") {
    return failedSnapshot({ request: input, snapshotId, createdAt, scan, health });
  }
  mkdirPrivate(snapshotDir(context.stateDir, snapshotId));
  const snapshot = createSnapshotManifest({
    request: input,
    snapshotId,
    createdAt,
    scan,
    stores,
    overallHealth: health,
  });
  writePrivate(
    snapshotManifestPath(context.stateDir, snapshotId),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  if (validateSnapshot(context.stateDir, snapshotId)) {
    pruneOlderSnapshots(context.stateDir, snapshotId);
  }
  return snapshot;
}

function readRuntimeState(context: ManagerContext): UpdateRuntimeState {
  return jsonRead<UpdateRuntimeState>(runtimeStatePath(context.stateDir), {
    schemaVersion: UPDATE_LOCAL_STATE_SCHEMA_VERSION,
    updatedAt: nowIso(context.now),
    remediations: [],
    warnings: [],
  });
}

function writeRuntimeState(context: ManagerContext, state: UpdateRuntimeState): UpdateRuntimeState {
  const next: UpdateRuntimeState = {
    ...state,
    schemaVersion: UPDATE_LOCAL_STATE_SCHEMA_VERSION,
    updatedAt: nowIso(context.now),
  };
  writePrivate(runtimeStatePath(context.stateDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function recordAuditEvent(
  context: ManagerContext,
  type: UpdateRuntimeEventType,
  input: AuditEventInput = {},
): AuditEventRecord {
  const event: UpdateRuntimeAuditEvent = {
    schemaVersion: UPDATE_LOCAL_STATE_SCHEMA_VERSION,
    eventId: context.idFactory(),
    type,
    occurredAt: nowIso(context.now),
    ...input,
  };
  try {
    mkdirPrivate(dirname(auditLogPath(context.stateDir)));
    writeFileSync(auditLogPath(context.stateDir), `${JSON.stringify(event)}\n`, {
      flag: "a",
      mode: SNAPSHOT_FILE_MODE,
    });
    return { event };
  } catch {
    return { event, warning: "Update audit event could not be persisted." };
  }
}

function repairStores(
  context: ManagerContext,
  stores: readonly UpdateStateStore[],
): UpdateLocalStateRepairResult {
  return repairStateStores(scanStateDir(context.stateDir), stores);
}

export function createUpdateLocalStateManager(
  options: UpdateLocalStateManagerOptions,
): UpdateLocalStateManager {
  const context: ManagerContext = {
    stateDir: options.stateDir,
    now: options.now ?? Date.now,
    idFactory: options.idFactory ?? randomUUID,
    remediationLeaseStaleMs: remediationLeaseStaleMs(options.remediationLeaseStaleMs),
    pidAlive: options.pidAlive ?? processIsAlive,
  };
  return {
    scanCompatibility: (impact): UpdateCompatibilityScan => scanCompatibility(context, impact),
    createRecoverySnapshot: (input): UpdateRecoverySnapshot =>
      createRecoverySnapshot(context, input),
    validateRecoverySnapshot: (snapshotId): boolean =>
      validateSnapshot(context.stateDir, snapshotId),
    repairStores: (stores): UpdateLocalStateRepairResult => repairStores(context, stores),
    readRuntimeState: (): UpdateRuntimeState => readRuntimeState(context),
    writeRuntimeState: (state): UpdateRuntimeState => writeRuntimeState(context, state),
    acquireRemediationLease: (actionId): (() => void) | undefined =>
      acquireRemediationLease(context, actionId),
    recordAuditEvent: (type, input): AuditEventRecord => recordAuditEvent(context, type, input),
  };
}
