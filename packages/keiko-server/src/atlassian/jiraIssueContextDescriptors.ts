import { ATLASSIAN_JQL_MAX_CHARS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  jiraAgileIssueResultSchema,
  jiraAgileReferenceSchema,
} from "./jiraAgileDescriptors.js";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraRemoteLinkSnapshotSchema } from "./jiraRemoteLinkSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as KEY,
  jiraNativePagingSchema as PAGING,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const BOOL = { type: "boolean" };
const NAME = { ...text(255), minLength: 1 };
const CONTEXT = { issueId: ID, issueKey: KEY };
const TARGET = { issueIdOrKey: KEY };
const REMOTE_FIELDS = {
  id: ID,
  globalId: { ...text(2048), minLength: 1 },
  application: object({ type: NAME, name: NAME }),
  relationship: NAME,
  title: NAME,
  summary: text(32768),
  resolved: BOOL,
  reviewSnapshotAvailable: BOOL,
  reviewSnapshot: jiraRemoteLinkSnapshotSchema,
};
const REMOTE_LINK = object(REMOTE_FIELDS, ["id"]);
const PINNED_COMMENT = object({
  id: ID,
  body: text(TOOL_CATALOG_LIMITS.maxStringBytes),
  created: text(64),
  author: jiraAgileReferenceSchema,
  pinnedBy: NAME,
  pinnedDate: { ...text(64), minLength: 1 },
}, ["id", "body", "created"]);
const SUGGESTION = object({
  key: KEY,
  browseUrl: text(4096),
  summary: text(255),
}, ["key", "browseUrl"]);
const SECTION = object({
  id: NAME,
  label: NAME,
  issues: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: SUGGESTION },
});
function page(item: CatalogJsonObject): CatalogJsonObject {
  return {
    items: { type: "array", maxItems: 100, items: item },
    startAt: PAGING.startAt,
    total: PAGING.startAt,
    nextStartAt: PAGING.startAt,
  };
}
function read(
  description: string,
  input: CatalogJsonObject,
  result: CatalogJsonObject,
  maxResultCount = 100,
): JiraNativeDefinition {
  return { description, input, result: jiraNativeReadResult(result), risk: "read", maxResultCount };
}

export const JIRA_ISSUE_CONTEXT_READ_DEFINITIONS = {
  "jira.issue-picker": read(
    "Read bounded native issue-picker suggestions with optional query/JQL and explicit issue/project context. Resolve any supplied context before the fixed picker request. Preserve native sections and the distinction between an omitted issue list and an observed empty list; no total or continuation is inferred. Summaries are plain summaryText and links are derived from the trusted Jira base. Suggestions neither execute an unrestricted search nor grant issue access or edit authority.",
    object({
      query: text(255),
      currentJQL: text(ATLASSIAN_JQL_MAX_CHARS),
      currentIssueKey: KEY,
      currentProjectId: ID,
      showSubTasks: BOOL,
      showSubTaskParent: BOOL,
    }),
    {
      sections: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: SECTION },
      suggestionsScope: { type: "string", enum: ["native-suggestions"] },
    },
    TOOL_CATALOG_LIMITS.maxArrayItems,
  ),
  "jira.pinned-comments": read(
    "Resolve the issue's canonical identity, then read and locally page its complete bounded native pinned-comment collection. Reuse the existing plain comment body, author and timestamp projection, with pin actor/date only when observed. Supplied comment self metadata must match the bound parent and comment; it is never followed. Missing pin metadata stays unknown and no comment is pinned, unpinned or edited.",
    object({ ...TARGET, ...PAGING }, ["issueIdOrKey"]),
    { ...CONTEXT, ...page(PINNED_COMMENT) },
  ),
  "jira.subtasks": read(
    "Resolve the issue's canonical identity and locally page its complete bounded native subtask references using the existing issue-summary projection. Compare any supplied parent ID/key with that context. Missing parent metadata is not invented, and contradictory membership is refused. This reads the visible collection without changing parentage or subtask order.",
    object({ ...TARGET, ...PAGING }, ["issueIdOrKey"]),
    { ...CONTEXT, ...page(jiraAgileIssueResultSchema) },
  ),
  "jira.subtask-move-availability": read(
    "Resolve the exact issue, then observe Jira's boolean subtask reordering availability. Preserve both true and false with canonical issue identity. This does not move a subtask, change its parent or grant permission to execute a mutation; it is only the native availability observation at read time.",
    object(TARGET, ["issueIdOrKey"]),
    { ...CONTEXT, canReorderSubtasks: BOOL },
    1,
  ),
  "jira.remote-links": read(
    "Resolve the issue and read its bounded native remote-link metadata. Without globalId return a local page of the complete collection; with globalId return the single matching native object without paging. A complete supported native bean also yields reviewSnapshot with exact ID and all nullable replacement facts, including validated URL/icon addresses as plain text only. reviewSnapshotAvailable:false means the full value cannot be reviewed; do not guess or replace unknown fields. No remote URL is followed or turned into a browse link and no link is changed.",
    {
      anyOf: [
        object({ ...TARGET, ...PAGING }, ["issueIdOrKey"]),
        object({ ...TARGET, globalId: REMOTE_FIELDS.globalId }, ["issueIdOrKey", "globalId"]),
      ],
    },
    { ...CONTEXT, ...REMOTE_FIELDS, ...page(REMOTE_LINK) },
  ),
  "jira.remote-link": read(
    "Resolve the issue and read one exact native remote-link ID under its observed numeric parent. Compare supplied self metadata without following it and require the returned ID to match. Preserve bounded wording and resolved state; a complete supported native bean additionally yields reviewSnapshot with all nullable replacement facts. URL and icon addresses in that snapshot are validated plain text, never browse links or fetch targets. An unavailable snapshot stays explicitly unavailable and must not be synthesized.",
    object({ ...TARGET, linkId: ID }, ["issueIdOrKey", "linkId"]),
    { ...CONTEXT, ...REMOTE_FIELDS },
    1,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraIssueContextDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_ISSUE_CONTEXT_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
