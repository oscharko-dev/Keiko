import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import type { JiraProjectLifecyclePorts } from "./jira-project-lifecycle-ports.js";
import {
  admitProjectLifecycle,
  bindProjectLifecycle,
  projectAssociationId,
} from "./jira-project-lifecycle-observations.js";
import {
  parseProjectLifecycleInput,
  projectLifecycleFailure,
  projectLifecycleReceipt,
  projectLifecycleRefusal,
  safeSchemeBodyId,
  type JiraProjectLifecycleMutation,
  type ProjectLifecycleAttempt,
  type ProjectLifecycleFailure,
  type ProjectLifecycleInput,
  type ProjectLifecycleReceipt,
} from "./jira-project-lifecycle-values.js";
export {
  JIRA_PROJECT_LIFECYCLE_MUTATIONS,
  isJiraProjectLifecycleMutation,
  type JiraProjectLifecycleMutation,
} from "./jira-project-lifecycle-values.js";

function unchanged(input: ProjectLifecycleInput): boolean {
  switch (input.kind) {
    case "archive":
      return input.project.archived;
    case "restore":
      return !input.project.archived;
    case "type":
      return input.project.projectTypeKey === input.type;
    case "permission":
    case "priority":
      return input.expected.id === input.target.id;
    default:
      return false;
  }
}
function admittedNoop(
  input: ProjectLifecycleInput,
  receipt: ProjectLifecycleReceipt,
): ProjectLifecycleFailure | undefined {
  if (input.kind === "priority-remove" && input.expected.defaultScheme === true)
    return projectLifecycleRefusal(
      "The native default priority scheme cannot be unassigned. No request was sent.",
    );
  return unchanged(input)
    ? {
        ok: false,
        reason: "conflict",
        receipt,
        detail: {
          unchanged: true,
          messages: [
            "The independently observed project configuration already holds this exact selection. Nothing was written; this is not a claim about all issue or permission consequences.",
          ],
        },
      }
    : undefined;
}
async function effect(
  request: JiraMutationRequest,
  ports: JiraProjectLifecyclePorts | undefined,
  input: ProjectLifecycleInput,
): Promise<AtlassianWriteHttpOutcome> {
  const path = `project/${input.project.id}`;
  switch (input.kind) {
    case "delete":
      return request(path, "DELETE", undefined, "none");
    case "archive":
    case "restore":
      return request(`${path}/${input.kind}`, "PUT", undefined, "none");
    case "type":
      return request(`${path}/type/${encodeURIComponent(input.type)}`, "PUT", undefined, "none");
    case "permission": {
      const id = safeSchemeBodyId(input.target.id);
      return id === undefined
        ? { ok: false, reason: "field-validation" }
        : request(`${path}/permissionscheme`, "PUT", { id }, "none");
    }
    case "priority":
      return ports === undefined
        ? { ok: false, reason: "unavailable" }
        : ports.priority.assign(input.project.id, input.target.id);
    case "priority-remove":
      return ports === undefined
        ? { ok: false, reason: "unavailable" }
        : ports.priority.remove(input.project.id, input.expected.id);
  }
}
async function associationReadback(
  request: JiraMutationRequest,
  ports: JiraProjectLifecyclePorts | undefined,
  input: ProjectLifecycleInput,
): Promise<ProjectLifecycleFailure | undefined> {
  if (input.kind !== "permission" && input.kind !== "priority" && input.kind !== "priority-remove")
    return undefined;
  const current = await projectAssociationId(request, input, ports);
  if (!current.ok) return current;
  const matches =
    input.kind === "priority-remove"
      ? current.value !== input.expected.id
      : current.value === input.target.id;
  return matches
    ? undefined
    : projectLifecycleRefusal(
        "The fresh same-project association does not match the requested change. Keep known IDs and do not replay.",
        "conflict",
      );
}
async function readback(
  request: JiraMutationRequest,
  ports: JiraProjectLifecyclePorts | undefined,
  input: ProjectLifecycleInput,
  receipt: ProjectLifecycleReceipt,
): Promise<ProjectLifecycleFailure> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return { ...projectLifecycleFailure(actor), receipt };
  let desired: typeof input.project;
  if (input.kind === "archive" || input.kind === "restore") {
    desired = { ...input.project, archived: input.kind === "archive" };
  } else if (input.kind === "type") {
    desired = { ...input.project, projectTypeKey: input.type };
  } else {
    desired = input.project;
  }

  const project = await bindProjectLifecycle(request, desired);
  if (project !== undefined) return { ...project, receipt };
  const association = await associationReadback(request, ports, input);
  if (association !== undefined) return { ...association, receipt };
  const note =
    input.kind === "restore"
      ? " Jira documents a required reindex after restoration; no second effect was started."
      : "";
  return {
    ...projectLifecycleRefusal(
      `Jira acknowledged the request. The observed project/configuration does not prove all project, issue, scheme, permission or index consequences. A missing project or visible list omission is not completed deletion. Never replay automatically.${note}`,
      "unavailable",
    ),
    receipt,
  };
}
/** Each native identity has one effect. Post-ACK config reads never establish aggregate completion. */
export async function executeJiraProjectLifecycleMutation(
  operation: JiraProjectLifecycleMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  ports: JiraProjectLifecyclePorts | undefined,
  check = false,
  templates?: JiraIssueTemplateSource,
): Promise<ProjectLifecycleAttempt> {
  const input = parseProjectLifecycleInput(operation, args);
  if (input === undefined)
    return projectLifecycleRefusal(
      "Review exact actor/project identity, native archived flag and complete source/target scheme configuration. Explicitly accept unverified project consequences. Numeric scheme bodies must remain safe exact JSON integers; no loss-prone conversion is allowed.",
    );
  if ((input.kind === "priority" || input.kind === "priority-remove") && ports === undefined)
    return projectLifecycleRefusal(
      "The fixed native experimental priority-scheme port is unavailable. No request was sent.",
      "unavailable",
    );
  const receipt = projectLifecycleReceipt(input);
  if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > 16_384)
    return { ok: false, reason: "bounds-exceeded" };
  const admitted = await admitProjectLifecycle(request, input, ports, templates);
  if (admitted !== undefined) return admitted;
  const noEffect = admittedNoop(input, receipt);
  if (noEffect !== undefined) return noEffect;
  if (check) return { ok: true, receipt: {} };
  return dispatchProjectLifecycle(request, ports, input, receipt, templates);
}
async function dispatchProjectLifecycle(
  request: JiraMutationRequest,
  ports: JiraProjectLifecyclePorts | undefined,
  input: ProjectLifecycleInput,
  receipt: ProjectLifecycleReceipt,
  templates: JiraIssueTemplateSource | undefined,
): Promise<ProjectLifecycleFailure> {
  const current = await admitProjectLifecycle(request, input, ports, templates);
  if (current !== undefined) return current;
  const response = await effect(request, ports, input);
  if (!response.ok) return { ...projectLifecycleFailure(dispatchFailure(response)), receipt };
  try {
    return await readback(request, ports, input, receipt);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
