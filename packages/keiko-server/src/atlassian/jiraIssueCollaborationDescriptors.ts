import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeCollectionResult,
  jiraNativeReadResult,
  jiraNativeWriteResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const ID = {
  ...text(19),
  allOf: [{ pattern: "^[1-9]" }, { pattern: "^[0-9]{1,19}$" }],
  description: "Canonical positive decimal int64 string, no greater than 9223372036854775807.",
};
const ISSUE = {
  ...text(128),
  allOf: [{ pattern: "^[A-Za-z0-9~]" }, { not: { pattern: "[^A-Za-z0-9._~-]" } }],
};
const PAGING = {
  startAt: { type: "integer", minimum: 0, maximum: 1_000_000 },
  maxResults: { type: "integer", minimum: 1, maximum: 100 },
};
const AUTHOR = { authorName: text(255), authorDisplayName: text(255) };
const DATES = { started: text(40), created: text(40), updated: text(40) };
const VISIBILITY = object(
  { type: { type: "string", enum: ["group", "role"] }, value: { ...text(255), minLength: 1 } },
  ["type", "value"],
);
const COMMENT = object(
  {
    id: ID,
    issueKey: ISSUE,
    body: text(32768),
    ...AUTHOR,
    created: text(40),
    updated: text(40),
    visibility: VISIBILITY,
  },
  ["id", "issueKey", "body"],
);
const LINK_TYPE = { id: ID, name: text(255), inward: text(255), outward: text(255) };
export { LINK_TYPE as jiraNativeLinkTypeFields };
const WORKLOG = object(
  {
    id: ID,
    issueKey: ISSUE,
    timeSpentSeconds: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    comment: text(32768),
    ...AUTHOR,
    ...DATES,
  },
  ["id", "issueKey", "timeSpentSeconds"],
);
function single(item: CatalogJsonObject): CatalogJsonObject {
  return jiraNativeReadResult({ items: { type: "array", maxItems: 1, items: item } });
}

export const JIRA_ISSUE_COLLABORATION_READ_DEFINITIONS = {
  "jira.worklogs-by-id": {
    description:
      "Read the accessible subset of an explicitly selected bounded set of worklog IDs through native POST. This is a read and creates no worklog. Bind each returned parent issue independently and reuse the existing worklog projection. Native permissions can omit requested IDs; unreturnedWorklogIds is not absence evidence, zero work or a complete project collection. There is no invented native total or pagination. IDs requiring inexact JSON numeric conversion are refused before transport.",
    input: object(
      {
        worklogIds: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: {
            ...ID,
            description:
              "Exact positive decimal ID no greater than Number.MAX_SAFE_INTEGER for the native numeric JSON body.",
          },
        },
      },
      ["worklogIds"],
    ),
    result: jiraNativeReadResult({
      selectionScope: { type: "string", enum: ["native-visible-requested-worklogs"] },
      requestedCount: { type: "integer", minimum: 1, maximum: 100 },
      returnedCount: { type: "integer", minimum: 0, maximum: 100 },
      unreturnedWorklogIds: { type: "array", maxItems: 100, uniqueItems: true, items: ID },
      items: { type: "array", maxItems: 100, items: WORKLOG },
    }),
    risk: "read",
    maxResultCount: 100,
  },
  "jira.get-comment": {
    description:
      "Read one exact issue comment, its body and available author/time/visibility metadata. Visibility remains unknown when Jira omits it; no remote URLs are exposed.",
    input: object({ issueKey: ISSUE, commentId: ID }, ["issueKey", "commentId"]),
    result: single(COMMENT),
    risk: "read",
    maxResultCount: 1,
  },
  "jira.link-types": {
    description:
      "Read and locally page the complete bounded native issue-link type collection, including each relation's inward and outward wording. Follow nextStartAt.",
    input: object(PAGING),
    result: jiraNativeCollectionResult(object(LINK_TYPE, ["id", "name", "inward", "outward"])),
    risk: "read",
    maxResultCount: 100,
  },
  "jira.issue-link": {
    description:
      "Inspect one native issue link by its exact identity, returning both issue keys and the native direction names. This does not create or change a relationship.",
    input: object({ linkId: ID }, ["linkId"]),
    result: single(
      object({ ...LINK_TYPE, inwardIssueKey: ISSUE, outwardIssueKey: ISSUE }, [
        "id",
        "name",
        "inward",
        "outward",
        "inwardIssueKey",
        "outwardIssueKey",
      ]),
    ),
    risk: "read",
    maxResultCount: 1,
  },
  "jira.worklogs": {
    description:
      "Read a bounded local page of the selected issue's complete accessible native worklogs. Follow nextStartAt. The DC endpoint has no paging query; incomplete or oversized native collections are refused instead of claiming complete time totals.",
    input: object({ issueKey: ISSUE, ...PAGING }, ["issueKey"]),
    result: jiraNativeCollectionResult(WORKLOG),
    risk: "read",
    maxResultCount: 100,
  },
  "jira.worklog": {
    description:
      "Read one worklog bound to the selected issue, with exact time-spent seconds and available comment/author/timestamps. Missing or hidden worklogs are not interpreted as zero work.",
    input: object({ issueKey: ISSUE, worklogId: ID }, ["issueKey", "worklogId"]),
    result: single(WORKLOG),
    risk: "read",
    maxResultCount: 1,
  },
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export const JIRA_ISSUE_COLLABORATION_WRITE_DEFINITIONS = {
  "jira.update-comment": {
    description:
      "Update one existing issue comment's body while preserving its observed native visibility. Requires Jira edit-own-comments or edit-all-comments permission. Read current state first, send one PUT, and independently read back the exact body and visibility. Never repeat an unconfirmed update.",
    input: object({ issueKey: ISSUE, commentId: ID, body: { ...text(32768), minLength: 1 } }, [
      "issueKey",
      "commentId",
      "body",
    ]),
    result: jiraNativeWriteResult({ issueKey: ISSUE, commentId: ID }),
    risk: "write",
    maxResultCount: 1,
  },
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraIssueCollaborationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = {
    ...JIRA_ISSUE_COLLABORATION_READ_DEFINITIONS,
    ...JIRA_ISSUE_COLLABORATION_WRITE_DEFINITIONS,
  };
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
