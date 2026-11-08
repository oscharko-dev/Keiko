import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraAccessibleProjectType, readJiraBoundProject } from "./jira-managed-projects.js";
import { gateJiraSchemaRuleImpact, type JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import { jiraPermissionSchemeProjection } from "./jira-managed-access-schemes.js";
import { jiraPrioritySchemeProjection } from "./jira-managed-project-associations.js";
import { readPermissionSchemeSnapshot, samePermissionSchemeSnapshot } from "./jira-permission-scheme-observations.js";
import { readOptionScheme } from "./jira-option-scheme-observations.js";
import { sameScheme } from "./jira-option-scheme-values.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import { sameProjectReview, type JiraProjectReview } from "./jira-project-review.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import type { JiraProjectLifecyclePorts } from "./jira-project-lifecycle-ports.js";
import { projectLifecycleFailure, projectLifecycleRefusal, type ProjectLifecycleFailure, type ProjectLifecycleInput, type ProjectLifecycleObservation } from "./jira-project-lifecycle-values.js";

export async function bindProjectLifecycle(request: JiraMutationRequest, expected: JiraProjectReview): Promise<ProjectLifecycleFailure | undefined> {
  const bound = await readJiraBoundProject(request, expected.id);
  if (!bound.ok) return projectLifecycleFailure(bound);
  const current = bound.project.reviewSnapshot;
  if (current === undefined) return projectLifecycleRefusal("The native project does not expose the complete reviewed identity, name and archived boolean. Missing archived/type facts are not defaults.", "unavailable");
  return sameProjectReview(current, expected) ? undefined : projectLifecycleRefusal("The native project's exact identity, name, archive state or observed type changed from the review.", "conflict");
}
export async function projectAssociationId(request: JiraMutationRequest, input: ProjectLifecycleInput, ports: JiraProjectLifecyclePorts | undefined): Promise<ProjectLifecycleObservation<string>> {
  const priority = input.kind !== "permission";
  const response = priority ? await ports?.priority.read(input.project.id)
    : await request(`project/${input.project.id}/permissionscheme`, "GET", undefined, "json");
  if (response === undefined) return projectLifecycleRefusal("The fixed experimental priority-scheme port is unavailable.", "unavailable");
  if (!response.ok) return projectLifecycleFailure(dispatchFailure(response));
  if (response.status !== 200 || response.body === undefined) return { ok: false, reason: "malformed-payload" };
  const projected = priority ? jiraPrioritySchemeProjection(response.body) : jiraPermissionSchemeProjection(response.body);
  return projected !== undefined && jiraNativeId(projected.id) ? { ok: true, value: projected.id } : { ok: false, reason: "malformed-payload" };
}
async function permissionReviews(request: JiraMutationRequest, input: Extract<ProjectLifecycleInput, { kind: "permission" }>): Promise<ProjectLifecycleFailure | undefined> {
  for (const expected of [input.expected, input.target]) {
    const observed = await readPermissionSchemeSnapshot(request, expected.id);
    if (!observed.ok) return projectLifecycleFailure(observed);
    if (!samePermissionSchemeSnapshot(observed.value, expected)) return projectLifecycleRefusal("A permission scheme's identity, metadata or complete grant configuration changed from the review.", "conflict");
  }
  return undefined;
}
async function priorityReviews(request: JiraMutationRequest, input: Extract<ProjectLifecycleInput, { kind: "priority" | "priority-remove" }>): Promise<ProjectLifecycleFailure | undefined> {
  const reviewed = input.kind === "priority" ? [input.expected, input.target] : [input.expected];
  for (const expected of reviewed) {
    const observed = await readOptionScheme(request, "priority", expected.id);
    if (!observed.ok) return projectLifecycleFailure(observed);
    if (!sameScheme(observed.value, expected)) return projectLifecycleRefusal("A priority scheme's identity, metadata, native default or complete ordered option configuration changed from the review.", "conflict");
  }
  return undefined;
}
export async function observeProjectAssociation(request: JiraMutationRequest, input: ProjectLifecycleInput, ports: JiraProjectLifecyclePorts | undefined): Promise<ProjectLifecycleFailure | undefined> {
  if (input.kind !== "permission" && input.kind !== "priority" && input.kind !== "priority-remove") return undefined;
  const associated = await projectAssociationId(request, input, ports);
  if (!associated.ok) return associated;
  if (associated.value !== input.expected.id) return projectLifecycleRefusal("The current project-to-scheme association differs from the reviewed source. No replacement or removal was sent.", "conflict");
  return input.kind === "permission" ? permissionReviews(request, input) : priorityReviews(request, input);
}
export async function admitProjectLifecycle(request: JiraMutationRequest, input: ProjectLifecycleInput, ports: JiraProjectLifecyclePorts | undefined, templates: JiraIssueTemplateSource | undefined): Promise<ProjectLifecycleFailure | undefined> {
  const actor = await readSavedActor(request, input.actor); if (!actor.ok) return projectLifecycleFailure(actor);
  const project = await bindProjectLifecycle(request, input.project); if (project !== undefined) return project;
  if (input.kind === "delete") {
    const gate = await gateJiraSchemaRuleImpact({ request, source: templates, impact: { kind: "issue-deletion" } });
    if (!gate.ok) return projectLifecycleFailure(gate);
  }
  if (input.kind === "type") {
    const accessible = await readJiraAccessibleProjectType(request, input.type);
    if (!accessible.ok) return projectLifecycleFailure(accessible);
  }
  return observeProjectAssociation(request, input, ports);
}
