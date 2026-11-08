import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";
import type { JiraAgileDetails, JiraOutcomeFact } from "./jira-agile-presentation";
import {
  jiraPresentationFact as fact,
  jiraPresentationRecord as record,
  jiraPresentationText as text,
  type JiraPresentationSource as Source,
} from "./jira-presentation-values";

export const JIRA_MAINTENANCE_TOOLS: ReadonlySet<string> = new Set([
  "jira_cluster_nodes",
  "jira_cluster_upgrade_state",
  "jira_index_snapshot_status",
  "jira_index_summary",
]);
const INDEX_COUNTS: Readonly<Record<string, WidgetMessageKey>> = {
  countInArchive: "chat.jira.maintenance.archiveCount",
  countInDatabase: "chat.jira.maintenance.databaseCount",
  countInIndex: "chat.jira.maintenance.indexCount",
};
function integerFact(label: WidgetMessageKey, value: unknown, signed = false): JiraOutcomeFact[] {
  return typeof value === "number" && Number.isSafeInteger(value) && (signed || value >= 0)
    ? fact(label, String(value))
    : [];
}
function node(source: Source): JiraAgileDetails | undefined {
  const id = text(source.nodeId);
  if (id === undefined) return undefined;
  const labels: WidgetMessageKey[] = [
    "chat.jira.maintenance.observation",
    source.alive === true
      ? "chat.jira.maintenance.alive"
      : source.alive === false
        ? "chat.jira.maintenance.notAlive"
        : "chat.jira.maintenance.aliveUnknown",
  ];
  if (text(source.state) === undefined) labels.push("chat.jira.maintenance.stateUnknown");
  const timestamp = integerFact(
    "chat.jira.maintenance.stateTimestamp",
    source.lastStateChangeTimestamp,
    true,
  );
  if (timestamp.length === 0) labels.push("chat.jira.maintenance.stateTimestampUnknown");
  return {
    facts: [
      { label: "chat.jira.maintenance.nodeId", value: id },
      ...fact("chat.jira.maintenance.state", source.state),
      ...fact("chat.jira.maintenance.version", source.nodeVersion),
      ...integerFact("chat.jira.maintenance.build", source.nodeBuildNumber, true),
      ...timestamp,
    ],
    labels,
  };
}
function upgrade(source: Source): JiraAgileDetails {
  const build = record(source.build);
  return {
    facts: [
      ...fact("chat.jira.maintenance.state", source.state),
      ...fact("chat.jira.maintenance.version", build?.version),
      ...integerFact("chat.jira.maintenance.build", build?.buildNumber, true),
    ],
    labels: [
      "chat.jira.maintenance.observation",
      ...(text(source.state) === undefined
        ? (["chat.jira.maintenance.stateUnknown"] as const)
        : []),
    ],
  };
}
function snapshot(source: Source): JiraAgileDetails {
  return {
    facts: [],
    labels: [
      "chat.jira.maintenance.observation",
      source.running === true
        ? "chat.jira.maintenance.snapshotRunning"
        : source.running === false
          ? "chat.jira.maintenance.snapshotNotRunning"
          : "chat.jira.maintenance.snapshotUnknown",
    ],
  };
}
function index(source: Source): JiraAgileDetails {
  const counts = Object.entries(INDEX_COUNTS).flatMap(([key, label]) =>
    integerFact(label, source[key]),
  );
  const labels: WidgetMessageKey[] = [
    "chat.jira.maintenance.indexCountsScope",
    source.indexReadable === true
      ? "chat.jira.maintenance.indexReadable"
      : source.indexReadable === false
        ? "chat.jira.maintenance.indexUnreadable"
        : "chat.jira.maintenance.indexReadableUnknown",
  ];
  if (counts.length !== Object.keys(INDEX_COUNTS).length)
    labels.push("chat.jira.maintenance.countsUnknown");
  const dates = [
    ...fact("chat.jira.maintenance.databaseUpdated", source.lastUpdatedInDatabase),
    ...fact("chat.jira.maintenance.indexUpdated", source.lastUpdatedInIndex),
  ];
  if (dates.length < 2) labels.push("chat.jira.maintenance.indexTimesUnknown");
  return { facts: [...counts, ...dates], labels };
}
function operationFacts(source: Source | undefined, consumed: boolean): JiraOutcomeFact[] {
  return [
    ...integerFact(
      consumed ? "chat.jira.maintenance.consumedId" : "chat.jira.maintenance.queuedId",
      source?.id,
      true,
    ),
    ...fact(
      consumed
        ? "chat.jira.maintenance.consumedReplication"
        : "chat.jira.maintenance.queuedReplication",
      source?.replicationTime,
    ),
    ...fact(
      consumed ? "chat.jira.maintenance.consumedJournal" : "chat.jira.maintenance.queuedJournal",
      source?.journalWriteTime,
    ),
  ];
}
function operationTimeUnknown(source: Source | undefined): boolean {
  return (
    text(source?.replicationTime) === undefined && text(source?.journalWriteTime) === undefined
  );
}
function queue(value: unknown, replay: boolean): JiraAgileDetails | undefined {
  const source = record(value);
  const id = text(source?.nodeId);
  if (source === undefined || id === undefined) return undefined;
  const size = integerFact("chat.jira.maintenance.queueSize", source.queueSize);
  const consumedSource = record(source.lastConsumedOperation);
  const queuedSource = record(source.lastOperationInQueue);
  const consumed = operationFacts(consumedSource, true);
  const queued = operationFacts(queuedSource, false);
  const labels: WidgetMessageKey[] = [
    replay ? "chat.jira.maintenance.externalReplay" : "chat.jira.maintenance.replicationQueue",
  ];
  if (size.length === 0) labels.push("chat.jira.maintenance.queueSizeUnknown");
  if (consumed.length === 0) labels.push("chat.jira.maintenance.consumedUnknown");
  if (queued.length === 0) labels.push("chat.jira.maintenance.queuedUnknown");
  if (operationTimeUnknown(consumedSource))
    labels.push("chat.jira.maintenance.consumedTimeUnknown");
  if (operationTimeUnknown(queuedSource)) labels.push("chat.jira.maintenance.queuedTimeUnknown");
  return {
    facts: [{ label: "chat.jira.maintenance.nodeId", value: id }, ...size, ...consumed, ...queued],
    labels,
  };
}
function queues(value: unknown, replay: boolean): readonly JiraAgileDetails[] {
  if (!Array.isArray(value))
    return [
      {
        facts: [],
        labels: [
          replay ? "chat.jira.maintenance.replayUnknown" : "chat.jira.maintenance.queuesUnknown",
        ],
      },
    ];
  const entries = value.map((entry: unknown) => queue(entry, replay));
  if (entries.some((entry) => entry === undefined))
    return [
      {
        facts: [],
        labels: [
          replay ? "chat.jira.maintenance.replayUnknown" : "chat.jira.maintenance.queuesUnknown",
        ],
      },
    ];
  return [
    {
      facts: [
        {
          label: replay
            ? "chat.jira.maintenance.replayReturned"
            : "chat.jira.maintenance.queuesReturned",
          value: String(entries.length),
        },
      ],
      labels: [],
    },
    ...entries.filter((entry) => entry !== undefined),
  ];
}
function summary(source: Source): readonly JiraAgileDetails[] {
  const issueIndex = record(source.issueIndex);
  const labels: WidgetMessageKey[] = ["chat.jira.maintenance.observation"];
  if (text(source.reportTime) === undefined) labels.push("chat.jira.maintenance.reportTimeUnknown");
  return [
    {
      facts: [
        ...fact("chat.jira.maintenance.nodeId", source.nodeId),
        ...fact("chat.jira.maintenance.reportTime", source.reportTime),
      ],
      labels,
    },
    ...(issueIndex === undefined
      ? [
          {
            facts: [],
            labels: ["chat.jira.maintenance.issueIndexUnknown"],
          } satisfies JiraAgileDetails,
        ]
      : [index(issueIndex)]),
    ...queues(source.replicationQueues, false),
    ...queues(source.externalPlatformIndexReplay, true),
  ];
}
function clusterNodes(data: Source): readonly JiraAgileDetails[] {
  const items = (Array.isArray(data.items) ? data.items : [data]).flatMap((value: unknown) => {
    const source = record(value);
    const item = source === undefined ? undefined : node(source);
    return item === undefined ? [] : [item];
  });
  return Array.isArray(data.items) && items.length === 0
    ? [{ facts: [], labels: ["chat.jira.maintenance.observation"] }]
    : items;
}
/** Native maintenance observations do not start jobs, assert global health or derive lag from clocks. */
export function jiraMaintenanceDetails(tool: string, data: Source): readonly JiraAgileDetails[] {
  if (!JIRA_MAINTENANCE_TOOLS.has(tool) || data.outcome === "failed") return [];
  if (tool === "jira_cluster_nodes") {
    return clusterNodes(data);
  }
  if (data.outcome !== "succeeded" && Object.keys(data).length === 0) return [];
  if (tool === "jira_cluster_upgrade_state") return [upgrade(data)];
  return tool === "jira_index_snapshot_status" ? [snapshot(data)] : summary(data);
}
