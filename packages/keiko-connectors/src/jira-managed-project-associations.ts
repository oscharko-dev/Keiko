import {
  JIRA_READ_TOOL_FAMILIES,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import {
  jiraAccessSchemeBoundsExceeded,
  jiraPermissionSchemeProjection,
  jiraSecurityLevelProjection,
  jiraSecuritySchemeProjection,
} from "./jira-managed-access-schemes.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import { jiraWorkflowSchemeResult } from "./jira-managed-workflow-schemes.js";
import { jiraNativeId, jiraNativeNumericId } from "./jira-native-values.js";

export const JIRA_PROJECT_ASSOCIATION_READS = JIRA_READ_TOOL_FAMILIES.projectAssociations;
type AssociationRead = (typeof JIRA_PROJECT_ASSOCIATION_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_PROJECT_ASSOCIATION_READS);
const SUFFIX: Readonly<Record<AssociationRead, string>> = {
  "jira.project-permission-scheme": "permissionscheme",
  "jira.project-issue-security-scheme": "issuesecuritylevelscheme",
  "jira.project-security-levels": "securitylevel",
  "jira.project-workflow-scheme": "workflowscheme",
  "jira.project-priority-scheme": "priorityscheme",
};
interface Selection {
  readonly project: string;
  readonly startAt: number;
  readonly maxResults: number;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function selection(name: AssociationRead, args: CatalogJsonObject): Selection | undefined {
  const allowed = new Set(["projectIdOrKey"]);
  if (name === "jira.project-security-levels" || name === "jira.project-workflow-scheme") {
    allowed.add("startAt");
    allowed.add("maxResults");
  }
  if (
    Object.keys(args).some((key) => !allowed.has(key)) ||
    !isSafeAtlassianIdentifier(args.projectIdOrKey)
  )
    return undefined;
  const startAt = args.startAt === undefined ? 0 : args.startAt;
  const maxResults = args.maxResults === undefined ? 25 : args.maxResults;
  return integer(startAt, 0, 1_000_000) && integer(maxResults, 1, 100)
    ? { project: args.projectIdOrKey, startAt, maxResults }
    : undefined;
}
export function jiraPrioritySchemeProjection(body: Record<string, unknown>): CatalogJsonObject | undefined {
  const named = jiraSecurityLevelProjection(body);
  if (named === undefined) return undefined;
  const optional: Record<string, CatalogJsonValue> = {};
  if (body.defaultScheme !== undefined && body.defaultScheme !== null) {
    if (typeof body.defaultScheme !== "boolean") return undefined;
    optional.defaultScheme = body.defaultScheme;
  }
  if (body.defaultOptionId !== undefined && body.defaultOptionId !== null) {
    if (!jiraNativeId(body.defaultOptionId)) return undefined;
    optional.defaultOptionId = body.defaultOptionId;
  }
  if (body.optionIds !== undefined && body.optionIds !== null) {
    const values = asArray(body.optionIds);
    if (
      values === undefined ||
      values.length > TOOL_CATALOG_LIMITS.maxArrayItems ||
      !values.every(jiraNativeId) ||
      new Set(values).size !== values.length
    )
      return undefined;
    optional.optionIds = values;
  }
  return { ...named, ...optional };
}
function accessibleLevels(
  body: Record<string, unknown>,
  selected: Selection,
): ManagedMcpToolResult {
  const values = asArray(body.levels);
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items = projectJiraCollection(
    values,
    TOOL_CATALOG_LIMITS.maxArrayItems,
    jiraSecurityLevelProjection,
    "id",
  );
  if (items === undefined) return jiraReadFailure("malformed-payload");
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return { data: { ...page.data, levelsScope: "accessible" } };
}
function association(
  name: AssociationRead,
  body: Record<string, unknown>,
  selected: Selection,
): ManagedMcpToolResult {
  if (jiraAccessSchemeBoundsExceeded(body)) return jiraReadFailure("bounds-exceeded");
  if (name === "jira.project-security-levels") return accessibleLevels(body, selected);
  if (name === "jira.project-workflow-scheme") {
    const schemeId = jiraNativeNumericId(body.id);
    return schemeId === undefined
      ? jiraReadFailure("malformed-payload")
      : jiraWorkflowSchemeResult(body, {
          schemeId,
          draft: false,
          returnDraft: false,
          startAt: selected.startAt,
          maxResults: selected.maxResults,
        });
  }
  const item =
    name === "jira.project-permission-scheme"
      ? jiraPermissionSchemeProjection(body)
      : name === "jira.project-issue-security-scheme"
        ? jiraSecuritySchemeProjection(body)
        : jiraPrioritySchemeProjection(body);
  return item === undefined
    ? jiraReadFailure("malformed-payload")
    : { data: { outcome: "succeeded", ...item } };
}
export function isJiraProjectAssociationRead(name: string): name is AssociationRead {
  return READS.has(name);
}
/** Associations are read only through an observed canonical project; no remote self URL is followed. */
export async function executeJiraProjectAssociationRead(
  name: AssociationRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const current = await readJiraBoundProject(request, selected.project);
  if (!current.ok) return jiraReadFailure(current.reason, current.detail);
  const project = current.project;
  if (!jiraNativeId(project.projectId)) return jiraReadFailure("malformed-payload");
  const response = await request(
    `project/${project.projectId}/${SUFFIX[name]}`,
    "GET",
    undefined,
    "json",
  );
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  const body = asRecord(response.body);
  if (response.status !== 200 || body === undefined) return jiraReadFailure("malformed-payload");
  const result = association(name, body, selected);
  return result.isError
    ? result
    : boundJiraReadResult({
        data: { ...result.data, projectId: project.projectId, projectKey: project.projectKey },
      });
}
