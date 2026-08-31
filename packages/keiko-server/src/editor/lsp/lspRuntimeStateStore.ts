import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { assertNoSymlinkedPathSegments, savePrivateJson } from "../../private-json.js";

const SCHEMA_VERSION = "1" as const;
const MAX_RECORD_BYTES = 16_384;
const MAX_CRASH_TIMESTAMPS = 256;

type LspRuntimeLeaseState = "active" | "released";
export type LspRuntimeLeaseReason =
  "process-live" | "exit-unconfirmed" | "tree-unconfirmed" | "resource-cleanup-failed";

export interface LspRuntimeStateSnapshot {
  readonly generation: number;
  readonly leaseState: LspRuntimeLeaseState;
  readonly leaseReason?: LspRuntimeLeaseReason | undefined;
  readonly crashTimestampsMs: readonly number[];
  readonly restartCount: number;
  readonly updatedAtMs: number;
}

export type LspRuntimeStateLoadResult =
  | { readonly state: "absent" }
  | { readonly state: "ready"; readonly snapshot: LspRuntimeStateSnapshot }
  | { readonly state: "unavailable" };

export interface LspRuntimeStatePort {
  load(): LspRuntimeStateLoadResult;
  save(snapshot: LspRuntimeStateSnapshot): void;
}

export interface LspRuntimeStateStoreOptions {
  readonly stateDir: string;
  readonly workspaceRoot: string;
  readonly managerId: string;
  readonly configurationRevision: number;
  readonly save?: ((path: string, value: Record<string, unknown>) => void) | undefined;
  readonly read?: ((path: string) => string) | undefined;
  readonly size?: ((path: string) => number) | undefined;
}

interface StoreIdentity {
  readonly workspaceFingerprint: string;
  readonly managerFingerprint: string;
  readonly configurationRevision: number;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function contained(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function safeStateLocation(options: LspRuntimeStateStoreOptions): boolean {
  const stateDir = canonicalExistingPath(options.stateDir);
  const workspaceRoot = canonicalExistingPath(options.workspaceRoot);
  if (contained(workspaceRoot, stateDir) || contained(stateDir, workspaceRoot)) return false;
  try {
    assertNoSymlinkedPathSegments(stateDir);
    return true;
  } catch {
    return false;
  }
}

function identity(options: LspRuntimeStateStoreOptions): StoreIdentity {
  return {
    workspaceFingerprint: sha256(canonicalExistingPath(options.workspaceRoot)),
    managerFingerprint: sha256(options.managerId),
    configurationRevision: options.configurationRevision,
  };
}

export function lspRuntimeStateRecordPath(options: LspRuntimeStateStoreOptions): string {
  const bound = identity(options);
  return join(
    canonicalExistingPath(options.stateDir),
    `managed-lsp-runtime-${bound.workspaceFingerprint}-${bound.managerFingerprint}.json`,
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseTimestamps(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CRASH_TIMESTAMPS) return undefined;
  if (!value.every(isCount)) return undefined;
  for (let index = 1; index < value.length; index += 1) {
    if ((value[index - 1] ?? 0) > (value[index] ?? 0)) return undefined;
  }
  return value;
}

function isLeaseReason(value: unknown): value is LspRuntimeLeaseReason {
  return (
    value === "process-live" ||
    value === "exit-unconfirmed" ||
    value === "tree-unconfirmed" ||
    value === "resource-cleanup-failed"
  );
}

interface SnapshotCounts {
  readonly generation: number;
  readonly restartCount: number;
  readonly updatedAtMs: number;
}

function parseSnapshotCounts(value: UnknownRecord): SnapshotCounts | undefined {
  if (!isCount(value.generation)) return undefined;
  if (!isCount(value.restartCount)) return undefined;
  if (!isCount(value.updatedAtMs)) return undefined;
  return {
    generation: value.generation,
    restartCount: value.restartCount,
    updatedAtMs: value.updatedAtMs,
  };
}

interface ParsedLease {
  readonly state: LspRuntimeLeaseState;
  readonly reason: LspRuntimeLeaseReason | undefined;
}

function parseLease(value: UnknownRecord): ParsedLease | undefined {
  if (value.leaseState !== "active" && value.leaseState !== "released") return undefined;
  const reason = isLeaseReason(value.leaseReason) ? value.leaseReason : undefined;
  if (value.leaseState === "active" && reason === undefined) return undefined;
  if (value.leaseState === "released" && value.leaseReason !== undefined) return undefined;
  return { state: value.leaseState, reason };
}

function parseSnapshot(value: UnknownRecord): LspRuntimeStateSnapshot | undefined {
  const allowed = [
    "generation",
    "leaseState",
    "leaseReason",
    "crashTimestampsMs",
    "restartCount",
    "updatedAtMs",
  ] as const;
  if (!hasOnlyKeys(value, allowed)) return undefined;
  const timestamps = parseTimestamps(value.crashTimestampsMs);
  const lease = parseLease(value);
  const counts = parseSnapshotCounts(value);
  if (counts === undefined || timestamps === undefined || lease === undefined) return undefined;
  return {
    generation: counts.generation,
    leaseState: lease.state,
    ...(lease.reason === undefined ? {} : { leaseReason: lease.reason }),
    crashTimestampsMs: timestamps,
    restartCount: counts.restartCount,
    updatedAtMs: counts.updatedAtMs,
  };
}

function boundRecordPayload(value: UnknownRecord, bound: StoreIdentity): UnknownRecord | undefined {
  if (value.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (value.workspaceFingerprint !== bound.workspaceFingerprint) return undefined;
  if (value.managerFingerprint !== bound.managerFingerprint) return undefined;
  if (!isCount(value.configurationRevision) || !isRecord(value.runtime)) return undefined;
  return value.runtime;
}

function parseBoundRecord(
  value: unknown,
  bound: StoreIdentity,
): LspRuntimeStateSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = [
    "schemaVersion",
    "workspaceFingerprint",
    "managerFingerprint",
    "configurationRevision",
    "runtime",
  ] as const;
  if (!hasOnlyKeys(value, allowed)) return undefined;
  const payload = boundRecordPayload(value, bound);
  if (payload === undefined) return undefined;
  const snapshot = parseSnapshot(payload);
  if (snapshot === undefined) return undefined;
  // An active lease belongs to a still-unsettled generation and blocks every later configuration
  // revision. A released record may carry crash history only for the revision that produced it.
  if (
    snapshot.leaseState === "released" &&
    value.configurationRevision !== bound.configurationRevision
  ) {
    return {
      generation: snapshot.generation,
      leaseState: "released",
      crashTimestampsMs: [],
      restartCount: 0,
      updatedAtMs: snapshot.updatedAtMs,
    };
  }
  return snapshot;
}

function recordForWrite(
  bound: StoreIdentity,
  snapshot: LspRuntimeStateSnapshot,
): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceFingerprint: bound.workspaceFingerprint,
    managerFingerprint: bound.managerFingerprint,
    configurationRevision: bound.configurationRevision,
    runtime: snapshot,
  };
}

export function createLspRuntimeStatePort(
  options: LspRuntimeStateStoreOptions,
): LspRuntimeStatePort {
  const bound = identity(options);
  const path = lspRuntimeStateRecordPath(options);
  const save = options.save ?? savePrivateJson;
  return {
    load: (): LspRuntimeStateLoadResult => {
      if (!safeStateLocation(options)) return { state: "unavailable" };
      if (!existsSync(path)) return { state: "absent" };
      try {
        if ((options.size?.(path) ?? statSync(path).size) > MAX_RECORD_BYTES) {
          return { state: "unavailable" };
        }
        const raw: unknown = JSON.parse(options.read?.(path) ?? readFileSync(path, "utf8"));
        const snapshot = parseBoundRecord(raw, bound);
        return snapshot === undefined ? { state: "unavailable" } : { state: "ready", snapshot };
      } catch {
        return { state: "unavailable" };
      }
    },
    save: (snapshot): void => {
      if (
        !safeStateLocation(options) ||
        parseSnapshot(snapshot as unknown as UnknownRecord) === undefined
      ) {
        throw new Error("managed LSP runtime state is invalid or unavailable");
      }
      save(path, recordForWrite(bound, snapshot));
    },
  };
}
