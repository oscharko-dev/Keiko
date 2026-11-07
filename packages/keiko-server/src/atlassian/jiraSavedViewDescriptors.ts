import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeCollectionResult,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const ID = {
  ...text(19),
  allOf: [{ pattern: "^[1-9]" }, { pattern: "^[0-9]{1,19}$" }],
  description: "Canonical positive decimal int64 string, no greater than 9223372036854775807.",
};
const PAGING = {
  startAt: { type: "integer", minimum: 0, maximum: 1_000_000 },
  maxResults: { type: "integer", minimum: 1, maximum: 100 },
};
const DASHBOARD = object({ id: ID, name: { ...text(255), minLength: 1 } }, ["id", "name"]);
const PERMISSION = object(
  {
    id: ID,
    type: { ...text(64), minLength: 1 },
    view: { type: "boolean" },
    edit: { type: "boolean" },
    groupName: text(255),
    projectId: ID,
    projectKey: text(128),
    roleId: ID,
    roleName: text(255),
    userName: text(255),
    userDisplayName: text(255),
  },
  ["id", "type"],
);
function single(item: CatalogJsonObject, fields: CatalogJsonObject = {}): CatalogJsonObject {
  return jiraNativeReadResult({ ...fields, items: { type: "array", maxItems: 1, items: item } });
}
const permissionPage = jiraNativeReadResult({
  filterId: ID,
  items: { type: "array", maxItems: 100, items: PERMISSION },
  startAt: PAGING.startAt,
  total: PAGING.startAt,
  nextStartAt: PAGING.startAt,
});
export const JIRA_SAVED_VIEW_READ_DEFINITIONS = {
  "jira.dashboards": {
    description:
      "Read one native page of visible Jira dashboards. Follow nextStartAt to continue; remote next/view URLs are never followed or exposed. This reads names and identities, not gadget contents.",
    input: object(PAGING),
    result: jiraNativeCollectionResult(DASHBOARD),
    risk: "read",
    maxResultCount: 100,
  },
  "jira.dashboard": {
    description:
      "Read the exact visible Jira dashboard's identity and name. Missing or inaccessible dashboards stay unavailable; no sharing or gadget configuration is inferred.",
    input: object({ dashboardId: ID }, ["dashboardId"]),
    result: single(DASHBOARD),
    risk: "read",
    maxResultCount: 1,
  },
  "jira.filter-share-scope": {
    description:
      "Read the current Jira user's default filter sharing scope as GLOBAL, AUTHENTICATED or PRIVATE. This does not change preferences or prove the sharing of any existing or future filter.",
    input: object({}),
    result: jiraNativeReadResult({
      scope: { type: "string", enum: ["GLOBAL", "AUTHENTICATED", "PRIVATE"] },
    }),
    risk: "read",
    maxResultCount: 1,
  },
  "jira.filter-permissions": {
    description:
      "Read and locally page the selected filter's complete bounded native share-permission collection. Follow nextStartAt. Returned view/edit flags and principals are observed configuration, not an effective-access decision; no sharing is changed.",
    input: object({ filterId: ID, ...PAGING }, ["filterId"]),
    result: permissionPage,
    risk: "read",
    maxResultCount: 100,
  },
  "jira.filter-permission": {
    description:
      "Read one exact share-permission identity of the selected filter. Preserve the native type and available principal/view/edit facts without inferring effective rights. No permission is added or removed.",
    input: object({ filterId: ID, permissionId: ID }, ["filterId", "permissionId"]),
    result: single(PERMISSION, { filterId: ID }),
    risk: "read",
    maxResultCount: 1,
  },
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraSavedViewDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_SAVED_VIEW_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
