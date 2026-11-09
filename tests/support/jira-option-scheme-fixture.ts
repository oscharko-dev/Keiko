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
type SchemeFields<Members extends string, Default extends string> = Readonly<
  Record<Members, readonly string[]> &
    Record<Default, string> &
    Record<"name" | "description", string>
>;
type SchemeReceipt = Readonly<{ userKey: string; schemeId: string; schemePresent: boolean }>;
interface SchemeCrudCase<
  Tool extends string,
  Method extends string,
  Args extends object,
  Body extends object | undefined,
  Confirmed extends boolean,
> {
  readonly tool: Tool;
  readonly args: Args;
  readonly method: Method;
  readonly path: string;
  readonly body: Body;
  readonly confirmed: Confirmed;
  readonly receipt: SchemeReceipt;
}
type SchemeCrudCases<
  Create extends string,
  Update extends string,
  Remove extends string,
  Base extends object,
  Members extends string,
  Default extends string,
> = readonly [
  SchemeCrudCase<
    Create,
    "POST",
    { readonly expectedActorKey: string } & SchemeFields<Members, Default>,
    SchemeFields<Members, Default>,
    true
  >,
  SchemeCrudCase<
    Update,
    "PUT",
    Base & SchemeFields<Members, Default>,
    SchemeFields<Members, Default>,
    true
  >,
  SchemeCrudCase<
    Remove,
    "DELETE",
    Base & { readonly confirmUnverifiedConsequences: true },
    undefined,
    false
  >,
];
interface SchemeCrudSpec<
  Create extends string,
  Update extends string,
  Remove extends string,
  Base extends object,
  Members extends string,
  Default extends string,
> {
  readonly tools: readonly [Create, Update, Remove];
  readonly names: readonly [string, string];
  readonly base: Base;
  readonly members: Members;
  readonly defaultMember: Default;
  readonly collection: string;
  readonly id: string;
}
// The reviewed arguments list the members before the default; the native body the reverse.
function schemeFields<Members extends string, Default extends string>(
  spec: { readonly members: Members; readonly defaultMember: Default },
  name: string,
  defaultFirst: boolean,
): SchemeFields<Members, Default> {
  const members = { [spec.members]: ["2", "1"] };
  const fallback = { [spec.defaultMember]: "2" };
  const ordered = defaultFirst ? { ...fallback, ...members } : { ...members, ...fallback };
  return { name, description: "", ...ordered } as SchemeFields<Members, Default>;
}
const schemeReceipt = (schemeId: string, schemePresent: boolean): SchemeReceipt => ({
  userKey: ACTOR,
  schemeId,
  schemePresent,
});
// Create, update and delete share one shape for the issue-type and the priority scheme.
function schemeCrudCases<
  Create extends string,
  Update extends string,
  Remove extends string,
  Base extends object,
  Members extends string,
  Default extends string,
>(
  spec: SchemeCrudSpec<Create, Update, Remove, Base, Members, Default>,
): SchemeCrudCases<Create, Update, Remove, Base, Members, Default> {
  const item = `${spec.collection}/${spec.id}`;
  return [
    {
      tool: spec.tools[0],
      args: { expectedActorKey: ACTOR, ...schemeFields(spec, spec.names[0], false) },
      method: "POST",
      path: spec.collection,
      body: schemeFields(spec, spec.names[0], true),
      confirmed: true,
      receipt: schemeReceipt("9007199254740993", true),
    },
    {
      tool: spec.tools[1],
      args: { ...spec.base, ...schemeFields(spec, spec.names[1], false) },
      method: "PUT",
      path: item,
      body: schemeFields(spec, spec.names[1], true),
      confirmed: true,
      receipt: schemeReceipt(spec.id, true),
    },
    {
      tool: spec.tools[2],
      args: { ...spec.base, confirmUnverifiedConsequences: true },
      method: "DELETE",
      path: item,
      body: undefined,
      confirmed: false,
      receipt: schemeReceipt(spec.id, false),
    },
  ];
}
export const OPTION_SCHEME_MUTATION_CASES = [
  ...schemeCrudCases({
    tools: [
      "jira.create-issue-type-scheme",
      "jira.update-issue-type-scheme",
      "jira.delete-issue-type-scheme",
    ],
    names: ["Planning types", "Delivery types revised"],
    base: ISSUE,
    members: "issueTypeIds",
    defaultMember: "defaultIssueTypeId",
    collection: "issuetypescheme",
    id: "7",
  }),
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
  ...schemeCrudCases({
    tools: [
      "jira.create-priority-scheme",
      "jira.update-priority-scheme",
      "jira.delete-priority-scheme",
    ],
    names: ["Planning priorities", "Delivery priorities revised"],
    base: PRIORITY,
    members: "optionIds",
    defaultMember: "defaultOptionId",
    collection: "priorityschemes",
    id: "9",
  }),
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
/** Live Jira 10.3 returns an issue type scheme's member and default types only on request. */
function expandIssueScheme(stored: SchemeRecord, query: string): SchemeRecord {
  const expanded = new URLSearchParams(query).get("expand")?.split(",") ?? [];
  const item = { ...stored };
  if (!expanded.includes("issueTypes")) delete item.issueTypes;
  if (!expanded.includes("defaultIssueType")) delete item.defaultIssueType;
  return item;
}
function schemeAssociations(state: OptionSchemeState): AtlassianWriteHttpOutcome {
  return state.controls.missingAssociations
    ? schemeOk()
    : {
        ok: true,
        status: 200,
        body: undefined,
        items: state.associations.map((id) => ({ ...state.projects.get(id) })),
      };
}
function splitRead(path: string): { parts: string[]; query: string } {
  const at = path.indexOf("?");
  return {
    parts: (at < 0 ? path : path.slice(0, at)).split("/"),
    query: at < 0 ? "" : path.slice(at + 1),
  };
}
function schemeRead(state: OptionSchemeState, path: string): AtlassianWriteHttpOutcome {
  const failure = schemeReadbackFailure(state);
  if (failure !== undefined) return failure;
  const fixed = schemeStaticRead(state, path);
  if (fixed !== undefined) return fixed;
  const { parts, query } = splitRead(path);
  const issue = parts[0] === "issuetypescheme";
  const stored = (issue ? state.issueSchemes : state.prioritySchemes).get(parts[1] ?? "");
  if (stored === undefined) return schemeMissing();
  if (parts[2] === "associations") return schemeAssociations(state);
  const concurrent = state.writes > 0 && state.controls.wrongReadback;
  return schemeOk({
    ...(issue ? expandIssueScheme(stored, query) : stored),
    ...(concurrent ? { name: "Concurrent scheme" } : {}),
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
