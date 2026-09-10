import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicPublishRename } from "@oscharko-dev/keiko-security/fs-atomic-rename";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import type {
  ReleaseImpactRemediation,
  UpdateActivationWalState,
  UpdateCompatibilityScan,
  UpdateHealthState,
  UpdateRecoverySnapshot,
  UpdateReleaseImpactInput,
  UpdateRuntimeAuditEvent,
  UpdateRuntimeEventType,
  UpdateRuntimeState,
  UpdateSession,
  UpdateStateStore,
  UpdateStoreHealth,
} from "@oscharko-dev/keiko-contracts";
import {
  UPDATE_HEALTH_LABELS,
  UPDATE_ACTIVATION_WAL_CHECKPOINTS,
  UPDATE_LOCAL_STATE_SCHEMA_VERSION,
  UPDATE_REMEDIATION_STATUSES,
  UPDATE_RUNTIME_RECOVERY_STATUSES,
  UPDATE_RUNTIME_WARNING_CODES,
  UPDATE_STATE_STORES,
} from "@oscharko-dev/keiko-contracts/runtime/update-local-state";
import {
  UPDATE_CANCELLATION_CUTOFFS,
  UPDATE_INSTALL_MODE_KINDS,
  UPDATE_INSTALL_PACKAGE_MANAGERS,
  UPDATE_LIFECYCLE_PHASES,
  UPDATE_PORTABLE_ACTIVATION_STATUSES,
  UPDATE_PORTABLE_SIDECAR_FAILURE_CODES,
  UPDATE_PORTABLE_SIDECAR_VERIFICATION_STATUSES,
  UPDATE_PORTABLE_STAGING_STATUSES,
  UPDATE_PORTABLE_TARGETS,
  UPDATE_SESSION_FAILURE_REASONS,
  UPDATE_SESSION_PHASES,
  UPDATE_SESSION_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts/runtime/update-session";
import { UPDATE_CANDIDATE_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/update-candidate";
import { RELEASE_IMPACT_REMEDIATIONS } from "@oscharko-dev/keiko-contracts/release-impact";
import {
  CATEGORY_STORE,
  UPDATE_DIR,
  canonicalStore,
  incompleteScanWarning,
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
import { publishFileWithoutReplacement } from "./publish-file-without-replacement.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "./diagnostics-log.js";
import {
  isOptionalProcessIdentity,
  processIdentityField,
  PROCESS_START_IDENTITY,
} from "./process-identity.js";
import { digestUpdateCandidate } from "./update-candidate-authority.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";

interface AuditEventRecord {
  readonly event: UpdateRuntimeAuditEvent;
  readonly warning?: string | undefined;
}

interface StoreHealthDecision {
  readonly health: UpdateHealthState;
  readonly message: string;
}

const RESTART_REQUIRED_LIFECYCLE_PHASES: ReadonlySet<string> = new Set([
  "handoff-pending",
  "verifying-relaunch",
  "cleanup-pending",
  "remediation-required",
  "recovery-required",
]);

interface ManagerContext {
  readonly stateDir: string;
  readonly now: () => number;
  readonly idFactory: () => string;
  readonly remediationLeaseStaleMs: number;
  readonly pidAlive: (pid: number) => boolean;
  readonly processIdentity: string;
  readonly activityLog: SecurityLogSink | undefined;
  readonly diagnostics: ServerDiagnosticSink | undefined;
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
  readonly inspectRuntimeState: () => UpdateRuntimeStateInspection;
  readonly writeRuntimeState: (state: UpdateRuntimeState) => UpdateRuntimeState;
  readonly acquireRemediationLease: (actionId: string) => (() => void) | undefined;
  readonly recordAuditEvent: (
    type: UpdateRuntimeEventType,
    input?: AuditEventInput,
  ) => AuditEventRecord;
}

export type UpdateRuntimeStateInspection =
  | {
      readonly status: "ok";
      readonly state: UpdateRuntimeState;
      readonly contentSha256: string;
    }
  | { readonly status: "migrated" | "missing"; readonly state: UpdateRuntimeState }
  | { readonly status: "corrupt" | "incompatible" | "unwritable" };

export class UpdateRuntimeStateError extends Error {
  public constructor(public readonly kind: "corrupt" | "incompatible" | "unwritable") {
    super(`Update runtime state is ${kind}.`);
    this.name = "UpdateRuntimeStateError";
  }
}

function readBoundedRuntimeState(descriptor: number, expectedSize: number): Buffer | undefined {
  const content = Buffer.allocUnsafe(expectedSize + 1);
  let offset = 0;
  while (offset < content.length) {
    const count = readSync(descriptor, content, offset, content.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  return offset === expectedSize ? content.subarray(0, offset) : undefined;
}

export interface UpdateLocalStateManagerOptions {
  readonly stateDir: string;
  readonly now?: (() => number) | undefined;
  readonly idFactory?: (() => string) | undefined;
  readonly remediationLeaseStaleMs?: number | undefined;
  readonly pidAlive?: ((pid: number) => boolean) | undefined;
  readonly processIdentity?: string | undefined;
  readonly activityLog?: SecurityLogSink | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

export type { UpdateLocalStateRepairResult } from "./update-local-state-repair.js";

const RUNTIME_STATE_FILE = "runtime-state.json";
const PORTABLE_HANDOFF_DIR = "handoff";
const PORTABLE_ACTIVATION_RECOVERY_FILE = "portable-activation-recovery.json";
const UPDATE_SESSION_LOCK_FILE = "update-session.lock";
const REMEDIATION_LEASE_DIR = "remediation-leases";
const DEFAULT_REMEDIATION_LEASE_STALE_MS = 24 * 60 * 60 * 1_000;
const SNAPSHOT_FILE_MODE = 0o600;
const SNAPSHOT_DIR_MODE = 0o700;
const MAX_RUNTIME_STATE_BYTES = 1_048_576;
const MAX_RUNTIME_COLLECTION_ITEMS = 64;
const MAX_RUNTIME_TEXT_LENGTH = 4_096;
const TARGET_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  readonly scanComplete: boolean;
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
  if (!input.scanComplete) {
    return {
      health: "manual-review-required",
      message: "Runtime state inspection stopped at a safety limit and requires manual review.",
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
  const inspectionIncomplete = scan.completion === "incomplete" && affected;
  const remediation = inspectionIncomplete
    ? "manual-review-required"
    : remediationFor(store, impact);
  const userActionRequired =
    inspectionIncomplete || actionRequiredForStore(store, impact, affected);
  const decision = decideStoreHealth({
    affected,
    scanStatus: scan.status,
    scanComplete: scan.completion === "complete",
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

function pathExistsFailClosed(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function handoffArtifactsExist(stateDir: string): boolean {
  const root = join(stateDir, UPDATE_DIR, PORTABLE_HANDOFF_DIR);
  let directory: ReturnType<typeof opendirSync> | undefined;
  let artifactFound: boolean;
  try {
    const supplied = lstatSync(root);
    if (!supplied.isDirectory() || supplied.isSymbolicLink()) return true;
    directory = opendirSync(root);
    artifactFound = directory.readSync() !== null;
  } catch (error) {
    artifactFound = (error as NodeJS.ErrnoException).code !== "ENOENT";
  } finally {
    try {
      directory?.closeSync();
    } catch {
      artifactFound = true;
    }
  }
  return artifactFound;
}

function interruptedUpdateArtifactsExist(stateDir: string): boolean {
  return (
    pathExistsFailClosed(join(stateDir, UPDATE_DIR, UPDATE_SESSION_LOCK_FILE)) ||
    pathExistsFailClosed(join(stateDir, UPDATE_DIR, PORTABLE_ACTIVATION_RECOVERY_FILE)) ||
    handoffArtifactsExist(stateDir)
  );
}

interface RemediationLeaseRecord {
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
  readonly processIdentity?: string | undefined;
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
    isOptionalProcessIdentity(record.processIdentity) &&
    Number.isFinite(Date.parse(record.acquiredAt))
    ? {
        pid: record.pid as number,
        token: record.token,
        acquiredAt: record.acquiredAt,
        ...processIdentityField(record.processIdentity),
      }
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
  const ageMs = remediationLeaseAgeMs(path, record, context.now);
  if (ageMs === undefined || ageMs < context.remediationLeaseStaleMs) return false;
  if (record === undefined) return true;
  if (record.pid === process.pid) {
    return record.processIdentity !== context.processIdentity;
  }
  if (!context.pidAlive(record.pid)) return true;
  // A live PID may be a reused process identity. Give a genuine owner a second full lease window,
  // then bound the orphan instead of blocking remediation forever.
  return ageMs >= context.remediationLeaseStaleMs * 2;
}

function restoreClaimedRemediationLease(claimedPath: string, path: string): void {
  try {
    publishFileWithoutReplacement(claimedPath, path);
    unlinkSync(claimedPath);
  } catch {
    // A newer canonical owner wins. Preserve the displaced inode for diagnosis.
  }
}

function remediationLeaseMatches(
  claimed: RemediationLeaseRecord | undefined,
  expected: RemediationLeaseRecord | undefined,
): boolean {
  if (expected === undefined) return claimed === undefined;
  return claimed?.token === expected.token;
}

function discardRemediationLease(
  path: string,
  expected: RemediationLeaseRecord | undefined,
  now: () => number,
): boolean {
  const claimedPath = `${path}.reclaim.${randomUUID()}`;
  try {
    atomicPublishRename(path, claimedPath, { rename: renameSync });
  } catch {
    return false;
  }
  let matches: boolean;
  try {
    matches = remediationLeaseMatches(readRemediationLease(claimedPath), expected);
  } catch {
    restoreClaimedRemediationLease(claimedPath, path);
    return false;
  }
  if (!matches) {
    restoreClaimedRemediationLease(claimedPath, path);
    return false;
  }
  try {
    if (expected === undefined) {
      const suffix = new Date(now()).toISOString().replace(/[:.]/g, "-");
      atomicPublishRename(claimedPath, `${path}.corrupt.${suffix}`, { rename: renameSync });
    } else {
      unlinkSync(claimedPath);
    }
  } catch {
    restoreClaimedRemediationLease(claimedPath, path);
    return false;
  }
  return true;
}

function releaseRemediationLease(path: string, token: string): void {
  // Do not vacate the canonical name until ownership has been established. In particular, an old
  // callback must never move a replacement lease out of the way merely to discover its token.
  if (readRemediationLease(path)?.token !== token) return;
  const claimedPath = `${path}.release.${token}`;
  try {
    atomicPublishRename(path, claimedPath, { rename: renameSync });
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
    publishFileWithoutReplacement(claimedPath, path);
    unlinkSync(claimedPath);
  } catch {
    // A newer canonical lease wins. Preserve the displaced record for diagnosis instead of
    // deleting a lease this callback does not own.
  }
}

function publishRemediationLease(path: string, record: RemediationLeaseRecord): void {
  const draftPath = `${path}.${record.token}.tmp`;
  writeFileSync(draftPath, JSON.stringify(record), {
    encoding: "utf8",
    flag: "wx",
    mode: SNAPSHOT_FILE_MODE,
  });
  try {
    // Prefer a hard link for atomic publication. Filesystems without hard-link support fall back to
    // an exclusive copy; a fresh malformed record then remains protected for one stale window so a
    // concurrent reader cannot reclaim a copy that is still being published.
    publishFileWithoutReplacement(draftPath, path);
  } finally {
    try {
      unlinkSync(draftPath);
    } catch {
      // The canonical lease is authoritative; a private draft is safe to clean up later.
    }
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
      publishRemediationLease(path, {
        pid: process.pid,
        token,
        acquiredAt: nowIso(context.now),
        processIdentity: context.processIdentity,
      });
      return (): void => {
        releaseRemediationLease(path, token);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const existing = readRemediationLease(path);
      if (!remediationLeaseReclaimable(path, existing, context)) return undefined;
      if (!discardRemediationLease(path, existing, context.now)) {
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
  const warnings = [retainedWarning(scan), incompleteScanWarning(scan)].filter(
    (warning): warning is string => warning !== undefined,
  );
  return {
    schemaVersion: UPDATE_LOCAL_STATE_SCHEMA_VERSION,
    scannedAt: nowIso(context.now),
    stateDirStatus: scan.status,
    stores,
    overallHealth: overallHealth(stores),
    warnings,
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
  if (
    scan.completion === "incomplete" ||
    scan.status === "symlink" ||
    scan.status === "not-directory"
  ) {
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

function initialRuntimeState(context: ManagerContext): UpdateRuntimeState {
  const updatedAt = nowIso(context.now);
  return {
    schemaVersion: UPDATE_LOCAL_STATE_SCHEMA_VERSION,
    revision: 0,
    updatedAt,
    recovery: { status: "none", updatedAt },
    remediations: [],
    warnings: [],
  };
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function enumValue(values: readonly string[], value: unknown): value is string {
  return typeof value === "string" && values.includes(value);
}

function validText(value: unknown, maximum = MAX_RUNTIME_TEXT_LENGTH): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\0\r\n]/u.test(value)
  );
}

function validIso(value: unknown): value is string {
  return validText(value, 64) && Number.isFinite(Date.parse(value));
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validPositiveCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function validOptional(value: unknown, check: (input: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

function validPortableSidecar(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "name",
      "kind",
      "upstreamName",
      "upstreamVersion",
      "adapterName",
      "adapterVersion",
      "protocolVersion",
      "platformTarget",
      "payloadSha256",
      "payloadSha256Prefix",
      "sizeBytes",
      "status",
      "failureCode",
    ])
  )
    return false;
  return (
    [
      value.name,
      value.kind,
      value.upstreamName,
      value.upstreamVersion,
      value.adapterName,
      value.adapterVersion,
      value.protocolVersion,
    ].every((entry) => validText(entry, 256)) &&
    enumValue(UPDATE_PORTABLE_TARGETS, value.platformTarget) &&
    typeof value.payloadSha256 === "string" &&
    SHA256_PATTERN.test(value.payloadSha256) &&
    validText(value.payloadSha256Prefix, 64) &&
    validCount(value.sizeBytes) &&
    enumValue(UPDATE_PORTABLE_SIDECAR_VERIFICATION_STATUSES, value.status) &&
    validOptional(value.failureCode, (entry): entry is string =>
      enumValue(UPDATE_PORTABLE_SIDECAR_FAILURE_CODES, entry),
    )
  );
}

function validSidecars(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_RUNTIME_COLLECTION_ITEMS &&
      value.every(validPortableSidecar))
  );
}

// Wire validators are intentionally explicit: every persisted field is bounded and allowlisted.
// eslint-disable-next-line complexity
function validPortableStage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "stageId",
      "status",
      "target",
      "packageVersion",
      "assetName",
      "assetId",
      "releaseId",
      "sizeBytes",
      "sha256",
      "manifestSha256",
      "sidecarRuntimes",
    ])
  )
    return false;
  return (
    validText(value.stageId, 256) &&
    enumValue(UPDATE_PORTABLE_STAGING_STATUSES, value.status) &&
    enumValue(UPDATE_PORTABLE_TARGETS, value.target) &&
    typeof value.packageVersion === "string" &&
    TARGET_VERSION_PATTERN.test(value.packageVersion) &&
    validText(value.assetName, 512) &&
    validCount(value.assetId) &&
    validCount(value.releaseId) &&
    validCount(value.sizeBytes) &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256) &&
    typeof value.manifestSha256 === "string" &&
    SHA256_PATTERN.test(value.manifestSha256) &&
    validSidecars(value.sidecarRuntimes)
  );
}

function validPortableActivation(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "activationId",
      "status",
      "stageId",
      "target",
      "packageVersion",
      "registrationRefreshed",
      "shortcutRefreshed",
      "relaunchRequested",
      "versionVerified",
    ])
  )
    return false;
  return (
    validText(value.activationId, 256) &&
    validText(value.stageId, 256) &&
    enumValue(UPDATE_PORTABLE_ACTIVATION_STATUSES, value.status) &&
    enumValue(UPDATE_PORTABLE_TARGETS, value.target) &&
    typeof value.packageVersion === "string" &&
    TARGET_VERSION_PATTERN.test(value.packageVersion) &&
    [
      value.registrationRefreshed,
      value.shortcutRefreshed,
      value.relaunchRequested,
      value.versionVerified,
    ].every((entry) => typeof entry === "boolean")
  );
}

// eslint-disable-next-line complexity, max-lines-per-function
function validCandidate(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "candidateId",
      "currentVersion",
      "targetVersion",
      "channel",
      "install",
      "release",
      "releaseImpactDigest",
      "issuedAt",
      "expiresAt",
      "portable",
    ])
  )
    return false;
  if (
    !isRecord(value.install) ||
    !hasOnlyKeys(value.install, [
      "packageName",
      "installKind",
      "packageManager",
      "portableTarget",
      "installIdentitySha256",
    ])
  )
    return false;
  if (!isRecord(value.release) || !hasOnlyKeys(value.release, ["source", "tag"])) return false;
  const portable = value.portable;
  const portableValid =
    portable === undefined ||
    (isRecord(portable) &&
      hasOnlyKeys(portable, [
        "target",
        "releaseId",
        "assetId",
        "assetName",
        "sizeBytes",
        "uncompressedSizeBytes",
        "sha256",
        "manifestAssetName",
        "manifestAssetId",
        "manifestSizeBytes",
        "manifestSha256",
        "checksumAssetName",
        "checksumAssetId",
        "checksumSizeBytes",
        "checksumSha256",
        "checksumVerified",
        "sidecarRuntimes",
      ]) &&
      enumValue(UPDATE_PORTABLE_TARGETS, portable.target) &&
      validPositiveCount(portable.releaseId) &&
      validPositiveCount(portable.assetId) &&
      validText(portable.assetName, 512) &&
      validPositiveCount(portable.sizeBytes) &&
      validPositiveCount(portable.uncompressedSizeBytes, 2 * 1_024 * 1_024 * 1_024) &&
      typeof portable.sha256 === "string" &&
      SHA256_PATTERN.test(portable.sha256) &&
      validText(portable.manifestAssetName, 512) &&
      validPositiveCount(portable.manifestAssetId) &&
      validPositiveCount(portable.manifestSizeBytes) &&
      typeof portable.manifestSha256 === "string" &&
      SHA256_PATTERN.test(portable.manifestSha256) &&
      validText(portable.checksumAssetName, 512) &&
      validPositiveCount(portable.checksumAssetId) &&
      validPositiveCount(portable.checksumSizeBytes) &&
      typeof portable.checksumSha256 === "string" &&
      SHA256_PATTERN.test(portable.checksumSha256) &&
      typeof portable.checksumVerified === "boolean" &&
      validSidecars(portable.sidecarRuntimes));
  return (
    value.schemaVersion === UPDATE_CANDIDATE_SCHEMA_VERSION &&
    validText(value.candidateId, 256) &&
    typeof value.currentVersion === "string" &&
    TARGET_VERSION_PATTERN.test(value.currentVersion) &&
    typeof value.targetVersion === "string" &&
    TARGET_VERSION_PATTERN.test(value.targetVersion) &&
    value.channel === "stable" &&
    validText(value.install.packageName, 256) &&
    enumValue(UPDATE_INSTALL_MODE_KINDS, value.install.installKind) &&
    validOptional(value.install.packageManager, (entry): entry is string =>
      enumValue(UPDATE_INSTALL_PACKAGE_MANAGERS, entry),
    ) &&
    validOptional(value.install.portableTarget, (entry): entry is string =>
      enumValue(UPDATE_PORTABLE_TARGETS, entry),
    ) &&
    typeof value.install.installIdentitySha256 === "string" &&
    SHA256_PATTERN.test(value.install.installIdentitySha256) &&
    enumValue(["github-release", "bundled-catalog"], value.release.source) &&
    validText(value.release.tag, 256) &&
    typeof value.releaseImpactDigest === "string" &&
    SHA256_PATTERN.test(value.releaseImpactDigest) &&
    validIso(value.issuedAt) &&
    validIso(value.expiresAt) &&
    portableValid
  );
}

// eslint-disable-next-line complexity
function validLifecycle(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["phase", "progress", "cancellationCutoff"]) ||
    !isRecord(value.progress) ||
    !hasOnlyKeys(value.progress, ["completedBytes", "totalBytes"])
  )
    return false;
  const totalBytes = value.progress.totalBytes;
  return (
    enumValue(UPDATE_LIFECYCLE_PHASES, value.phase) &&
    enumValue(UPDATE_CANCELLATION_CUTOFFS, value.cancellationCutoff) &&
    validCount(value.progress.completedBytes) &&
    validOptional(totalBytes, (entry): entry is number => validCount(entry)) &&
    (totalBytes === undefined ||
      (typeof totalBytes === "number" && totalBytes >= value.progress.completedBytes))
  );
}

function sessionPhaseMatchesLifecycle(phase: unknown, lifecyclePhase: unknown): boolean {
  if (terminalLifecyclePhase(lifecyclePhase)) {
    return phase === lifecyclePhase;
  }
  return phase === sessionPhaseForLifecycle(lifecyclePhase);
}

function terminalLifecyclePhase(value: unknown): boolean {
  return value === "succeeded" || value === "failed" || value === "cancelled";
}

function sessionPhaseForLifecycle(lifecyclePhase: unknown): string {
  if (typeof lifecyclePhase === "string" && RESTART_REQUIRED_LIFECYCLE_PHASES.has(lifecyclePhase)) {
    return "restart-required";
  }
  return lifecyclePhase === "confirmed" || lifecyclePhase === "preparing" ? "preparing" : "running";
}

// eslint-disable-next-line complexity, max-lines-per-function
function validSession(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "sessionId",
      "candidateId",
      "candidateDigest",
      "correlationId",
      "packageName",
      "targetVersion",
      "phase",
      "lifecycle",
      "failureReason",
      "packageManager",
      "portableStage",
      "portableActivation",
      "startedAt",
      "updatedAt",
      "cancelable",
      "retryable",
      "restartRequired",
      "message",
    ])
  )
    return false;
  return (
    value.schemaVersion === UPDATE_SESSION_SCHEMA_VERSION &&
    [value.sessionId, value.candidateId, value.correlationId, value.packageName].every((entry) =>
      validText(entry, 256),
    ) &&
    typeof value.candidateDigest === "string" &&
    SHA256_PATTERN.test(value.candidateDigest) &&
    typeof value.targetVersion === "string" &&
    TARGET_VERSION_PATTERN.test(value.targetVersion) &&
    enumValue(UPDATE_SESSION_PHASES, value.phase) &&
    validLifecycle(value.lifecycle) &&
    sessionPhaseMatchesLifecycle(value.phase, (value.lifecycle as Record<string, unknown>).phase) &&
    enumValue(UPDATE_SESSION_FAILURE_REASONS, value.failureReason) &&
    validOptional(value.packageManager, (entry): entry is string =>
      enumValue(UPDATE_INSTALL_PACKAGE_MANAGERS, entry),
    ) &&
    validOptional(value.portableStage, (entry): entry is Record<string, unknown> =>
      validPortableStage(entry),
    ) &&
    validOptional(value.portableActivation, (entry): entry is Record<string, unknown> =>
      validPortableActivation(entry),
    ) &&
    validIso(value.startedAt) &&
    validIso(value.updatedAt) &&
    [value.cancelable, value.retryable, value.restartRequired].every(
      (entry) => typeof entry === "boolean",
    ) &&
    validText(value.message)
  );
}

function validRecovery(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["status", "sessionId", "reason", "updatedAt"]))
    return false;
  return (
    enumValue(UPDATE_RUNTIME_RECOVERY_STATUSES, value.status) &&
    validOptional(value.sessionId, (entry): entry is string => validText(entry, 256)) &&
    validOptional(value.reason, (entry): entry is string =>
      enumValue(["interrupted", "corrupt", "incompatible", "persistence-failed"], entry),
    ) &&
    validIso(value.updatedAt)
  );
}

// eslint-disable-next-line complexity
function validActivationWal(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "activationId",
      "planSha256",
      "coordinatorSha256",
      "intentRevision",
      "checkpoint",
      "receiptSequence",
      "receiptSha256",
      "coordinatorId",
    ])
  ) {
    return false;
  }
  return (
    typeof value.activationId === "string" &&
    /^[0-9a-f]{32}$/u.test(value.activationId) &&
    typeof value.planSha256 === "string" &&
    SHA256_PATTERN.test(value.planSha256) &&
    typeof value.coordinatorSha256 === "string" &&
    SHA256_PATTERN.test(value.coordinatorSha256) &&
    validPositiveCount(value.intentRevision) &&
    enumValue(UPDATE_ACTIVATION_WAL_CHECKPOINTS, value.checkpoint) &&
    validCount(value.receiptSequence) &&
    validOptional(
      value.receiptSha256,
      (entry) => typeof entry === "string" && SHA256_PATTERN.test(entry),
    ) &&
    validOptional(
      value.coordinatorId,
      (entry) => typeof entry === "string" && SHA256_PATTERN.test(entry),
    ) &&
    (value.receiptSequence === 0
      ? value.receiptSha256 === undefined
      : typeof value.receiptSha256 === "string") &&
    (value.coordinatorId === undefined || value.coordinatorId === value.coordinatorSha256)
  );
}

// Each clause is an independent anti-regression or identity-binding invariant.
// eslint-disable-next-line complexity
function validPreparedAbortSettlement(
  currentState: UpdateRuntimeState,
  nextState: UpdateRuntimeState,
): boolean {
  const wal = currentState.activationWal;
  const currentSession = currentState.activeSession;
  const nextSession = nextState.activeSession;
  return (
    wal?.checkpoint === "prepared" &&
    wal.receiptSequence === 0 &&
    wal.receiptSha256 === undefined &&
    wal.coordinatorId === undefined &&
    currentSession?.sessionId === nextSession?.sessionId &&
    currentSession !== undefined &&
    nextSession !== undefined &&
    currentSession.cancelable &&
    nextSession.cancelable &&
    currentSession.lifecycle.cancellationCutoff === "not-reached" &&
    nextSession.lifecycle.cancellationCutoff === "not-reached" &&
    !["succeeded", "failed", "cancelled"].includes(currentSession.phase) &&
    !["succeeded", "failed", "cancelled"].includes(nextSession.phase) &&
    isDeepStrictEqual(currentSession, nextSession) &&
    isDeepStrictEqual(currentState.activeCandidate, nextState.activeCandidate)
  );
}

function validRestoredHandoffSettlement(
  currentState: UpdateRuntimeState,
  nextState: UpdateRuntimeState,
): boolean {
  const wal = currentState.activationWal;
  const currentSession = currentState.activeSession;
  const lastSession = nextState.lastSession;
  return (
    validRestoredHandoffWal(wal) &&
    validRestoredHandoffSession(currentSession, lastSession) &&
    nextState.activeSession === undefined &&
    nextState.activeCandidate === undefined &&
    nextState.recovery.status === "settled" &&
    nextState.recovery.sessionId === currentSession?.sessionId
  );
}

function validRestoredHandoffWal(wal: UpdateActivationWalState | undefined): boolean {
  return (
    wal?.checkpoint === "restored-verified" &&
    wal.receiptSequence > 0 &&
    wal.receiptSha256 !== undefined
  );
}

function validRestoredHandoffSession(
  currentSession: UpdateRuntimeState["activeSession"],
  lastSession: UpdateRuntimeState["lastSession"],
): boolean {
  return (
    currentSession !== undefined &&
    lastSession?.sessionId === currentSession.sessionId &&
    lastSession.phase === "failed" &&
    lastSession.lifecycle.phase === "failed" &&
    lastSession.failureReason === "portable-relaunch-failed" &&
    !lastSession.cancelable &&
    !lastSession.retryable &&
    !lastSession.restartRequired
  );
}

function validCompletedHandoffSettlement(
  currentState: UpdateRuntimeState,
  nextState: UpdateRuntimeState,
): boolean {
  const wal = currentState.activationWal;
  const currentSession = currentState.activeSession;
  const succeeded = completedHandoffSucceeded(currentState, nextState);
  const remediationRequired = completedHandoffNeedsRemediation(currentState, nextState);
  return (
    validCompletedHandoffWal(wal) &&
    (succeeded || remediationRequired) &&
    nextState.recovery.status === "settled" &&
    nextState.recovery.sessionId === currentSession?.sessionId
  );
}

function completedTerminalSession(currentState: UpdateRuntimeState): UpdateSession | undefined {
  const terminal = currentState.lastSession;
  if (
    currentState.activeSession !== undefined ||
    currentState.activeCandidate !== undefined ||
    terminal?.phase !== "succeeded" ||
    terminal.lifecycle.phase !== "succeeded" ||
    terminal.cancelable ||
    terminal.retryable ||
    terminal.restartRequired
  ) {
    return undefined;
  }
  return terminal;
}

function exactTerminalCompletedProjection(
  currentState: UpdateRuntimeState,
  nextState: UpdateRuntimeState,
  terminal: UpdateSession,
): boolean {
  return (
    currentState.recovery.status === "reconciling" &&
    currentState.recovery.sessionId === terminal.sessionId &&
    nextState.activeSession === undefined &&
    nextState.activeCandidate === undefined &&
    isDeepStrictEqual(nextState.lastSession, terminal) &&
    nextState.recovery.status === "settled" &&
    nextState.recovery.sessionId === terminal.sessionId &&
    isDeepStrictEqual(nextState, {
      ...currentState,
      activationWal: undefined,
      recovery: nextState.recovery,
    })
  );
}

function validTerminalCompletedHandoffSettlement(
  currentState: UpdateRuntimeState,
  nextState: UpdateRuntimeState,
): boolean {
  const wal = currentState.activationWal;
  if (wal?.checkpoint !== "complete" || !validCompletedHandoffWal(wal)) return false;
  const terminal = completedTerminalSession(currentState);
  return (
    terminal !== undefined && exactTerminalCompletedProjection(currentState, nextState, terminal)
  );
}

function completedHandoffSucceeded(
  currentState: UpdateRuntimeState,
  nextState: UpdateRuntimeState,
): boolean {
  const nextActive = nextState.activeSession;
  const nextLast = nextState.lastSession;
  return (
    nextActive === undefined &&
    nextState.activeCandidate === undefined &&
    nextLast !== undefined &&
    nextLast.sessionId === currentState.activeSession?.sessionId &&
    nextLast.lifecycle.phase === "succeeded"
  );
}

function completedHandoffNeedsRemediation(
  currentState: UpdateRuntimeState,
  nextState: UpdateRuntimeState,
): boolean {
  const nextActive = nextState.activeSession;
  return (
    nextActive !== undefined &&
    nextActive.sessionId === currentState.activeSession?.sessionId &&
    nextActive.lifecycle.phase === "remediation-required" &&
    isDeepStrictEqual(currentState.activeCandidate, nextState.activeCandidate) &&
    isDeepStrictEqual(currentState.lastSession, nextState.lastSession)
  );
}

function validCompletedHandoffWal(wal: UpdateActivationWalState | undefined): boolean {
  return (
    (wal?.checkpoint === "cleanup-pending" || wal?.checkpoint === "complete") &&
    wal.receiptSequence >= 12 &&
    wal.receiptSha256 !== undefined
  );
}

function validActivationCheckpointAdvance(
  current: UpdateActivationWalState["checkpoint"],
  next: UpdateActivationWalState["checkpoint"],
): boolean {
  if (current === next) return true;
  const forward = [
    "prepared",
    "old-exited",
    "promoted",
    "registered",
    "new-started",
    "verified",
    "cleanup-pending",
    "complete",
  ] as const;
  const currentForward = forward.indexOf(current as (typeof forward)[number]);
  const nextForward = forward.indexOf(next as (typeof forward)[number]);
  if (currentForward !== -1 && nextForward !== -1) return nextForward > currentForward;
  if (
    next === "restoring" &&
    currentForward >= forward.indexOf("old-exited") &&
    currentForward <= forward.indexOf("new-started")
  )
    return true;
  return (
    (current === "restoring" && next === "restored-started") ||
    (current === "restored-started" && next === "restored-verified")
  );
}

function validActivationWalAdvance(
  currentState: UpdateRuntimeState,
  nextState: UpdateRuntimeState,
  nextRevision: number,
): boolean {
  const current = currentState.activationWal;
  const next = nextState.activationWal;
  if (current === undefined) {
    return next === undefined || preparedWalAtRevision(next, nextRevision);
  }
  if (next === undefined) {
    return (
      validPreparedAbortSettlement(currentState, nextState) ||
      validRestoredHandoffSettlement(currentState, nextState) ||
      validCompletedHandoffSettlement(currentState, nextState) ||
      validTerminalCompletedHandoffSettlement(currentState, nextState)
    );
  }
  if (next.activationId !== current.activationId) {
    return current.checkpoint === "complete" && preparedWalAtRevision(next, nextRevision);
  }
  return matchingActivationWal(current, next);
}

function preparedWalAtRevision(wal: UpdateActivationWalState, revision: number): boolean {
  return (
    wal.checkpoint === "prepared" && wal.receiptSequence === 0 && wal.intentRevision === revision
  );
}

function matchingActivationWal(
  current: UpdateActivationWalState,
  next: UpdateActivationWalState,
): boolean {
  return sameActivationIdentity(current, next) && validActivationReceiptAdvance(current, next);
}

function sameActivationIdentity(
  current: UpdateActivationWalState,
  next: UpdateActivationWalState,
): boolean {
  return (
    next.planSha256 === current.planSha256 &&
    next.coordinatorSha256 === current.coordinatorSha256 &&
    next.intentRevision === current.intentRevision &&
    validActivationCheckpointAdvance(current.checkpoint, next.checkpoint)
  );
}

function validActivationReceiptAdvance(
  current: UpdateActivationWalState,
  next: UpdateActivationWalState,
): boolean {
  return (
    next.receiptSequence >= current.receiptSequence &&
    (next.checkpoint === current.checkpoint || next.receiptSequence > current.receiptSequence) &&
    (next.receiptSequence !== current.receiptSequence ||
      next.receiptSha256 === current.receiptSha256) &&
    (next.receiptSequence === current.receiptSequence ||
      next.receiptSha256 !== current.receiptSha256) &&
    (current.coordinatorId === undefined || next.coordinatorId === current.coordinatorId)
  );
}

function validActiveCandidateLink(value: Record<string, unknown>): boolean {
  if (value.activeSession === undefined || value.activeCandidate === undefined) {
    return value.activeSession === undefined && value.activeCandidate === undefined;
  }
  const session = value.activeSession as Record<string, unknown>;
  const candidate = value.activeCandidate;
  return (
    isRecord(candidate) &&
    session.candidateId === candidate.candidateId &&
    session.targetVersion === candidate.targetVersion &&
    session.candidateDigest === digestUpdateCandidate(candidate)
  );
}

function validRemediation(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["remediation", "store", "status", "updatedAt", "warningCode"])
  )
    return false;
  return (
    enumValue(RELEASE_IMPACT_REMEDIATIONS, value.remediation) &&
    enumValue(UPDATE_STATE_STORES, value.store) &&
    enumValue(UPDATE_REMEDIATION_STATUSES, value.status) &&
    validIso(value.updatedAt) &&
    validOptional(value.warningCode, (entry): entry is string =>
      enumValue(UPDATE_RUNTIME_WARNING_CODES, entry),
    )
  );
}

// eslint-disable-next-line complexity
function migratedRuntimeState(
  context: ManagerContext,
  legacy: Record<string, unknown>,
): UpdateRuntimeState | undefined {
  const initial = initialRuntimeState(context);
  if (
    !validOptional(
      legacy.targetVersion,
      (entry): entry is string => typeof entry === "string" && TARGET_VERSION_PATTERN.test(entry),
    ) ||
    !validOptional(legacy.snapshotId, (entry): entry is string => validText(entry, 256)) ||
    !validOptional(legacy.portableStage, (entry): entry is Record<string, unknown> =>
      validPortableStage(entry),
    ) ||
    !validOptional(legacy.portableActivation, (entry): entry is Record<string, unknown> =>
      validPortableActivation(entry),
    ) ||
    !Array.isArray(legacy.remediations) ||
    legacy.remediations.length > MAX_RUNTIME_COLLECTION_ITEMS ||
    !legacy.remediations.every(validRemediation) ||
    !Array.isArray(legacy.warnings) ||
    legacy.warnings.length > MAX_RUNTIME_COLLECTION_ITEMS ||
    !legacy.warnings.every((entry) => enumValue(UPDATE_RUNTIME_WARNING_CODES, entry))
  )
    return undefined;
  return {
    ...initial,
    revision: 1,
    ...(typeof legacy.targetVersion === "string" ? { targetVersion: legacy.targetVersion } : {}),
    ...(typeof legacy.snapshotId === "string" ? { snapshotId: legacy.snapshotId } : {}),
    ...(legacy.portableStage !== undefined
      ? { portableStage: legacy.portableStage as UpdateRuntimeState["portableStage"] }
      : {}),
    ...(legacy.portableActivation !== undefined
      ? {
          portableActivation: legacy.portableActivation as UpdateRuntimeState["portableActivation"],
        }
      : {}),
    remediations: legacy.remediations as UpdateRuntimeState["remediations"],
    warnings: legacy.warnings as UpdateRuntimeState["warnings"],
  };
}

// eslint-disable-next-line complexity, max-lines-per-function
function validRuntimeState(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      "schemaVersion",
      "revision",
      "updatedAt",
      "activeSession",
      "activeCandidate",
      "lastSession",
      "recovery",
      "activationWal",
      "targetVersion",
      "snapshotId",
      "portableStage",
      "portableActivation",
      "remediations",
      "warnings",
    ]) &&
    value.schemaVersion === UPDATE_LOCAL_STATE_SCHEMA_VERSION &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    validRecovery(value.recovery) &&
    validOptional(value.activationWal, validActivationWal) &&
    validOptional(value.activeSession, (entry): entry is Record<string, unknown> =>
      validSession(entry),
    ) &&
    validOptional(value.activeCandidate, (entry): entry is Record<string, unknown> =>
      validCandidate(entry),
    ) &&
    validActiveCandidateLink(value) &&
    validOptional(value.lastSession, (entry): entry is Record<string, unknown> =>
      validSession(entry),
    ) &&
    validOptional(
      value.targetVersion,
      (entry): entry is string => typeof entry === "string" && TARGET_VERSION_PATTERN.test(entry),
    ) &&
    validOptional(value.snapshotId, (entry): entry is string => validText(entry, 256)) &&
    validOptional(value.portableStage, (entry): entry is Record<string, unknown> =>
      validPortableStage(entry),
    ) &&
    validOptional(value.portableActivation, (entry): entry is Record<string, unknown> =>
      validPortableActivation(entry),
    ) &&
    Array.isArray(value.remediations) &&
    value.remediations.length <= MAX_RUNTIME_COLLECTION_ITEMS &&
    value.remediations.every(validRemediation) &&
    Array.isArray(value.warnings) &&
    value.warnings.length <= MAX_RUNTIME_COLLECTION_ITEMS &&
    value.warnings.every((entry) => enumValue(UPDATE_RUNTIME_WARNING_CODES, entry))
  );
}

function parseInspectedRuntimeState(
  context: ManagerContext,
  raw: string,
  rawBytes: Buffer,
): UpdateRuntimeStateInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }
  if (!isRecord(parsed)) return { status: "corrupt" };
  if (parsed.schemaVersion === 1) {
    const migrated = migratedRuntimeState(context, parsed);
    return migrated === undefined ? { status: "corrupt" } : { status: "migrated", state: migrated };
  }
  if (parsed.schemaVersion !== UPDATE_LOCAL_STATE_SCHEMA_VERSION) return { status: "incompatible" };
  return validRuntimeState(parsed)
    ? {
        status: "ok",
        state: parsed as unknown as UpdateRuntimeState,
        contentSha256: createHash("sha256").update(rawBytes).digest("hex"),
      }
    : { status: "corrupt" };
}

// eslint-disable-next-line complexity
function inspectRuntimeState(context: ManagerContext): UpdateRuntimeStateInspection {
  const path = runtimeStatePath(context.stateDir);
  let raw: string;
  let rawBytes: Buffer;
  let descriptor: number | undefined;
  try {
    const supplied = lstatSync(path);
    if (!supplied.isFile() || supplied.isSymbolicLink() || supplied.nlink !== 1) {
      return { status: "unwritable" };
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_RUNTIME_STATE_BYTES) {
      return opened.size > MAX_RUNTIME_STATE_BYTES
        ? { status: "corrupt" }
        : { status: "unwritable" };
    }
    const bounded = readBoundedRuntimeState(descriptor, opened.size);
    if (bounded === undefined) return { status: "corrupt" };
    rawBytes = bounded;
    raw = rawBytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(rawBytes)) return { status: "corrupt" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return interruptedUpdateArtifactsExist(context.stateDir)
        ? { status: "corrupt" }
        : { status: "missing", state: initialRuntimeState(context) };
    }
    return { status: "unwritable" };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return parseInspectedRuntimeState(context, raw, rawBytes);
}

function readRuntimeState(context: ManagerContext): UpdateRuntimeState {
  const result = inspectRuntimeState(context);
  if ("state" in result) return result.state;
  throw new UpdateRuntimeStateError(result.status);
}

function durableReplace(path: string, content: string): void {
  mkdirPrivate(dirname(path));
  const tempPath = `${path}.${randomUUID()}.tmp`;
  let fileDescriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      SNAPSHOT_FILE_MODE,
    );
    writeFileSync(fileDescriptor, content, { encoding: "utf8" });
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    atomicPublishRename(tempPath, path, { rename: renameSync });
    try {
      directoryDescriptor = openSync(dirname(path), constants.O_RDONLY);
      fsyncSync(directoryDescriptor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        !["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "")
      ) {
        throw error;
      }
      // Windows does not provide portable directory handles for fsync. The file itself was
      // flushed before the atomic replacement, so a platform-specific directory refusal is final.
    }
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    try {
      unlinkSync(tempPath);
    } catch (error) {
      // eslint-disable-next-line no-unsafe-finally
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function writeRuntimeState(context: ManagerContext, state: UpdateRuntimeState): UpdateRuntimeState {
  const persisted = inspectRuntimeState(context);
  if (!("state" in persisted)) throw new UpdateRuntimeStateError(persisted.status);
  const currentRevision = persisted.state.revision;
  if (
    state.revision !== currentRevision ||
    !validRuntimeState(state as unknown as Record<string, unknown>) ||
    !validActivationWalAdvance(persisted.state, state, currentRevision + 1)
  ) {
    throw new UpdateRuntimeStateError("unwritable");
  }
  const next: UpdateRuntimeState = {
    ...state,
    schemaVersion: UPDATE_LOCAL_STATE_SCHEMA_VERSION,
    revision: currentRevision + 1,
    updatedAt: nowIso(context.now),
    recovery: state.recovery,
  };
  try {
    durableReplace(runtimeStatePath(context.stateDir), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    throw new UpdateRuntimeStateError("unwritable");
  }
  return next;
}

// eslint-disable-next-line complexity
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
    context.activityLog?.write({
      category: "diagnostic",
      op: "update.runtime.event",
      ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
      extra: {
        eventId: event.eventId,
        type: event.type,
        ...(event.targetVersion === undefined ? {} : { targetVersion: event.targetVersion }),
        ...(event.snapshotId === undefined ? {} : { snapshotId: event.snapshotId }),
        ...(event.portableStageId === undefined ? {} : { portableStageId: event.portableStageId }),
        ...(event.portableActivationId === undefined
          ? {}
          : { portableActivationId: event.portableActivationId }),
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(event.warningCode === undefined ? {} : { warningCode: event.warningCode }),
      },
    });
    return { event };
  } catch (error) {
    emitServerDiagnostic(
      context.diagnostics,
      serverDiagnosticFromError({
        correlationId: event.correlationId ?? UNKNOWN_CORRELATION_ID,
        operation: "update.runtime.activity-log",
        source: "update-local-state",
        error,
        redact: (): string => "A bounded update diagnostic failed.",
      }),
    );
    return { event, warning: "Update activity event could not be emitted." };
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
    processIdentity: options.processIdentity ?? PROCESS_START_IDENTITY,
    activityLog: options.activityLog,
    diagnostics: options.diagnostics,
  };
  return {
    scanCompatibility: (impact): UpdateCompatibilityScan => scanCompatibility(context, impact),
    createRecoverySnapshot: (input): UpdateRecoverySnapshot =>
      createRecoverySnapshot(context, input),
    validateRecoverySnapshot: (snapshotId): boolean =>
      validateSnapshot(context.stateDir, snapshotId),
    repairStores: (stores): UpdateLocalStateRepairResult => repairStores(context, stores),
    readRuntimeState: (): UpdateRuntimeState => readRuntimeState(context),
    inspectRuntimeState: (): UpdateRuntimeStateInspection => inspectRuntimeState(context),
    writeRuntimeState: (state): UpdateRuntimeState => writeRuntimeState(context, state),
    acquireRemediationLease: (actionId): (() => void) | undefined =>
      acquireRemediationLease(context, actionId),
    recordAuditEvent: (type, input): AuditEventRecord => recordAuditEvent(context, type, input),
  };
}
