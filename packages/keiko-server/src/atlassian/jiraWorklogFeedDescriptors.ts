import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeDeclaration,
  jiraNativeReadResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const TIMESTAMP = {
  anyOf: [{ type: "string", enum: ["0"] }, ID],
  description:
    "Exact nonnegative decimal Unix millisecond timestamp as a string, at most 9223372036854775807. Native JSON integers must be safely representable before conversion; never round an unsafe number.",
};
function definition(changeType: "deleted" | "updated"): JiraNativeDefinition {
  return {
    input: object({ since: TIMESTAMP }),
    risk: "read",
    maxResultCount: TOOL_CATALOG_LIMITS.maxArrayItems,
    description: `Read one complete native page of ${changeType} worklog IDs and change timestamps since the requested inclusive Unix-millisecond cursor (default "0"). Native permission, retention and time-window rules apply; this is not all issues, all history, worklog detail, a count total, or a proof of absence. Jira excludes the latest minute. No synthetic maxResults or offset is supported. Preserve native order and all rows; if bounds prevent a complete page, refuse it rather than skipping a prefix. isLastPage refers only to the native response window. nextSince is the unchanged native until cursor when another page exists and it advances; never add one, follow a response URL, or silently omit equal-time changes. A supplied nextPage must name the fixed matching native route with exactly this cursor. No worklog or estimate changes.`,
    result: jiraNativeReadResult({
      changeType: { type: "string", enum: [changeType] },
      feedScope: { type: "string", enum: ["native-visible-change-window"] },
      timeUnit: { type: "string", enum: ["unix-milliseconds"] },
      excludesLatestMinute: { type: "boolean", enum: [true] },
      since: TIMESTAMP,
      until: TIMESTAMP,
      isLastPage: { type: "boolean" },
      nextSince: TIMESTAMP,
      items: {
        type: "array",
        maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
        items: object({ worklogId: ID, changedAt: TIMESTAMP }, ["worklogId", "changedAt"]),
      },
    }),
  };
}
export const JIRA_WORKLOG_FEED_READ_DEFINITIONS = {
  "jira.deleted-worklogs": definition("deleted"),
  "jira.updated-worklogs": definition("updated"),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraWorklogFeedDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_WORKLOG_FEED_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
