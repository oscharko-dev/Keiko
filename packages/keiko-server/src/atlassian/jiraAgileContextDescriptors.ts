import { ATLASSIAN_JQL_MAX_CHARS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  jiraAgileIssueResultSchema as ISSUE,
  jiraAgileIssueFields,
  jiraAgileReferenceSchema,
} from "./jiraAgileDescriptors.js";
import { jiraFieldIdSchema } from "./jiraScopedDirectoryDescriptors.js";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as KEY,
  jiraNativePagingSchema as PAGING,
  jiraNativeVersionFields,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const AGILE_ID = {
  ...text(16),
  allOf: [{ pattern: "^[1-9]" }, { pattern: "^[0-9]{1,16}$" }],
  description: "Canonical positive decimal identity no greater than 9007199254740991.",
};
const BOOL = { type: "boolean" };
const PROJECT = object({
  id: ID, key: KEY, name: { ...text(255), minLength: 1 }, description: text(32768), archived: BOOL,
}, ["id", "key", "name"]);
const VERSION = object({ ...jiraNativeVersionFields, versionId: ID, projectId: ID }, ["versionId", "name"]);
const ISSUE_PAGE = { ...PAGING, jql: { ...text(ATLASSIAN_JQL_MAX_CHARS), minLength: 1 } };
const SINGLE_ISSUE = object({
  ...jiraAgileIssueFields,
  description: text(TOOL_CATALOG_LIMITS.maxStringBytes),
  reporter: jiraAgileReferenceSchema,
  duedate: text(64),
}, ["id", "key", "summary", "browseUrl"]);
function page(item: CatalogJsonObject): CatalogJsonObject {
  return {
    items: { type: "array", maxItems: 100, items: item },
    startAt: PAGING.startAt,
    total: PAGING.startAt,
    nextStartAt: PAGING.startAt,
  };
}
function read(description: string, input: CatalogJsonObject, result: CatalogJsonObject, maxResultCount = 100): JiraNativeDefinition {
  return { description, input, result: jiraNativeReadResult(result), risk: "read", maxResultCount };
}
function issues(scope: "visible-board-issues" | "visible-epicless-issues", context: CatalogJsonObject = {}): CatalogJsonObject {
  return { ...page(ISSUE), ...context, collectionScope: { type: "string", enum: [scope] } };
}

export const JIRA_AGILE_CONTEXT_READ_DEFINITIONS = {
  "jira.board-epicless-issues": read(
    "Read a native page of visible issues without an epic in one board context, optionally narrowed by bounded JQL. Use the fixed standard issue projection and native query validation. Preserve board ID and visible-board-issues scope; empty results do not assert global absence or grant membership-edit authority.",
    object({ boardId: AGILE_ID, ...ISSUE_PAGE }, ["boardId"]),
    issues("visible-board-issues", { boardId: AGILE_ID }),
  ),
  "jira.board-epic-issues": read(
    "Read a native page of issues in the selected epic as visible through one board, optionally narrowed by bounded JQL. Preserve both board and epic IDs and fixed issue summaries. This scoped view does not assert global epic membership completeness or permission to move issues.",
    object({ boardId: AGILE_ID, epicId: AGILE_ID, ...ISSUE_PAGE }, ["boardId", "epicId"]),
    issues("visible-board-issues", { boardId: AGILE_ID, epicId: AGILE_ID }),
  ),
  "jira.board-projects": read(
    "First confirm the visible board, then read a native page of projects associated with it. Retain the board context and visible-board-projects scope with observed project metadata. An unreadable board is not an empty association list; visibility does not grant project administration or issue-edit permissions.",
    object({ boardId: AGILE_ID, ...PAGING }, ["boardId"]),
    { ...page(PROJECT), boardId: AGILE_ID, collectionScope: { type: "string", enum: ["visible-board-projects"] } },
  ),
  "jira.board-refined-velocity": read(
    "Read the native refined-velocity boolean setting of one board. Require the supplied value and preserve false as an observed value, never as a missing default. Do not infer sprint velocity, completed work, Scrum type or permission to change board settings.",
    object({ boardId: AGILE_ID }, ["boardId"]),
    { boardId: AGILE_ID, value: BOOL },
    1,
  ),
  "jira.board-sprint-issues": read(
    "Read a native page of issues in one sprint through the selected board, optionally narrowed by bounded JQL. Preserve board/sprint context and visible-board-issues scope with native continuation. This does not establish cross-board completeness or permission to alter sprint membership.",
    object({ boardId: AGILE_ID, sprintId: AGILE_ID, ...ISSUE_PAGE }, ["boardId", "sprintId"]),
    issues("visible-board-issues", { boardId: AGILE_ID, sprintId: AGILE_ID }),
  ),
  "jira.board-versions": read(
    "First confirm the visible board, then read a native page of its versions, optionally filtered by explicit released state. Preserve supplied metadata and visible-board-versions scope. Missing per-version project IDs remain unknown; native date parts are preserved without a timezone conversion. No release, archive or version changes.",
    object({ boardId: AGILE_ID, released: BOOL, ...PAGING }, ["boardId"]),
    { ...page(VERSION), boardId: AGILE_ID, collectionScope: { type: "string", enum: ["visible-board-versions"] } },
  ),
  "jira.epicless-issues": read(
    "Read a native page of visible issues without an epic across the actor's current Agile visibility, optionally narrowed by bounded JQL. Keep visible-epicless-issues scope and native paging rather than claiming instance completeness. No board, epic, rank or issue mutation occurs.",
    object(ISSUE_PAGE),
    issues("visible-epicless-issues"),
  ),
  "jira.agile-issue": read(
    "Read the exact visible issue through the native Agile endpoint using the fixed standard issue projection. Bind the observed numeric ID or canonical key to the selector and keep updateHistory disabled. This read does not modify issue history, expose arbitrary expansions or imply available workflow transitions.",
    object({ issueIdOrKey: KEY }, ["issueIdOrKey"]),
    { items: { type: "array", maxItems: 1, items: SINGLE_ISSUE }, startAt: { type: "integer", enum: [0] }, total: { type: "integer", enum: [1] } },
    1,
  ),
  "jira.issue-estimation": read(
    "Bind the observed issue identity, then read its native estimation field/value for the required board. Preserve field ID and observed scalar value only; missing or null value stays unknown, including no invented zero. The response does not identify units, define a release gate or grant permission to edit the estimate.",
    object({ issueIdOrKey: KEY, boardId: AGILE_ID }, ["issueIdOrKey", "boardId"]),
    {
      boardId: AGILE_ID, issueId: ID, issueKey: KEY, fieldId: jiraFieldIdSchema,
      value: { anyOf: [text(2048), { type: "number", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }] },
    },
    1,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraAgileContextDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_AGILE_CONTEXT_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
