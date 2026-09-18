// Diagnostic readiness: whether this process can currently produce machine-reconstruction
// evidence, computed BEFORE the server accepts work and exposed on `/api/health`, `keiko status`
// and `keiko support` (#3532).
//
// `ready` holds only when:
//   * the registry/catalog identity is coherent — every mandatory operation is registered and a
//     readiness line passes the production formatter's identity and field validation;
//   * the production sink accepted a real, synced write (the startup probe) and has not failed
//     since;
//   * the storage has room and stays inside its byte budget;
//   * the process-wide logger — the port every domain package writes through — is wired to the
//     same state directory the launch validated;
//   * the configured level does not silence the log.
// Any failed check names a closed reason. `unavailable` means no trustworthy evidence can be
// written at all (catalog mismatch or an unwritable sink); anything else is `degraded`. An
// explicitly injected test writer is reported as such, never as a production writer.

import { accessSync, constants, lstatSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  activityLogEvent,
  activityLogLossCounters,
  activityLogLossTotal,
  activityLogOperationSchema,
  defineActivityLogOperation,
  type ActivityLogLossCounters,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  ActivityLogReadinessReason,
  ActivityLogReadinessSnapshot,
  ActivityLogReadinessState,
  ActivityLogWriterKind,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";

import { resolveServerLogThreshold } from "./log-level.js";
import type { ServerLogEnv, ServerLogThreshold } from "./log-level.js";
import {
  persistActivityLogEvents,
  type ActivityLogEventPersister,
} from "./activity-log-persistence.js";
import {
  DEFAULT_LOG_CAPACITY_WARNING_BYTES,
  formatRegisteredServerLogLine,
  reportServerLogFailure,
  serverLogProcessIdentity,
  type ServerLogEvent,
} from "./server-log.js";
import {
  activityLogWriterState,
  getServerLogger,
  type ActivityLogWriterState,
} from "./server-logger.js";

export const ACTIVITY_LOG_READINESS_TRIGGERS = ["startup", "heartbeat", "transition"] as const;
export type ActivityLogReadinessTrigger = (typeof ACTIVITY_LOG_READINESS_TRIGGERS)[number];

const ACTIVITY_LOG_READINESS_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "activity-log.readiness",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/activity-log-readiness.readinessEvent",
  fields: {
    readiness: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["ready", "degraded", "unavailable"],
    },
    reasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: true,
      maxItems: 6,
      values: [
        "catalog-mismatch",
        "sink-unwritable",
        "storage-pressure",
        "budget-exceeded",
        "port-unwired",
        "level-silent",
      ],
    },
    writer: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["production-file", "test-injected", "unavailable"],
    },
    trigger: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["startup", "heartbeat", "transition"],
    },
    lostEvents: { type: "integer", dataClass: "count", required: true },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["activity-log-readiness"],
  proofIds: ["activity-log.readiness.startup-line", "activity-log.readiness.transition-line"],
  releaseImpact: "minor",
});

// Storage facts the readiness check consumes. The shape is the segment writer's storage-health
// report; until that writer exists, `defaultActivityLogStorageHealth` answers from the directory
// itself (writability and free space) and reports the documented capacity threshold as the budget.
export type ActivityLogStoragePressure = "none" | "elevated" | "critical";

export interface ActivityLogStorageHealth {
  readonly writable: boolean;
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly pinQuotaBytes: number;
  readonly pinnedBytes: number;
  readonly freeBytes?: number | undefined;
  readonly activeSegments: number;
  readonly sealedSegments: number;
  readonly pressure: ActivityLogStoragePressure;
  readonly recoveredSegments: number;
}

export type ActivityLogStorageHealthProvider = (stateDir: string) => ActivityLogStorageHealth;

// Below this much free space an append is likely to fail mid-incident; readiness says so before it
// happens instead of after.
export const ACTIVITY_LOG_MIN_FREE_BYTES = 64 * 1024 * 1024;

function writableDirectory(directory: string): boolean | undefined {
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory()) return false;
    accessSync(directory, constants.W_OK);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : false;
  }
}

function freeBytesOf(directory: string): number | undefined {
  try {
    const stats = statfsSync(directory);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isSafeInteger(free) && free >= 0 ? free : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The storage-health answer available without the segment writer: whether the log directory (or,
 * before its first write, the state directory that will hold it) is a writable directory, and how
 * much space is free. Usage is not measured here, so no budget is reported as exceeded.
 */
export function defaultActivityLogStorageHealth(stateDir: string): ActivityLogStorageHealth {
  const directory = join(stateDir, "logs");
  const logsWritable = writableDirectory(directory);
  const writable = logsWritable ?? writableDirectory(stateDir) === true;
  const freeBytes = freeBytesOf(logsWritable === undefined ? stateDir : directory);
  return {
    writable,
    usedBytes: 0,
    budgetBytes: DEFAULT_LOG_CAPACITY_WARNING_BYTES,
    pinQuotaBytes: 0,
    pinnedBytes: 0,
    ...(freeBytes === undefined ? {} : { freeBytes }),
    activeSegments: 0,
    sealedSegments: 0,
    pressure:
      freeBytes !== undefined && freeBytes < ACTIVITY_LOG_MIN_FREE_BYTES ? "critical" : "none",
    recoveredSegments: 0,
  };
}

// The operations every production process must be able to emit. A registry built without one of
// them (a skewed package set) cannot carry the lifecycle and loss evidence readiness promises.
const MANDATORY_REGISTERED_OPERATIONS = [
  "activity-log.loss",
  "activity-log.readiness",
  "process.exiting",
  "process.fatal",
  "process.started",
  "server-log.write-failed",
] as const;

function readinessLevel(readiness: ActivityLogReadinessState): "info" | "warn" | "error" {
  if (readiness === "ready") return "info";
  return readiness === "degraded" ? "warn" : "error";
}

function readinessEvent(
  snapshot: ActivityLogReadinessSnapshot,
  trigger: ActivityLogReadinessTrigger,
): ServerLogEvent {
  return activityLogEvent(
    ACTIVITY_LOG_READINESS_OPERATION,
    {
      level: readinessLevel(snapshot.readiness),
      ...(snapshot.readiness === "ready" ? {} : { errorKind: "unavailable" as const }),
    },
    {
      readiness: snapshot.readiness,
      reasons: snapshot.reasons,
      writer: snapshot.writer,
      trigger,
      lostEvents: snapshot.lostEvents,
      completeness: snapshot.readiness === "ready" ? "complete" : "partial",
    },
  );
}

const PROBE_SNAPSHOT: ActivityLogReadinessSnapshot = {
  readiness: "ready",
  reasons: [],
  writer: "production-file",
  lostEvents: 0,
};

// The registry and the persisted identity agree: every mandatory operation is registered, and a
// readiness line passes the exact identity and field validation the file sink applies.
function activityLogCatalogCoherent(): boolean {
  if (
    !MANDATORY_REGISTERED_OPERATIONS.every((op) => activityLogOperationSchema(op) !== undefined)
  ) {
    return false;
  }
  try {
    formatRegisteredServerLogLine(readinessEvent(PROBE_SNAPSHOT, "startup"), new Date(), {
      ...serverLogProcessIdentity(),
      seq: 1,
    });
    return true;
  } catch {
    return false;
  }
}

type SinkCondition = "writable" | "failing" | "unwritable";

interface ReadinessFacts {
  readonly writer: ActivityLogWriterKind;
  readonly catalogCoherent: boolean;
  readonly sink: SinkCondition;
  readonly storage: ActivityLogStorageHealth | undefined;
  readonly threshold: ServerLogThreshold;
  readonly portsWired: boolean;
}

function storageReasons(
  storage: ActivityLogStorageHealth | undefined,
): ActivityLogReadinessReason[] {
  if (storage === undefined) return [];
  const reasons: ActivityLogReadinessReason[] = [];
  if (storage.pressure !== "none") reasons.push("storage-pressure");
  if (storage.usedBytes > storage.budgetBytes + storage.pinQuotaBytes) {
    reasons.push("budget-exceeded");
  }
  return reasons;
}

function readinessReasons(facts: ReadinessFacts): readonly ActivityLogReadinessReason[] {
  const reasons: ActivityLogReadinessReason[] = [];
  if (!facts.catalogCoherent) reasons.push("catalog-mismatch");
  if (facts.sink !== "writable") reasons.push("sink-unwritable");
  reasons.push(...storageReasons(facts.storage));
  if (!facts.portsWired) reasons.push("port-unwired");
  if (facts.threshold === "silent") reasons.push("level-silent");
  return reasons;
}

function readinessState(
  facts: ReadinessFacts,
  reasons: readonly ActivityLogReadinessReason[],
): ActivityLogReadinessState {
  if (!facts.catalogCoherent || facts.sink === "unwritable") return "unavailable";
  return reasons.length === 0 ? "ready" : "degraded";
}

function snapshotFrom(facts: ReadinessFacts): ActivityLogReadinessSnapshot {
  const reasons = readinessReasons(facts);
  return {
    readiness: readinessState(facts, reasons),
    reasons,
    writer: facts.writer,
    lostEvents: activityLogLossTotal(),
  };
}

// Loss reasons that mean the production append path itself failed since the last evaluation.
const PERSISTENCE_LOSS_REASONS = [
  "logger-write-failed",
  "logger-unavailable",
  "persistence-failed",
  "summary-write-failed",
] as const;

function persistenceFailures(counters: ActivityLogLossCounters): number {
  return PERSISTENCE_LOSS_REASONS.reduce((total, reason) => total + counters[reason], 0);
}

interface ReadinessMemory {
  current: ActivityLogReadinessSnapshot | undefined;
  expectedStateDir: string | undefined;
  persistenceFailuresSeen: number;
}

const memory: ReadinessMemory = {
  current: undefined,
  expectedStateDir: undefined,
  persistenceFailuresSeen: 0,
};

export interface ActivityLogReadinessOptions {
  // The state directory the launch validated; the process-wide logger must resolve to it.
  readonly stateDir?: string | undefined;
  readonly env?: ServerLogEnv | undefined;
  readonly storageHealth?: ActivityLogStorageHealthProvider | undefined;
  readonly persist?: ActivityLogEventPersister | undefined;
  // `process` (the default) evaluates the writer this process logs through. `directory` evaluates
  // the Activity Log of `stateDir` itself, for a one-shot command that inspects a state directory
  // it does not serve (`keiko support export --state-dir`): the probe writes through the production
  // append path into that directory, port wiring is not a property of it, and the process's own
  // readiness — the one `/api/health` reports — is left untouched.
  readonly scope?: ActivityLogReadinessScope | undefined;
}

export type ActivityLogReadinessScope = "process" | "directory";

function directoryScope(
  options: ActivityLogReadinessOptions,
): options is ActivityLogReadinessOptions & {
  readonly stateDir: string;
} {
  return options.scope === "directory" && options.stateDir !== undefined;
}

function writerStateFor(options: ActivityLogReadinessOptions): ActivityLogWriterState {
  return directoryScope(options)
    ? { writer: "production-file", stateDir: options.stateDir }
    : activityLogWriterState();
}

function portsWired(
  writer: ActivityLogWriterKind,
  resolvedStateDir: string | undefined,
  expectedStateDir: string | undefined,
): boolean {
  if (writer === "test-injected") return true;
  if (writer === "unavailable" || resolvedStateDir === undefined) return false;
  return expectedStateDir === undefined || resolve(expectedStateDir) === resolve(resolvedStateDir);
}

function portWiringFact(
  state: ActivityLogWriterState,
  options: ActivityLogReadinessOptions,
): boolean {
  if (directoryScope(options)) return true;
  return portsWired(state.writer, state.stateDir, options.stateDir ?? memory.expectedStateDir);
}

function collectFacts(options: ActivityLogReadinessOptions, sink: SinkCondition): ReadinessFacts {
  const state = writerStateFor(options);
  const stateDir = options.stateDir ?? state.stateDir;
  const production = state.writer !== "test-injected" && stateDir !== undefined;
  const storage = production
    ? (options.storageHealth ?? defaultActivityLogStorageHealth)(stateDir)
    : undefined;
  const storageSink: SinkCondition =
    storage === undefined || storage.writable ? sink : "unwritable";
  return {
    writer: state.writer,
    catalogCoherent: activityLogCatalogCoherent(),
    sink: state.writer === "unavailable" ? "unwritable" : storageSink,
    storage,
    threshold: resolveServerLogThreshold(options.env ?? process.env),
    portsWired: portWiringFact(state, options),
  };
}

function remember(snapshot: ActivityLogReadinessSnapshot): ActivityLogReadinessSnapshot {
  memory.current = snapshot;
  memory.persistenceFailuresSeen = persistenceFailures(activityLogLossCounters());
  return snapshot;
}

/**
 * The startup self-check. Evaluates every readiness condition, then persists the resulting
 * `activity-log.readiness` line through the observable production append path — that write IS the
 * sink probe. When it fails, the process is reported `unavailable` with `sink-unwritable`, and the
 * notice goes to stderr because the log itself cannot carry it.
 */
export function checkActivityLogReadiness(
  options: ActivityLogReadinessOptions = {},
): ActivityLogReadinessSnapshot {
  const inspectOnly = directoryScope(options);
  if (!inspectOnly) memory.expectedStateDir = options.stateDir ?? memory.expectedStateDir;
  const record = inspectOnly
    ? (snapshot: ActivityLogReadinessSnapshot): ActivityLogReadinessSnapshot => snapshot
    : remember;
  const tentative = snapshotFrom(collectFacts(options, "writable"));
  const stateDir = writerStateFor(options).stateDir;
  if (tentative.writer === "test-injected" || stateDir === undefined) return record(tentative);
  const persisted = (options.persist ?? persistActivityLogEvents)(stateDir, [
    readinessEvent(tentative, "startup"),
  ]);
  if (persisted) return record(tentative);
  reportServerLogFailure(undefined, { op: "activity-log.readiness", loss: "event-dropped" });
  return record(snapshotFrom(collectFacts(options, "unwritable")));
}

function sameReadiness(
  left: ActivityLogReadinessSnapshot | undefined,
  right: ActivityLogReadinessSnapshot,
): boolean {
  return (
    left !== undefined &&
    left.readiness === right.readiness &&
    left.writer === right.writer &&
    left.reasons.length === right.reasons.length &&
    left.reasons.every((reason, index) => reason === right.reasons[index])
  );
}

/**
 * Re-evaluates readiness without a write probe (heartbeat cadence): a production append failure
 * counted since the last evaluation marks the sink as failing. A changed state is written as an
 * `activity-log.readiness` transition through the process logger, which never filters it.
 */
export function refreshActivityLogReadiness(
  options: ActivityLogReadinessOptions = {},
): ActivityLogReadinessSnapshot {
  const failures = persistenceFailures(activityLogLossCounters());
  const sink: SinkCondition = failures > memory.persistenceFailuresSeen ? "failing" : "writable";
  const previous = memory.current;
  const next = snapshotFrom(collectFacts(options, sink));
  remember(next);
  if (!sameReadiness(previous, next)) {
    getServerLogger().log(readinessLevel(next.readiness), readinessEvent(next, "transition"));
  }
  return next;
}

/**
 * The readiness `/api/health` reports: the last evaluation with a live lost-event count. A process
 * that never ran the startup check (an embedded or test server) is evaluated once, without a write.
 */
export function currentActivityLogReadiness(): ActivityLogReadinessSnapshot {
  const snapshot = memory.current ?? remember(snapshotFrom(collectFacts({}, "writable")));
  return { ...snapshot, lostEvents: activityLogLossTotal() };
}

/** Test-only: forgets every evaluation so each suite starts from an unchecked process. */
export function resetActivityLogReadinessForTests(): void {
  memory.current = undefined;
  memory.expectedStateDir = undefined;
  memory.persistenceFailuresSeen = 0;
}
