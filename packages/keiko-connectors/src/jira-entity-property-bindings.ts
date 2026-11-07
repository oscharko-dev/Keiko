import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import { bindJiraCommentIssue, readJiraBoundComment } from "./jira-managed-comments.js";
import { executeJiraCoreMetadataRead } from "./jira-managed-core-metadata.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import { executeJiraSavedViewRead } from "./jira-managed-saved-views.js";
import { executeJiraUserRead } from "./jira-managed-user-reads.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";

export type JiraPropertyEntity =
  | { readonly kind: "board" | "sprint"; readonly id: string }
  | { readonly kind: "comment"; readonly issueIdOrKey: string; readonly commentId: string }
  | { readonly kind: "dashboard-item"; readonly dashboardId: string; readonly itemId: string }
  | { readonly kind: "issue"; readonly issueIdOrKey: string }
  | { readonly kind: "issue-type"; readonly issueTypeId: string }
  | { readonly kind: "project"; readonly projectIdOrKey: string }
  | { readonly kind: "user"; readonly user: CatalogJsonObject };
export interface JiraEntityPropertyPorts {
  readonly platform: JiraMutationRequest;
  readonly agile: JiraMutationRequest;
  readonly baseUrl: string;
}
export type JiraPropertyBinding =
  | { readonly ok: false; readonly result: ManagedMcpToolResult }
  | {
      readonly ok: true;
      readonly request: JiraMutationRequest;
      readonly path: string;
      readonly context: CatalogJsonObject;
      readonly query?: string;
    };
function failed(result: ManagedMcpToolResult): JiraPropertyBinding {
  return { ok: false, result };
}
function malformed(): JiraPropertyBinding {
  return failed(jiraReadFailure("malformed-payload"));
}
async function agileEntity(
  entity: Extract<JiraPropertyEntity, { readonly kind: "board" | "sprint" }>,
  request: JiraMutationRequest,
): Promise<JiraPropertyBinding> {
  const response = await request(`${entity.kind}/${entity.id}`, "GET", undefined, "json");
  if (!response.ok) return failed(jiraReadFailure(response.reason, response.remote));
  const id = jiraNativeNumericId(response.body?.id);
  if (response.status !== 200 || id === undefined) return malformed();
  if (id !== entity.id) return failed(jiraReadFailure("conflict"));
  return { ok: true, request, path: `${entity.kind}/${id}/properties`,
    context: entity.kind === "board" ? { boardId: id } : { sprintId: id } };
}
async function commentEntity(
  entity: Extract<JiraPropertyEntity, { readonly kind: "comment" }>,
  ports: JiraEntityPropertyPorts,
): Promise<JiraPropertyBinding> {
  const input = { issueKey: entity.issueIdOrKey, commentId: entity.commentId };
  const issue = await bindJiraCommentIssue(ports.platform, input, ports.baseUrl);
  if (!issue.ok) return failed(jiraReadFailure(issue.reason, issue.detail));
  const comment = await readJiraBoundComment(ports.platform, input, issue.binding);
  if (!comment.ok) return failed(jiraReadFailure(comment.reason, comment.detail));
  return { ok: true, request: ports.platform, path: `comment/${entity.commentId}/properties`,
    context: { issueId: issue.binding.issueId, issueKey: issue.issueKey, commentId: entity.commentId } };
}
async function dashboardItemEntity(
  entity: Extract<JiraPropertyEntity, { readonly kind: "dashboard-item" }>,
  request: JiraMutationRequest,
): Promise<JiraPropertyBinding> {
  const result = await executeJiraSavedViewRead("jira.dashboard", { dashboardId: entity.dashboardId }, request);
  if (result.isError) return failed(result);
  const items = result.data.items;
  const dashboard = Array.isArray(items) && items.length === 1 ? asRecord(items[0]) : undefined;
  if (dashboard?.id !== entity.dashboardId) return malformed();
  // Jira has no independent item-detail GET here. The property route owns item existence/access;
  // selectedItemId is explicitly requested context, never an independently observed item identity.
  return { ok: true, request,
    path: `dashboard/${entity.dashboardId}/items/${entity.itemId}/properties`,
    context: { dashboardId: entity.dashboardId, selectedItemId: entity.itemId } };
}
async function issueEntity(
  target: string,
  request: JiraMutationRequest,
): Promise<JiraPropertyBinding> {
  const issue = await readJiraMutationIssue(request, target, ["summary"]);
  if (!issue.ok) return failed(jiraReadFailure(issue.reason, issue.detail));
  if (!jiraNativeId(issue.id) || !isSafeAtlassianIdentifier(issue.key)) return malformed();
  return { ok: true, request, path: `issue/${issue.id}/properties`,
    context: { issueId: issue.id, issueKey: issue.key } };
}
async function projectEntity(target: string, request: JiraMutationRequest): Promise<JiraPropertyBinding> {
  const result = await readJiraBoundProject(request, target);
  if (!result.ok) return failed(jiraReadFailure(result.reason, result.detail));
  const project = result.project;
  return { ok: true, request, path: `project/${project.projectId}/properties`,
    context: { projectId: project.projectId, projectKey: project.projectKey } };
}
async function userEntity(args: CatalogJsonObject, request: JiraMutationRequest): Promise<JiraPropertyBinding> {
  const result = await executeJiraUserRead("jira.user", args, request);
  if (result.isError) return failed(result);
  const { key, name } = result.data;
  if (!jiraNativeText(key, 255) || !jiraNativeText(name, 255)) return malformed();
  return { ok: true, request, path: "user/properties", query: new URLSearchParams({ userKey: key }).toString(),
    context: { userKey: key, username: name } };
}

/** Reuse the native entity's admission owner before choosing its fixed property resource. */
export async function bindJiraPropertyEntity(
  entity: JiraPropertyEntity,
  ports: JiraEntityPropertyPorts,
): Promise<JiraPropertyBinding> {
  switch (entity.kind) {
    case "board":
    case "sprint": return agileEntity(entity, ports.agile);
    case "comment": return commentEntity(entity, ports);
    case "dashboard-item": return dashboardItemEntity(entity, ports.platform);
    case "issue": return issueEntity(entity.issueIdOrKey, ports.platform);
    case "project": return projectEntity(entity.projectIdOrKey, ports.platform);
    case "user": return userEntity(entity.user, ports.platform);
    case "issue-type": {
      const result = await executeJiraCoreMetadataRead("jira.issue-type", { issueTypeId: entity.issueTypeId }, ports.platform);
      return result.isError ? failed(result)
        : result.data.id !== entity.issueTypeId ? malformed()
          : { ok: true, request: ports.platform, path: `issuetype/${entity.issueTypeId}/properties`,
            context: { issueTypeId: entity.issueTypeId } };
    }
  }
}
