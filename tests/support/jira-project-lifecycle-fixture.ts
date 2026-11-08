import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { readbackFault, reviewedWriteRefusal } from "./jira-fixture-readback.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { JiraProjectLifecyclePorts } from "../../packages/keiko-connectors/src/jira-project-lifecycle-ports.js";
import type {
  JiraProjectLifecycleMutation,
  ProjectLifecycleReceipt,
} from "../../packages/keiko-connectors/src/jira-project-lifecycle-values.js";

export const PROJECT_LIFECYCLE_REVIEW = {
  id: "10000",
  key: "SYN",
  name: "Reviewed project",
  archived: false,
  projectTypeKey: "software",
} as const;
export const PROJECT_PERMISSION_REVIEW = {
  id: "7",
  name: "Current permission scheme",
  description: "",
  permissions: [],
} as const;
export const PROJECT_PERMISSION_TARGET = {
  id: "8",
  name: "Target permission scheme",
  description: "Reviewed permissions",
  permissions: [
    {
      id: "80",
      permission: "BROWSE_PROJECTS",
      holder: { type: "projectRole", parameter: "10001" },
    },
  ],
} as const;
export const PROJECT_PRIORITY_REVIEW = {
  id: "9",
  name: "Current priority scheme",
  description: null,
  optionIds: ["1", "2"],
  defaultOptionId: "1",
  defaultScheme: false,
} as const;
export const PROJECT_PRIORITY_TARGET = {
  id: "10",
  name: "Target priority scheme",
  description: "",
  optionIds: ["2", "1"],
  defaultOptionId: "2",
  defaultScheme: false,
} as const;
const COMMON = {
  expectedActorKey: "synthetic-actor",
  expectedProject: PROJECT_LIFECYCLE_REVIEW,
  confirmUnverifiedConsequences: true,
} as const;
const RECEIPT = { userKey: "synthetic-actor", projectId: "10000", projectKey: "SYN" } as const;
interface ProjectCase {
  readonly name: JiraProjectLifecycleMutation;
  readonly args: CatalogJsonObject;
  readonly method: "PUT" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly receipt: ProjectLifecycleReceipt;
}
export const PROJECT_LIFECYCLE_FIXTURE_CASES = [
  {
    name: "jira.delete-project",
    args: COMMON,
    method: "DELETE",
    path: "project/10000",
    receipt: { ...RECEIPT, projectPresent: false },
  },
  {
    name: "jira.archive-project",
    args: COMMON,
    method: "PUT",
    path: "project/10000/archive",
    receipt: { ...RECEIPT, projectArchivedRequested: true },
  },
  {
    name: "jira.restore-project",
    args: { ...COMMON, expectedProject: { ...PROJECT_LIFECYCLE_REVIEW, archived: true } },
    method: "PUT",
    path: "project/10000/restore",
    receipt: { ...RECEIPT, projectArchivedRequested: false },
  },
  {
    name: "jira.update-project-type",
    args: { ...COMMON, projectTypeKey: "business" },
    method: "PUT",
    path: "project/10000/type/business",
    receipt: { ...RECEIPT, projectTypeKey: "business" },
  },
  {
    name: "jira.set-project-permission-scheme",
    args: {
      ...COMMON,
      expectedScheme: PROJECT_PERMISSION_REVIEW,
      scheme: PROJECT_PERMISSION_TARGET,
    },
    method: "PUT",
    path: "project/10000/permissionscheme",
    body: { id: 8 },
    receipt: { ...RECEIPT, schemeId: "8", previousSchemeId: "7", projectSchemeAssigned: true },
  },
  {
    name: "jira.set-project-priority-scheme",
    args: { ...COMMON, expectedScheme: PROJECT_PRIORITY_REVIEW, scheme: PROJECT_PRIORITY_TARGET },
    method: "PUT",
    path: "project/10000/priorityscheme",
    body: { id: 10 },
    receipt: { ...RECEIPT, schemeId: "10", previousSchemeId: "9", projectSchemeAssigned: true },
  },
  {
    name: "jira.remove-project-priority-scheme",
    args: { ...COMMON, expectedScheme: PROJECT_PRIORITY_REVIEW },
    method: "DELETE",
    path: "project/10000/priorityscheme/9",
    receipt: { ...RECEIPT, schemeId: "9", projectSchemeAssigned: false },
  },
] as const satisfies readonly ProjectCase[];

export function projectLifecycleFixture(selected: ProjectCase) {
  const actor = { key: "synthetic-actor", name: "operator" };
  const project: Record<string, unknown> = {
    ...PROJECT_LIFECYCLE_REVIEW,
    archived: selected.name === "jira.restore-project",
  };
  const permission = new Map<string, Record<string, unknown>>([
    ["7", structuredClone(PROJECT_PERMISSION_REVIEW)],
    ["8", structuredClone(PROJECT_PERMISSION_TARGET)],
  ]);
  const priority = new Map<string, Record<string, unknown>>([
    ["9", structuredClone(PROJECT_PRIORITY_REVIEW)],
    ["10", structuredClone(PROJECT_PRIORITY_TARGET)],
    ["1", { ...PROJECT_PRIORITY_REVIEW, id: "1", defaultScheme: true }],
  ]);
  const controls = {
    lostAck: false,
    reject: false,
    denyReadback: false,
    missingReadback: false,
    throwReadback: false,
    actorChanged: false,
    wrongAssociation: false,
    inaccessibleType: false,
  };
  const calls: { path: string; method: string; body: unknown; expect: unknown }[] = [];
  let effects = 0;
  let permissionId = "7";
  let priorityId = "9";
  function read(
    path: string,
  ):
    | { readonly ok: true; readonly status: 200; readonly body: Record<string, unknown> }
    | { readonly ok: false; readonly reason: "permission-denied"; readonly httpStatus: 403 } {
    if (path === "myself")
      return {
        ok: true,
        status: 200,
        body: {
          ...actor,
          key:
            controls.actorChanged && calls.filter((item) => item.path === "myself").length > 1
              ? "changed-actor"
              : actor.key,
        },
      };
    if (path === "project/10000") return { ok: true, status: 200, body: structuredClone(project) };
    if (path === "project/type/business/accessible")
      return controls.inaccessibleType
        ? { ok: false, reason: "permission-denied", httpStatus: 403 }
        : { ok: true, status: 200, body: { key: "business", formattedKey: "Business" } };
    if (path === "project/10000/permissionscheme") {
      const scheme = permission.get(controls.wrongAssociation ? "8" : permissionId);
      assert.ok(scheme);
      return { ok: true, status: 200, body: structuredClone(scheme) };
    }
    if (path === "project/10000/priorityscheme") {
      const scheme = priority.get(controls.wrongAssociation ? "10" : priorityId);
      assert.ok(scheme);
      return { ok: true, status: 200, body: structuredClone(scheme) };
    }
    const parts = path.split("/");
    const id = parts[1];
    assert.ok(id);
    if (parts[0] === "permissionscheme") {
      const scheme = permission.get(id);
      assert.ok(scheme);
      return {
        ok: true,
        status: 200,
        body:
          parts[2] === "permission"
            ? { permissions: structuredClone(scheme.permissions) }
            : structuredClone(scheme),
      };
    }
    assert.equal(parts[0], "priorityschemes");
    const scheme = priority.get(id);
    assert.ok(scheme);
    return { ok: true, status: 200, body: structuredClone(scheme) };
  }
  const request: JiraMutationRequest = async (path, method = "GET", body, expect) => {
    calls.push({ path, method, body: structuredClone(body), expect });
    const fault = readbackFault(controls, effects, path, "Synthetic project readback failure");
    if (fault !== undefined) return fault;
    if (method === "GET") return read(path);
    const refusal = reviewedWriteRefusal(selected, controls, { path, method, body, expect });
    if (refusal !== undefined) return refusal;
    assert.equal(++effects, 1);
    if (selected.name === "jira.archive-project") project.archived = true;
    if (selected.name === "jira.restore-project") project.archived = false;
    if (selected.name === "jira.update-project-type") project.projectTypeKey = "business";
    if (selected.name === "jira.set-project-permission-scheme") permissionId = "8";
    if (selected.name === "jira.set-project-priority-scheme") priorityId = "10";
    if (selected.name === "jira.remove-project-priority-scheme") priorityId = "1";
    if (controls.lostAck) return { ok: false, reason: "timeout" };
    return {
      ok: true,
      status: selected.name === "jira.restore-project" ? 202 : 204,
      body: undefined,
    };
  };
  const ports: JiraProjectLifecyclePorts = {
    priority: {
      read: (id) => request(`project/${id}/priorityscheme`, "GET", undefined, "json"),
      assign: (id, scheme) =>
        request(`project/${id}/priorityscheme`, "PUT", { id: Number(scheme) }, "none"),
      remove: (id, scheme) =>
        request(`project/${id}/priorityscheme/${scheme}`, "DELETE", undefined, "none"),
    },
  };
  return {
    request,
    ports,
    actor,
    project,
    permission,
    priority,
    controls,
    calls,
    snapshot: (): CatalogJsonObject => ({
      effects,
      archived: project.archived === true,
      permissionId,
      priorityId,
      projectTypeKey: typeof project.projectTypeKey === "string" ? project.projectTypeKey : null,
    }),
  };
}
