import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";

interface Refusal {
  readonly ok: false;
  readonly reason: "malformed-payload" | "bounds-exceeded";
}
type Value = { readonly ok: true; readonly value: CatalogJsonValue } | Refusal;
export type JiraMaintenanceProjection =
  { readonly ok: true; readonly value: CatalogJsonObject } | Refusal;
type Projector = (value: unknown) => Value;
const MALFORMED: Refusal = { ok: false, reason: "malformed-payload" };
const BOUNDS: Refusal = { ok: false, reason: "bounds-exceeded" };

function text(max: number, empty = false): Projector {
  return (value) => {
    if (typeof value === "string" && value.length > max) return BOUNDS;
    return jiraNativeText(value, max, empty) ? { ok: true, value } : MALFORMED;
  };
}
function boolean(value: unknown): Value {
  return typeof value === "boolean" ? { ok: true, value } : MALFORMED;
}
function integer(value: unknown): Value {
  if (typeof value !== "number" || !Number.isInteger(value)) return MALFORMED;
  return Number.isSafeInteger(value) ? { ok: true, value } : BOUNDS;
}
function count(value: unknown): Value {
  const result = integer(value);
  if (!result.ok) return result;
  return typeof result.value === "number" && result.value >= 0 ? result : MALFORMED;
}
/** The field set is fixed by each published DTO below; unknown native properties never enter results. */
function fields(
  value: unknown,
  projectors: Readonly<Record<string, Projector>>,
): JiraMaintenanceProjection {
  const raw = asRecord(value);
  if (raw === undefined) return MALFORMED;
  const projected: Record<string, CatalogJsonValue> = {};
  for (const [key, project] of Object.entries(projectors)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    const result = project(value);
    if (!result.ok) return result;
    projected[key] = result.value;
  }
  return { ok: true, value: projected };
}

export function jiraMaintenanceNode(value: unknown): JiraMaintenanceProjection {
  const raw = asRecord(value);
  const nodeId = text(255)(raw?.nodeId);
  if (!nodeId.ok) return nodeId;
  const result = fields(value, {
    state: text(128),
    alive: boolean,
    nodeBuildNumber: integer,
    nodeVersion: text(255),
    lastStateChangeTimestamp: integer,
  });
  return result.ok ? { ok: true, value: { nodeId: nodeId.value, ...result.value } } : result;
}
function build(value: unknown): JiraMaintenanceProjection {
  return fields(value, { buildNumber: integer, version: text(255) });
}
export function jiraMaintenanceUpgrade(value: unknown): JiraMaintenanceProjection {
  // ClusterState's published enum and example disagree. Preserve bounded observed state text.
  return fields(value, { state: text(128), build });
}
export function jiraMaintenanceSnapshot(value: unknown): JiraMaintenanceProjection {
  return fields(value, { running: boolean });
}
function issueIndex(value: unknown): JiraMaintenanceProjection {
  return fields(value, {
    indexReadable: boolean,
    countInArchive: count,
    countInDatabase: count,
    countInIndex: count,
    lastUpdatedInDatabase: text(128),
    lastUpdatedInIndex: text(128),
  });
}
function replicationOperation(value: unknown): JiraMaintenanceProjection {
  return fields(value, { id: integer, replicationTime: text(128) });
}
function replayOperation(value: unknown): JiraMaintenanceProjection {
  return fields(value, { id: integer, journalWriteTime: text(128) });
}
function queues(value: unknown, operation: Projector): Value {
  const raw = asRecord(value);
  if (raw === undefined) return MALFORMED;
  const entries = Object.entries(raw);
  if (entries.length > TOOL_CATALOG_LIMITS.maxArrayItems) return BOUNDS;
  const items: CatalogJsonObject[] = [];
  for (const [key, queue] of entries) {
    const nodeId = text(255)(key);
    if (!nodeId.ok) return nodeId;
    const projected = fields(queue, {
      queueSize: count,
      lastConsumedOperation: operation,
      lastOperationInQueue: operation,
    });
    if (!projected.ok) return projected;
    items.push({ nodeId: nodeId.value, ...projected.value });
  }
  return { ok: true, value: items };
}
export function jiraMaintenanceIndex(value: unknown): JiraMaintenanceProjection {
  return fields(value, {
    nodeId: text(255),
    reportTime: text(128),
    issueIndex,
    replicationQueues: (raw) => queues(raw, replicationOperation),
    externalPlatformIndexReplay: (raw) => queues(raw, replayOperation),
  });
}

export function jiraMaintenanceReindex(value: unknown): JiraMaintenanceProjection {
  return fields(value, {
    currentProgress: integer,
    currentSubTask: text(4096, true),
    finishTime: text(128),
    startTime: text(128),
    submittedTime: text(128),
    success: boolean,
    type: text(128),
  });
}

export function jiraMaintenanceRequest(value: unknown): JiraMaintenanceProjection {
  const raw = asRecord(value);
  const id = jiraNativeNumericId(raw?.id);
  if (id === undefined) return MALFORMED;
  const result = fields(value, {
    completionTime: text(128),
    requestTime: text(128),
    startTime: text(128),
    status: text(128),
    type: text(128),
  });
  return result.ok ? { ok: true, value: { id, ...result.value } } : result;
}

export function jiraMaintenanceUpgradeResult(value: unknown): JiraMaintenanceProjection {
  const result = fields(value, {
    duration: count,
    message: text(TOOL_CATALOG_LIMITS.maxStringBytes, true),
    outcome: text(128),
    startTime: text(128),
  });
  if (!result.ok) return result;
  const { outcome, ...observed } = result.value;
  return {
    ok: true,
    value: { ...observed, ...(outcome === undefined ? {} : { upgradeOutcome: outcome }) },
  };
}

export function jiraMaintenanceSnapshotEntry(value: unknown): JiraMaintenanceProjection {
  const raw = asRecord(value);
  const path = text(4096)(raw?.absolutePath);
  if (!path.ok) return path;
  const result = fields(value, { timestamp: integer });
  // This is server-reported metadata, never a local file or a destination to follow.
  return result.ok ? { ok: true, value: { absolutePath: path.value, ...result.value } } : result;
}

export function jiraMaintenanceMonitoring(value: unknown): JiraMaintenanceProjection {
  return fields(value, { enabled: boolean });
}

export function jiraMaintenanceMetricDescription(value: unknown): JiraMaintenanceProjection {
  const result = text(TOOL_CATALOG_LIMITS.maxStringBytes, true)(value);
  return result.ok ? { ok: true, value: { metricsText: result.value } } : result;
}
