import assert from "node:assert/strict";
import { settleSync } from "./jira-fixture-settle.js";
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
type SchemeBody = Parameters<JiraMutationRequest>[2];
type SchemeRecord = Record<string, unknown>;
interface SchemeNamed {
  id: string;
  name: string;
}
interface OptionSchemeControls {
  lostAck: boolean;
  omitAckId: boolean;
  wrongReadback: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  missingAssociations: boolean;
  ackStatus: number;
}
interface OptionSchemeState {
  readonly actor: { key: string; name: string };
  readonly issueTypes: { id: string; name: string; subtask: boolean }[];
  readonly priorities: SchemeNamed[];
  readonly issueSchemes: Map<string, SchemeRecord>;
  readonly prioritySchemes: Map<string, SchemeRecord>;
  readonly projects: Map<string, { id: string; key: string; name: string }>;
  readonly calls: { path: string; method: string; body?: unknown }[];
  readonly controls: OptionSchemeControls;
  associations: string[];
  writes: number;
}
export interface OptionSchemeFixture {
  readonly request: JiraMutationRequest;
  readonly actor: OptionSchemeState["actor"];
  readonly issueSchemes: Map<string, SchemeRecord>;
  readonly prioritySchemes: Map<string, SchemeRecord>;
  readonly projects: OptionSchemeState["projects"];
  readonly issueTypes: OptionSchemeState["issueTypes"];
  readonly priorities: SchemeNamed[];
  readonly controls: OptionSchemeControls;
  readonly calls: OptionSchemeState["calls"];
  snapshot(): {
    issueSchemes: SchemeRecord[];
    prioritySchemes: SchemeRecord[];
    associations: string[];
    writes: number;
  };
}
const schemeOk = (body?: SchemeRecord, status = 200): AtlassianWriteHttpOutcome => ({
  ok: true,
  status,
  body,
});
const schemeMissing = (): AtlassianWriteHttpOutcome => ({
  ok: false,
  reason: "not-found",
  httpStatus: 404,
});
function schemeReadbackFailure(state: OptionSchemeState): AtlassianWriteHttpOutcome | undefined {
  if (state.writes && state.controls.throwReadback)
    throw new Error("Synthetic scheme readback defect");
  if (state.writes && state.controls.denyReadback)
    return { ok: false, reason: "permission-denied", httpStatus: 403 };
  return undefined;
}
function schemeStaticRead(
  state: OptionSchemeState,
  path: string,
): AtlassianWriteHttpOutcome | undefined {
  if (path === "myself") return schemeOk({ ...state.actor });
  if (path === "issuetype" || path === "priority")
    return {
      ok: true,
      status: 200,
      body: undefined,
      items: path === "issuetype" ? state.issueTypes : state.priorities,
    };
  if (path.startsWith("project/")) {
    const value = state.projects.get(path.slice("project/".length));
    return value === undefined ? schemeMissing() : schemeOk(value);
  }
  return undefined;
}
function schemeRead(state: OptionSchemeState, path: string): AtlassianWriteHttpOutcome {
  const failure = schemeReadbackFailure(state);
  if (failure !== undefined) return failure;
  const fixed = schemeStaticRead(state, path);
  if (fixed !== undefined) return fixed;
  const { controls } = state;
  const parts = path.split("/");
  const selected = parts[0] === "issuetypescheme" ? state.issueSchemes : state.prioritySchemes;
  const item = selected.get(parts[1] ?? "");
  if (item === undefined) return schemeMissing();
  if (parts[2] === "associations")
    return controls.missingAssociations
      ? schemeOk()
      : {
          ok: true,
          status: 200,
          body: undefined,
          items: state.associations.map((id) => ({ ...state.projects.get(id) })),
        };
  return schemeOk({
    ...item,
    ...(state.writes && controls.wrongReadback ? { name: "Concurrent scheme" } : {}),
  });
}
function schemeAssociate(
  state: OptionSchemeState,
  parts: readonly string[],
  method: string,
  body: SchemeBody,
): void {
  if (method === "DELETE") {
    state.associations =
      parts[3] === undefined ? [] : state.associations.filter((id) => id !== parts[3]);
    return;
  }
  const raw = asRecord(body);
  assert.ok(raw);
  assert.ok(Array.isArray(raw.idsOrKeys));
  const ids: string[] = [];
  for (const id of raw.idsOrKeys) {
    assert.ok(typeof id === "string");
    assert.ok(state.projects.has(id));
    ids.push(id);
  }
  state.associations = method === "PUT" ? ids : [...new Set([...state.associations, ...ids])];
}
function schemeConfigure(
  state: OptionSchemeState,
  parts: readonly string[],
  method: string,
  body: SchemeBody,
): SchemeRecord | undefined {
  const selected = parts[0] === "issuetypescheme" ? state.issueSchemes : state.prioritySchemes;
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
      issueTypes: raw.issueTypeIds.map((value) =>
        state.issueTypes.find((item) => item.id === value),
      ),
      defaultIssueType: state.issueTypes.find((item) => item.id === raw.defaultIssueTypeId),
    });
  } else selected.set(id, { id, ...raw, defaultScheme: false });
  return parts[1] === undefined ? { id } : undefined;
}
function schemeRequest(
  state: OptionSchemeState,
  path: string,
  method: string,
  body: SchemeBody,
): AtlassianWriteHttpOutcome {
  state.calls.push({
    path,
    method,
    ...(body === undefined ? {} : { body: structuredClone(body) }),
  });
  if (method === "GET") return schemeRead(state, path);
  assert.equal(++state.writes, 1);
  const parts = path.split("/");
  let ack: SchemeRecord | undefined;
  if (parts[2] === "associations") schemeAssociate(state, parts, method, body);
  else ack = schemeConfigure(state, parts, method, body);
  if (state.controls.lostAck) return { ok: false, reason: "timeout" };
  return schemeOk(
    state.controls.omitAckId ? {} : ack,
    ack === undefined ? state.controls.ackStatus : 201,
  );
}
function seedIssueSchemes(issueTypes: OptionSchemeState["issueTypes"]): Map<string, SchemeRecord> {
  return new Map<string, SchemeRecord>([
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
}
function seedPrioritySchemes(): Map<string, SchemeRecord> {
  return new Map<string, SchemeRecord>([
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
}
function optionSchemeState(): OptionSchemeState {
  const issueTypes = [
    { id: "1", name: "Task", subtask: false },
    { id: "2", name: "Bug", subtask: false },
  ];
  return {
    actor: { key: ACTOR, name: "operator" },
    issueTypes,
    priorities: [
      { id: "1", name: "High" },
      { id: "2", name: "Normal" },
    ],
    issueSchemes: seedIssueSchemes(issueTypes),
    prioritySchemes: seedPrioritySchemes(),
    projects: new Map([
      [CURRENT.id, { ...CURRENT }],
      [OTHER.id, { ...OTHER }],
    ]),
    calls: [],
    controls: {
      lostAck: false,
      omitAckId: false,
      wrongReadback: false,
      denyReadback: false,
      throwReadback: false,
      missingAssociations: false,
      ackStatus: 204,
    },
    associations: [CURRENT.id],
    writes: 0,
  };
}
export function optionSchemeFixture(): OptionSchemeFixture {
  const state = optionSchemeState();
  const request: JiraMutationRequest = (path, method = "GET", body) =>
    settleSync(() => schemeRequest(state, path, method, body));
  return {
    request,
    actor: state.actor,
    issueSchemes: state.issueSchemes,
    prioritySchemes: state.prioritySchemes,
    projects: state.projects,
    issueTypes: state.issueTypes,
    priorities: state.priorities,
    controls: state.controls,
    calls: state.calls,
    snapshot: () => ({
      issueSchemes: structuredClone([...state.issueSchemes.values()]),
      prioritySchemes: structuredClone([...state.prioritySchemes.values()]),
      associations: [...state.associations],
      writes: state.writes,
    }),
  };
}
