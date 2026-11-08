import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativePagingSchema as PAGING,
  jiraNativeDeclaration,
  jiraNativeReadResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const OBSERVED_TEXT = { ...text(128), minLength: 1 };
const INTEGER = { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const COUNT = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const BOOL = { type: "boolean" };
const IDS = { type: "array", maxItems: MAX, uniqueItems: true, items: ID };
const REINDEX_FIELDS = {
  currentProgress: INTEGER,
  currentSubTask: text(4096),
  finishTime: OBSERVED_TEXT,
  startTime: OBSERVED_TEXT,
  submittedTime: OBSERVED_TEXT,
  success: BOOL,
  type: OBSERVED_TEXT,
};
const REQUEST_FIELDS = {
  id: ID,
  completionTime: OBSERVED_TEXT,
  requestTime: OBSERVED_TEXT,
  startTime: OBSERVED_TEXT,
  status: OBSERVED_TEXT,
  type: OBSERVED_TEXT,
};
const TASK_CONTEXT = {
  taskSelection: { type: "string", enum: ["active-or-latest", "selected-task"] },
  selectedTaskId: ID,
};
function page(item: CatalogJsonObject): CatalogJsonObject {
  return {
    items: { type: "array", maxItems: 100, items: item },
    startAt: PAGING.startAt,
    total: { type: "integer", minimum: 0, maximum: MAX },
    nextStartAt: PAGING.startAt,
  };
}
function read(description: string, input: CatalogJsonObject, result: CatalogJsonObject, maxResultCount = 1): JiraNativeDefinition {
  return { description, input, result: jiraNativeReadResult(result), risk: "read", maxResultCount };
}
export const JIRA_JOB_OBSERVATION_READ_DEFINITIONS = {
  "jira.reindex-status": {
    ...read(
      "Observe the active reindex task or, when none is active, the latest task, optionally requesting one exact task ID. The returned native bean has no task identity: selectedTaskId records requested context only. Preserve supplied progress, subtask, times, type and success without converting progress to a percentage or inferring completion from missing values. Only the documented unselected GET/reindex404 means no-prior-task, with no invented task identity, progress, success or zero metrics. A selected taskId404 remains a refusal. No task is started, resumed or scheduled.",
      object({ taskId: ID }), {},
    ),
    result: { anyOf: [
      jiraNativeReadResult({ ...REINDEX_FIELDS, ...TASK_CONTEXT }),
      { ...jiraNativeReadResult({ taskSelection: { type: "string", enum: ["active-or-latest"] }, taskState: { type: "string", enum: ["no-prior-task"] } }),
        required: ["outcome", "taskSelection", "taskState"],
        allOf: [{ properties: { outcome: { type: "string", enum: ["succeeded"] } } }],
      },
    ] },
  },
  "jira.reindex-progress": read(
    "Read one on-demand observation from the native reindex progress endpoint, optionally for an exact requested task ID. Without a selector Jira chooses its active-or-latest task. Keep supplied progress and outcome facts separate from Keiko read success; unknown values stay unknown. No polling loop, reindex start, retry job or cancellation effect is created.",
    object({ taskId: ID }),
    { ...REINDEX_FIELDS, ...TASK_CONTEXT },
  ),
  "jira.reindex-request": read(
    "Inspect one reindex request by exact ID and require the observed native identity to match. Preserve supplied status/type text and timestamps without guessing unrecognized lifecycle codes or manufacturing completion. This does not submit, alter or resume a request.",
    object({ requestId: ID }, ["requestId"]),
    REQUEST_FIELDS,
  ),
  "jira.reindex-requests": read(
    "Observe an explicit nonempty set of reindex request IDs and locally page only the matching native responses. requestedRequestIds and unreturnedRequestIds describe the complete bounded native response before local paging; unreturned does not assert nonexistent or completed. Refuse duplicate or foreign returned identities. No reindex request is submitted or changed.",
    object({ requestIds: { ...IDS, minItems: 1 }, ...PAGING }, ["requestIds"]),
    {
      ...page(object(REQUEST_FIELDS, ["id"])),
      requestScope: { type: "string", enum: ["selected-requests"] },
      requestedRequestIds: { ...IDS, minItems: 1 },
      unreturnedRequestIds: IDS,
    },
    100,
  ),
  "jira.upgrade-result": read(
    "Observe the last native upgrade result. Documented HTTP303 means running and HTTP404 means no-prior-result; neither redirects nor starts work. A successful read of HTTP200 reports upgradeState=result and preserves the remote upgradeOutcome separately, which may itself be a failure. Optional duration/message/start-time remain observations without local clock or readiness inference.",
    object({}),
    {
      upgradeState: { type: "string", enum: ["result", "running", "no-prior-result"] },
      upgradeOutcome: OBSERVED_TEXT,
      duration: COUNT,
      message: text(TOOL_CATALOG_LIMITS.maxStringBytes),
      startTime: OBSERVED_TEXT,
    },
  ),
  "jira.index-snapshots": read(
    "List and locally page observed native index-snapshot metadata. absolutePath is Jira-reported text, never a local file reference or destination to open, download or follow. Preserve optional timestamps as exact safe numeric observations. No snapshot creation, restore, transfer or filesystem operation occurs.",
    object(PAGING),
    page(object({ absolutePath: { ...text(4096), minLength: 1 }, timestamp: INTEGER }, ["absolutePath"])),
    100,
  ),
  "jira.app-monitoring": read(
    "Observe the supplied native App Monitoring enabled flag, keeping false distinct from unavailable metadata. No monitoring is started or stopped and no metric content, network reachability or actor permission is inferred.",
    object({}),
    { enabled: BOOL },
  ),
  "jira.ipd-monitoring": read(
    "Observe the supplied native in-product diagnostics monitoring enabled flag. Missing state remains unknown. No monitoring configuration changes, background collection, job scheduling or permission grants occur.",
    object({}),
    { enabled: BOOL },
  ),
  "jira.jmx-metrics": read(
    "Read the bounded native available-JMX-metrics description as plain text, including an explicitly empty string. Do not parse it as a schema, command, endpoint list or executable request and do not follow embedded destinations. This read changes no metric exposure or monitoring configuration.",
    object({}),
    { metricsText: text(TOOL_CATALOG_LIMITS.maxStringBytes) },
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraJobObservationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_JOB_OBSERVATION_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
