import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativePagingSchema as PAGING,
  jiraNativeDeclaration,
  jiraNativeReadResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const NAME = { ...text(255), minLength: 1 };
const OBSERVED_TEXT = { ...text(128), minLength: 1 };
const BOOL = { type: "boolean" };
const INTEGER = {
  type: "integer",
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
};
const COUNT = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const NODE = object(
  {
    nodeId: NAME,
    state: OBSERVED_TEXT,
    alive: BOOL,
    nodeBuildNumber: INTEGER,
    nodeVersion: NAME,
    lastStateChangeTimestamp: INTEGER,
  },
  ["nodeId"],
);
const BUILD = object({ buildNumber: INTEGER, version: NAME });
const ISSUE_INDEX = object({
  indexReadable: BOOL,
  countInArchive: COUNT,
  countInDatabase: COUNT,
  countInIndex: COUNT,
  lastUpdatedInDatabase: OBSERVED_TEXT,
  lastUpdatedInIndex: OBSERVED_TEXT,
});
function queues(timestamp: "replicationTime" | "journalWriteTime"): CatalogJsonObject {
  const operation = object({ id: INTEGER, [timestamp]: OBSERVED_TEXT });
  return {
    type: "array",
    maxItems: MAX,
    items: object(
      {
        nodeId: NAME,
        queueSize: COUNT,
        lastConsumedOperation: operation,
        lastOperationInQueue: operation,
      },
      ["nodeId"],
    ),
  };
}
function read(
  description: string,
  input: CatalogJsonObject,
  result: CatalogJsonObject,
  maxResultCount = 1,
): JiraNativeDefinition {
  return { description, input, result: jiraNativeReadResult(result), risk: "read", maxResultCount };
}
export const JIRA_MAINTENANCE_READ_DEFINITIONS = {
  "jira.cluster-nodes": read(
    "Observe and locally page the bounded native Data Center cluster-node list. Preserve supplied node state, liveness, build/version and last-state-change numeric metadata without guessing unknown state codes, interpreting numeric sentinels or granting authority. Missing fields stay unknown; network addresses and listener ports are omitted. No node is activated, stopped, restarted or removed.",
    object(PAGING),
    {
      items: { type: "array", maxItems: 100, items: NODE },
      startAt: PAGING.startAt,
      total: { type: "integer", minimum: 0, maximum: MAX },
      nextStartAt: PAGING.startAt,
    },
    100,
  ),
  "jira.cluster-upgrade-state": read(
    "Observe the native cluster-upgrade state text and supplied build metadata. Preserve bounded unfamiliar state codes instead of mapping them to a guessed lifecycle or readiness verdict. Missing state/build values remain unknown. This read does not approve an upgrade, run upgrade tasks, change cluster state or qualify release compatibility.",
    object({}),
    { state: OBSERVED_TEXT, build: BUILD },
  ),
  "jira.index-snapshot-status": read(
    "Observe the optional native snapshot-running boolean through the fixed status endpoint. Preserve false and unknown separately; a false status is not evidence that a snapshot exists, completed or is usable. No index snapshot is started, restored or downloaded and no job is scheduled.",
    object({}),
    { running: BOOL },
  ),
  "jira.index-summary": read(
    "Inspect the current node's observed index summary, optional issue counts/readability and separate replication versus external-platform replay queues. Missing maps or metrics stay unknown; explicit empty queues and zero counts remain observed values. Keep native timestamps as text and exact safe numeric operation IDs without calculating health, completeness or lag from local time. No reindex, replication, repair or snapshot effect occurs.",
    object({}),
    {
      nodeId: NAME,
      reportTime: OBSERVED_TEXT,
      issueIndex: ISSUE_INDEX,
      replicationQueues: queues("replicationTime"),
      externalPlatformIndexReplay: queues("journalWriteTime"),
    },
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraMaintenanceDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_MAINTENANCE_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
