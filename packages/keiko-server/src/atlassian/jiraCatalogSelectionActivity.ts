import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
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

const BYTES = { type: "integer", dataClass: "count", required: true } as const;

/**
 * A Jira tool selection the gateway could not bind, so it was refused before it replaced the earlier
 * one. The counts say how large the offered parts were against the one bound each of them keeps, and
 * which part reached it; never an identity, a tool name or content.
 */
const JIRA_CATALOG_SELECTION_REFUSED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "jira.catalog.selection-refused",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraCatalogSelectionActivity.recordJiraCatalogSelectionRefused",
  fields: {
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["chat", "coding"],
    },
    requestedCount: COUNT,
    catalogBytes: BYTES,
    projectionBytes: BYTES,
    offeredBytes: BYTES,
    boundBytes: BYTES,
    exceeded: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["catalog", "projection", "offered", "none", "not-built"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-action-execution"],
  proofIds: ["jira.catalog.selection-refused.line"],
  releaseImpact: "patch",
});

/** The parts of a binding whose serialized size the refusal reports. */
export interface RefusedSelectionParts {
  readonly catalog: unknown;
  readonly projection: unknown;
  readonly offered: unknown;
}

function serializedBytes(value: unknown): number {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
}

/** Records the refusal of a selection the gateway could not bind; the earlier selection is kept. */
export function recordJiraCatalogSelectionRefused(
  log: ServerLogSink,
  input: {
    readonly correlationId: string;
    readonly surface: "chat" | "coding";
    readonly requestedCount: number;
    /** Absent when the selection was refused before its catalog could be built. */
    readonly parts?: RefusedSelectionParts;
  },
): void {
  const bound = TOOL_CATALOG_LIMITS.maxArgumentBytes;
  const sizes = {
    catalog: serializedBytes(input.parts?.catalog),
    projection: serializedBytes(input.parts?.projection),
    offered: serializedBytes(input.parts?.offered),
  };
  const exceeded = (["catalog", "projection", "offered"] as const).find(
    (part) => sizes[part] > bound,
  );
  try {
    log.write(
      activityLogEvent(
        JIRA_CATALOG_SELECTION_REFUSED,
        { correlationId: input.correlationId, level: "info" },
        {
          surface: input.surface,
          requestedCount: input.requestedCount,
          catalogBytes: sizes.catalog,
          projectionBytes: sizes.projection,
          offeredBytes: sizes.offered,
          boundBytes: bound,
          exceeded: input.parts === undefined ? "not-built" : (exceeded ?? "none"),
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch {
    recordActivityLogLoss("port-sink-failed");
  }
}
