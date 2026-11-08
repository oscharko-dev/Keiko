import { jiraOptionSchemeReview } from "./jira-option-scheme-review.js";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraCoreMetadataProjection } from "./jira-core-metadata-values.js";
import { jiraIssueTypeSchemeProjection, jiraIssueTypeSchemeProjectProjection } from "./jira-managed-issue-type-schemes.js";
import { jiraPrioritySchemeProjection } from "./jira-managed-project-associations.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import { projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { SCHEME_MALFORMED, schemePath, schemeProjects, schemeRefusal,
  type SchemeKind, type SchemeSnapshot, type SchemeObservation, type SchemeFailure, type SchemeProject, type SchemeTarget } from "./jira-option-scheme-values.js";

export async function readOptionScheme(request: JiraMutationRequest, kind: SchemeKind, id: string): Promise<SchemeObservation<SchemeSnapshot>> {
  const response = await request(`${schemePath(kind)}/${id}`);
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.body === undefined) return SCHEME_MALFORMED;
  const projected = kind === "issue-type" ? jiraIssueTypeSchemeProjection(response.body) : jiraPrioritySchemeProjection(response.body);
  const scheme = jiraOptionSchemeReview(kind, response.body, projected);
  return scheme?.id === id ? { ok: true, value: scheme } : schemeRefusal("The exact native scheme, description, ordered options or default is unavailable. Missing facts are not an empty configuration.", "unavailable");
}
export async function readSchemeProjects(request: JiraMutationRequest, id: string): Promise<SchemeObservation<readonly SchemeProject[]>> {
  const response = await request(`issuetypescheme/${id}/associations`, "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return SCHEME_MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  const projected = projectJiraCollection(response.items, TOOL_CATALOG_LIMITS.maxArrayItems, jiraIssueTypeSchemeProjectProjection, "id");
  const projects = projected === undefined ? undefined : schemeProjects(projected.map((item) => ({ id: item.id, key: item.key, name: item.name })));
  return projects === undefined ? schemeRefusal("The complete native project association configuration is unavailable or exceeds this operation's review bound. It is not an issue population proof.", "unavailable") : { ok: true, value: projects };
}
export async function bindSchemeProjects(request: JiraMutationRequest, projects: readonly SchemeProject[]): Promise<SchemeFailure | undefined> {
  for (const expected of projects) {
    const bound = await readJiraBoundProject(request, expected.id);
    if (!bound.ok) return bound;
    const actual = bound.project;
    if (actual.projectId !== expected.id || actual.projectKey !== expected.key || actual.projectName !== expected.name)
      return schemeRefusal("A reviewed project's identity, key or name changed. Read the current project before approving the association.", "conflict");
  }
  return undefined;
}
export async function bindSchemeOptions(request: JiraMutationRequest, kind: SchemeKind, target: SchemeTarget): Promise<SchemeFailure | undefined> {
  const response = await request(kind === "issue-type" ? "issuetype" : "priority", "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return SCHEME_MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  const projected = projectJiraCollection(response.items, TOOL_CATALOG_LIMITS.maxArrayItems,
    (value) => jiraCoreMetadataProjection(kind, value), "id");
  if (projected === undefined) return SCHEME_MALFORMED;
  const ids = new Set(projected.map((item) => item.id));
  return target.ids.every((id) => ids.has(id)) ? undefined : schemeRefusal("Every selected option and default must identify an actual native issue type or priority. Reread the current option catalog; names are not IDs.", "conflict");
}
