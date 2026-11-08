import assert from "node:assert/strict";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";
const ACTOR = "synthetic-actor";
export const ISSUE_SCHEME_REVIEW = {
  id: "7",
  name: "Delivery types",
  description: "Reviewed types",
  issueTypeIds: ["1", "2"],
  defaultIssueTypeId: "1",
};
export const PRIORITY_SCHEME_REVIEW = {
  id: "9",
  name: "Delivery priorities",
  description: "Reviewed priorities",
  optionIds: ["1", "2"],
  defaultOptionId: "1",
  defaultScheme: false,
};
const CURRENT = { id: "10000", key: "SYN", name: "Synthetic project" };
const OTHER = { id: "10001", key: "OTHER", name: "Other project" };
const ISSUE = { expectedActorKey: ACTOR, expectedScheme: ISSUE_SCHEME_REVIEW };
const PRIORITY = { expectedActorKey: ACTOR, expectedScheme: PRIORITY_SCHEME_REVIEW };
const ASSOCIATION = { ...ISSUE, expectedProjects: [CURRENT], confirmUnverifiedConsequences: true };
export const OPTION_SCHEME_MUTATION_CASES = [
  {
    tool: "jira.create-issue-type-scheme",
    args: {
      expectedActorKey: ACTOR,
      name: "Planning types",
      description: "",
      issueTypeIds: ["2", "1"],
      defaultIssueTypeId: "2",
    },
    method: "POST",
    path: "issuetypescheme",
    body: {
      name: "Planning types",
      description: "",
      defaultIssueTypeId: "2",
      issueTypeIds: ["2", "1"],
    },
    confirmed: true,
    receipt: { userKey: ACTOR, schemeId: "9007199254740993", schemePresent: true },
  },
  {
    tool: "jira.update-issue-type-scheme",
    args: {
      ...ISSUE,
      name: "Delivery types revised",
      description: "",
      issueTypeIds: ["2", "1"],
      defaultIssueTypeId: "2",
    },
    method: "PUT",
    path: "issuetypescheme/7",
    body: {
      name: "Delivery types revised",
      description: "",
      defaultIssueTypeId: "2",
      issueTypeIds: ["2", "1"],
    },
    confirmed: true,
    receipt: { userKey: ACTOR, schemeId: "7", schemePresent: true },
  },
  {
    tool: "jira.delete-issue-type-scheme",
    args: { ...ISSUE, confirmUnverifiedConsequences: true },
    method: "DELETE",
    path: "issuetypescheme/7",
    body: undefined,
    confirmed: false,
    receipt: { userKey: ACTOR, schemeId: "7", schemePresent: false },
  },
  {
    tool: "jira.add-issue-type-scheme-projects",
    args: { ...ASSOCIATION, projects: [OTHER] },
    method: "POST",
    path: "issuetypescheme/7/associations",
    body: { idsOrKeys: ["10001"] },
    confirmed: false,
    receipt: {
      userKey: ACTOR,
      schemeId: "7",
      schemePresent: true,
      projectIds: ["10001"],
      projectKeys: ["OTHER"],
      associationChange: "add",
    },
  },
  {
    tool: "jira.set-issue-type-scheme-projects",
    args: { ...ASSOCIATION, projects: [OTHER] },
    method: "PUT",
    path: "issuetypescheme/7/associations",
    body: { idsOrKeys: ["10001"] },
    confirmed: false,
    receipt: {
      userKey: ACTOR,
      schemeId: "7",
      schemePresent: true,
      projectIds: ["10001"],
      projectKeys: ["OTHER"],
      associationChange: "replace",
    },
  },
  {
    tool: "jira.clear-issue-type-scheme-projects",
    args: { ...ASSOCIATION, projects: [] },
    method: "DELETE",
    path: "issuetypescheme/7/associations",
    body: undefined,
    confirmed: false,
    receipt: {
      userKey: ACTOR,
      schemeId: "7",
      schemePresent: true,
      projectIds: ["10000"],
      projectKeys: ["SYN"],
      associationChange: "clear",
    },
  },
  {
    tool: "jira.remove-issue-type-scheme-project",
    args: { ...ASSOCIATION, projects: [CURRENT] },
    method: "DELETE",
    path: "issuetypescheme/7/associations/10000",
    body: undefined,
    confirmed: false,
    receipt: {
      userKey: ACTOR,
      schemeId: "7",
      schemePresent: true,
      projectIds: ["10000"],
      projectKeys: ["SYN"],
      associationChange: "remove",
    },
  },
  {
    tool: "jira.create-priority-scheme",
    args: {
      expectedActorKey: ACTOR,
      name: "Planning priorities",
      description: "",
      optionIds: ["2", "1"],
      defaultOptionId: "2",
    },
    method: "POST",
    path: "priorityschemes",
    body: {
      name: "Planning priorities",
      description: "",
      defaultOptionId: "2",
      optionIds: ["2", "1"],
    },
    confirmed: true,
    receipt: { userKey: ACTOR, schemeId: "9007199254740993", schemePresent: true },
  },
  {
    tool: "jira.update-priority-scheme",
    args: {
      ...PRIORITY,
      name: "Delivery priorities revised",
      description: "",
      optionIds: ["2", "1"],
      defaultOptionId: "2",
    },
    method: "PUT",
    path: "priorityschemes/9",
    body: {
      name: "Delivery priorities revised",
      description: "",
      defaultOptionId: "2",
      optionIds: ["2", "1"],
    },
    confirmed: true,
    receipt: { userKey: ACTOR, schemeId: "9", schemePresent: true },
  },
  {
    tool: "jira.delete-priority-scheme",
    args: { ...PRIORITY, confirmUnverifiedConsequences: true },
    method: "DELETE",
    path: "priorityschemes/9",
    body: undefined,
    confirmed: false,
    receipt: { userKey: ACTOR, schemeId: "9", schemePresent: false },
  },
] as const;
export function optionSchemeFixture() {
  const actor = { key: ACTOR, name: "operator" };
  const issueTypes = [
    { id: "1", name: "Task", subtask: false },
    { id: "2", name: "Bug", subtask: false },
  ];
  const priorities = [
    { id: "1", name: "High" },
    { id: "2", name: "Normal" },
  ];
  const issueSchemes = new Map<string, Record<string, unknown>>([
    [
      "7",
      {
        id: "7",
        name: "Delivery types",
        description: "Reviewed types",
        issueTypes: structuredClone(issueTypes),
        defaultIssueType: issueTypes[0],
      },
    ],
  ]);
  const prioritySchemes = new Map<string, Record<string, unknown>>([
    [
      "9",
      {
        id: 9,
        name: "Delivery priorities",
        description: "Reviewed priorities",
        optionIds: ["1", "2"],
        defaultOptionId: "1",
        defaultScheme: false,
      },
    ],
  ]);
  const projects = new Map([
    [CURRENT.id, { ...CURRENT }],
    [OTHER.id, { ...OTHER }],
  ]);
  let associations: string[] = [CURRENT.id];
  let writes = 0;
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const controls = {
    lostAck: false,
    omitAckId: false,
    wrongReadback: false,
    denyReadback: false,
    throwReadback: false,
    missingAssociations: false,
    ackStatus: 204,
  };
  const ok = (body?: Record<string, unknown>, status = 200): AtlassianWriteHttpOutcome => ({
    ok: true,
    status,
    body,
  });
  const missing = (): AtlassianWriteHttpOutcome => ({
    ok: false,
    reason: "not-found",
    httpStatus: 404,
  });
  function read(path: string): AtlassianWriteHttpOutcome {
    if (writes && controls.throwReadback) throw new Error("Synthetic scheme readback defect");
    if (writes && controls.denyReadback)
      return { ok: false, reason: "permission-denied", httpStatus: 403 };
    if (path === "myself") return ok({ ...actor });
    if (path === "issuetype" || path === "priority")
      return {
        ok: true,
        status: 200,
        body: undefined,
        items: path === "issuetype" ? issueTypes : priorities,
      };
    if (path.startsWith("project/")) {
      const value = projects.get(path.slice("project/".length));
      return value === undefined ? missing() : ok(value);
    }
    const parts = path.split("/");
    const selected = parts[0] === "issuetypescheme" ? issueSchemes : prioritySchemes;
    const item = selected.get(parts[1] ?? "");
    if (item === undefined) return missing();
    if (parts[2] === "associations")
      return controls.missingAssociations
        ? ok()
        : {
            ok: true,
            status: 200,
            body: undefined,
            items: associations.map((id) => ({ ...projects.get(id) })),
          };
    return ok({
      ...item,
      ...(writes && controls.wrongReadback ? { name: "Concurrent scheme" } : {}),
    });
  }
  function associate(
    parts: readonly string[],
    method: string,
    body: Parameters<JiraMutationRequest>[2],
  ): void {
    if (method === "DELETE") {
      associations = parts[3] === undefined ? [] : associations.filter((id) => id !== parts[3]);
      return;
    }
    const raw = asRecord(body);
    assert.ok(raw);
    assert.ok(Array.isArray(raw.idsOrKeys));
    const ids: string[] = [];
    for (const id of raw.idsOrKeys) {
      assert.ok(typeof id === "string");
      assert.ok(projects.has(id));
      ids.push(id);
    }
    associations = method === "PUT" ? ids : [...new Set([...associations, ...ids])];
  }
  function configure(
    parts: readonly string[],
    method: string,
    body: Parameters<JiraMutationRequest>[2],
  ): Record<string, unknown> | undefined {
    const selected = parts[0] === "issuetypescheme" ? issueSchemes : prioritySchemes;
    const id = parts[1] ?? "9007199254740993";
    if (method === "DELETE") {
      selected.delete(id);
      return undefined;
    }
    const raw = asRecord(body);
    assert.ok(raw);
    if (parts[0] === "issuetypescheme") {
      assert.ok(Array.isArray(raw.issueTypeIds));
      selected.set(id, {
        id,
        name: raw.name,
        description: raw.description,
        issueTypes: raw.issueTypeIds.map((value) => issueTypes.find((item) => item.id === value)),
        defaultIssueType: issueTypes.find((item) => item.id === raw.defaultIssueTypeId),
      });
    } else selected.set(id, { id, ...raw, defaultScheme: false });
    return parts[1] === undefined ? { id } : undefined;
  }
  const request: JiraMutationRequest = async (path, method = "GET", body) => {
    calls.push({ path, method, ...(body === undefined ? {} : { body: structuredClone(body) }) });
    if (method === "GET") return read(path);
    assert.equal(++writes, 1);
    const parts = path.split("/");
    let ack: Record<string, unknown> | undefined;
    if (parts[2] === "associations") associate(parts, method, body);
    else ack = configure(parts, method, body);
    if (controls.lostAck) return { ok: false, reason: "timeout" };
    return ok(controls.omitAckId ? {} : ack, ack === undefined ? controls.ackStatus : 201);
  };
  return {
    request,
    actor,
    issueSchemes,
    prioritySchemes,
    projects,
    issueTypes,
    priorities,
    controls,
    calls,
    snapshot: () => ({
      issueSchemes: structuredClone([...issueSchemes.values()]),
      prioritySchemes: structuredClone([...prioritySchemes.values()]),
      associations: [...associations],
      writes,
    }),
  };
}
