import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

const COUNT = { type: "integer", dataClass: "count", required: true } as const;

/**
 * A published Jira tool selection. `jira.describe` replaces the previous selection, so the line
 * records how many operations stayed, were added and were dropped; never an identity or tool name.
 */
const JIRA_CATALOG_SELECTION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "jira.catalog.selection",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraCatalogSelectionActivity.recordJiraCatalogSelection",
  fields: {
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["chat", "coding"],
    },
    selectedCount: COUNT,
    retainedCount: COUNT,
    deselectedCount: COUNT,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-action-execution"],
  proofIds: ["jira.catalog.selection.line"],
  releaseImpact: "patch",
});

/** Records a published selection that replaced `previous`; identities themselves stay private. */
export function recordJiraCatalogSelection(
  log: ServerLogSink,
  input: {
    readonly correlationId: string;
    readonly surface: "chat" | "coding";
    readonly previous: readonly string[];
    readonly selected: readonly string[];
  },
): void {
  const selected = new Set(input.selected);
  const previous = new Set(input.previous);
  const retainedCount = [...previous].filter((identity) => selected.has(identity)).length;
  try {
    log.write(
      activityLogEvent(
        JIRA_CATALOG_SELECTION,
        { correlationId: input.correlationId, level: "info" },
        {
          surface: input.surface,
          selectedCount: selected.size,
          retainedCount,
          deselectedCount: previous.size - retainedCount,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch {
    recordActivityLogLoss("port-sink-failed");
  }
}
