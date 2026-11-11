import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraSchemaMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { settleSync } from "./jira-fixture-settle.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";

const ACTOR = "synthetic-actor";
const REVIEW = { expectedActorKey: ACTOR };
export const SCHEMA_TYPE = {
  id: "1",
  name: "Task",
  description: "Reviewed type",
  subtask: false,
  avatarId: "10",
};
export const SCHEMA_ALTERNATIVE = {
  id: "2",
  name: "Story",
  description: "Alternative",
  subtask: false,
};
export const SCHEMA_LINK = { id: "7", name: "Blocks", inward: "is blocked by", outward: "blocks" };
export const SCHEMA_OTHER_LINK = {
  id: "8",
  name: "Relates",
  inward: "relates to",
  outward: "relates to",
};
export const SCHEMA_FIELD = { id: "customfield_12", name: "Evidence", custom: true } as const;
export const SCHEMA_TERMS = [
  {
    originalName: "epic",
    originalNamePlural: "epics",
    newName: "epic",
    newNamePlural: "epics",
    isDefault: true,
  },
  {
    originalName: "sprint",
    originalNamePlural: "sprints",
    newName: "sprint",
    newNamePlural: "sprints",
    isDefault: true,
  },
];
const NEW_ID = "9007199254740993";
const NEW_LINK = { name: "Requires", inward: "is required by", outward: "requires" };
const ORDER = [SCHEMA_LINK, SCHEMA_OTHER_LINK];
const FIELD_CREATE = {
  name: "New evidence",
  description: "",
  type: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
  searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:textsearcher",
  projectIds: ["10000"],
  issueTypeIds: ["1"],
};
interface Scenario {
  readonly name: JiraSchemaMutation;
  readonly args: CatalogJsonObject;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly body: unknown;
  readonly receipt: CatalogJsonObject;
  readonly confirmed: boolean;
  readonly create?: boolean;
}
export const SCHEMA_MUTATION_FIXTURE_CASES = [
  {
    name: "jira.create-custom-field",
    args: { ...REVIEW, ...FIELD_CREATE },
    method: "POST",
    path: "field",
    body: { ...FIELD_CREATE, projectIds: [10000] },
    receipt: { userKey: ACTOR, fieldId: `customfield_${NEW_ID}`, fieldPresent: true },
    confirmed: false,
    create: true,
  },
  {
    name: "jira.delete-custom-fields",
    args: { ...REVIEW, expectedFields: [SCHEMA_FIELD], confirmUnverifiedDeletion: true },
    method: "DELETE",
    path: "customFields?ids=customfield_12",
    body: undefined,
    receipt: { userKey: ACTOR, fieldIds: ["customfield_12"], fieldPresent: false },
    confirmed: false,
  },
  {
    name: "jira.create-issue-type",
    args: { ...REVIEW, name: "New type", description: "", type: "standard" },
    method: "POST",
    path: "issuetype",
    body: { name: "New type", description: "", type: "standard" },
    receipt: { userKey: ACTOR, issueTypeId: NEW_ID, issueTypePresent: true },
    confirmed: false,
    create: true,
  },
  {
    name: "jira.update-issue-type",
    args: { ...REVIEW, expectedIssueType: SCHEMA_TYPE, description: "" },
    method: "PUT",
    path: "issuetype/1",
    body: { description: "" },
    receipt: { userKey: ACTOR, issueTypeId: "1", issueTypePresent: true },
    confirmed: true,
  },
  {
    name: "jira.delete-issue-type",
    args: {
      ...REVIEW,
      expectedIssueType: SCHEMA_TYPE,
      expectedAlternative: SCHEMA_ALTERNATIVE,
      confirmUnverifiedMigration: true,
    },
    method: "DELETE",
    path: "issuetype/1?alternativeIssueTypeId=2",
    body: undefined,
    receipt: {
      userKey: ACTOR,
      issueTypeId: "1",
      replacementIssueTypeId: "2",
      issueTypePresent: false,
    },
    confirmed: false,
  },
  {
    name: "jira.create-link-type",
    args: { ...REVIEW, ...NEW_LINK },
    method: "POST",
    path: "issueLinkType",
    body: NEW_LINK,
    receipt: { userKey: ACTOR, linkTypeId: NEW_ID, linkTypePresent: true },
    confirmed: true,
    create: true,
  },
  {
    name: "jira.update-link-type",
    args: { ...REVIEW, expectedLinkType: SCHEMA_LINK, ...NEW_LINK },
    method: "PUT",
    path: "issueLinkType/7",
    body: NEW_LINK,
    receipt: { userKey: ACTOR, linkTypeId: "7", linkTypePresent: true },
    confirmed: true,
  },
  {
    name: "jira.delete-link-type",
    args: { ...REVIEW, expectedLinkType: SCHEMA_LINK, confirmUnverifiedDeletion: true },
    method: "DELETE",
    path: "issueLinkType/7",
    body: undefined,
    receipt: { userKey: ACTOR, linkTypeId: "7", linkTypePresent: false },
    confirmed: false,
  },
  {
    name: "jira.reset-link-type-order",
    args: { ...REVIEW, expectedLinkTypes: ORDER, direction: "desc" },
    method: "PUT",
    path: "issueLinkType/order",
    body: { direction: "desc" },
    receipt: { userKey: ACTOR, linkTypeIds: ["7", "8"] },
    confirmed: false,
  },
  {
    name: "jira.move-link-type",
    args: { ...REVIEW, expectedLinkTypes: ORDER, linkTypeId: "8", newPosition: 1 },
    method: "PUT",
    path: "issueLinkType/8/order",
    body: { newPosition: 1 },
    receipt: { userKey: ACTOR, linkTypeId: "8", linkTypeIds: ["7", "8"] },
    confirmed: false,
  },
  {
    name: "jira.set-terminology",
    args: {
      ...REVIEW,
      expectedEntries: SCHEMA_TERMS,
      entries: [{ originalName: "epic", newName: "initiative", newNamePlural: "initiatives" }],
    },
    method: "POST",
    path: "terminology/entries",
    body: [{ originalName: "epic", newName: "initiative", newNamePlural: "initiatives" }],
    receipt: { userKey: ACTOR, terminologyNames: ["epic"] },
    confirmed: true,
  },
] as const satisfies readonly Scenario[];

interface SchemaControls {
  lostAck: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  wrongReadback: boolean;
  absentAckId: boolean;
  preexistingAckId: boolean;
  malformed2xx: boolean;
  permissionDenied: boolean;
  incompatibleAlternative: boolean;
  partialFieldDeletion: boolean;
  omitDescription: boolean;
  status: number;
}
interface SchemaCall {
  path: string;
  method: string;
  body: unknown;
  expect: unknown;
}
interface SchemaState {
  readonly actor: { key: string; name: string };
  readonly types: Map<string, Record<string, unknown>>;
  readonly links: Map<string, Record<string, unknown>>;
  readonly fields: Map<string, Record<string, unknown>>;
  readonly terms: Record<string, unknown>[];
  readonly controls: SchemaControls;
  readonly calls: SchemaCall[];
  wrote: boolean;
}
function schemaState(): SchemaState {
  return {
    actor: { key: ACTOR, name: "operator" },
    types: new Map<string, Record<string, unknown>>([
      ["1", { ...SCHEMA_TYPE }],
      ["2", { ...SCHEMA_ALTERNATIVE }],
    ]),
    links: new Map<string, Record<string, unknown>>([
      ["7", { ...SCHEMA_LINK }],
      ["8", { ...SCHEMA_OTHER_LINK }],
    ]),
    fields: new Map<string, Record<string, unknown>>([[SCHEMA_FIELD.id, { ...SCHEMA_FIELD }]]),
    terms: structuredClone(SCHEMA_TERMS),
    controls: {
      lostAck: false,
      denyReadback: false,
      throwReadback: false,
      wrongReadback: false,
      absentAckId: false,
      preexistingAckId: false,
      malformed2xx: false,
      permissionDenied: false,
      incompatibleAlternative: false,
      partialFieldDeletion: false,
      omitDescription: false,
      status: 200,
    },
    calls: [],
    wrote: false,
  };
}
function schemaOk(body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body: { ...body } };
}
function schemaArray(items: readonly unknown[]): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body: undefined, items: structuredClone(items) };
}
function schemaMissing(): AtlassianWriteHttpOutcome {
  return { ok: false, reason: "not-found", httpStatus: 404 };
}
function schemaTypeRead(state: SchemaState, path: string): AtlassianWriteHttpOutcome | undefined {
  const { types, controls } = state;
  if (path === "/issuetype") return schemaArray([...types.values()]);
  if (path === "/issuetype/1/alternatives")
    return schemaArray(controls.incompatibleAlternative ? [] : [SCHEMA_ALTERNATIVE]);
  const match = /^\/issuetype\/(\d+)$/u.exec(path);
  if (match === null) return undefined;
  const item = types.get(match[1] ?? "");
  if (item === undefined) return schemaMissing();
  const body = { ...item };
  if (controls.omitDescription) delete body.description;
  if (state.wrote && controls.wrongReadback) body.name = "Concurrent type";
  return schemaOk(body);
}
function schemaLinkRead(state: SchemaState, path: string): AtlassianWriteHttpOutcome {
  const { links, controls } = state;
  if (path === "/issueLinkType") return schemaOk({ issueLinkTypes: [...links.values()] });
  const id = /^\/issueLinkType\/(\d+)$/u.exec(path)?.[1];
  const link = id === undefined ? undefined : links.get(id);
  if (link !== undefined)
    return schemaOk({
      ...link,
      ...(state.wrote && controls.wrongReadback ? { name: "Concurrent link" } : {}),
    });
  return schemaMissing();
}
function schemaRead(state: SchemaState, url: URL): AtlassianWriteHttpOutcome {
  if (url.pathname === "/myself") return schemaOk(state.actor);
  if (url.pathname === "/project/10000")
    return schemaOk({ id: "10000", key: "SYN", name: "Synthetic" });
  if (url.pathname === "/field")
    return schemaArray([
      { id: "summary", name: "Summary", custom: false },
      ...state.fields.values(),
    ]);
  if (url.pathname === "/terminology/entries") return schemaArray(state.terms);
  return schemaTypeRead(state, url.pathname) ?? schemaLinkRead(state, url.pathname);
}
/** A delete removes the stored record; any other write merges the native body into it. */
function storedChange(
  store: Map<string, Record<string, unknown>>,
  id: string,
  method: string,
  body: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (method === "DELETE") {
    assert.ok(store.delete(id));
    return {};
  }
  const current = store.get(id);
  assert.ok(current);
  assert.ok(body);
  Object.assign(current, body);
  return {};
}
function schemaTypeEffect(
  state: SchemaState,
  url: URL,
  method: string,
  body: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const { types, controls } = state;
  if (url.pathname === "/issuetype") {
    assert.ok(body);
    types.set(NEW_ID, {
      id: NEW_ID,
      name: body.name,
      description: body.description,
      subtask: body.type === "subtask",
    });
    return { id: controls.preexistingAckId ? "1" : NEW_ID };
  }
  const id = /^\/issuetype\/(\d+)$/u.exec(url.pathname)?.[1];
  if (id === undefined) return undefined;
  return storedChange(types, id, method, body);
}
function schemaLinkEffect(
  state: SchemaState,
  url: URL,
  method: string,
  body: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const { links, controls } = state;
  if (url.pathname === "/issueLinkType") {
    assert.ok(body);
    links.set(NEW_ID, { ...body, id: NEW_ID });
    return { id: controls.preexistingAckId ? "7" : NEW_ID };
  }
  if (
    url.pathname === "/issueLinkType/order" ||
    /^\/issueLinkType\/\d+\/order$/u.test(url.pathname)
  )
    return {};
  const id = /^\/issueLinkType\/(\d+)$/u.exec(url.pathname)?.[1];
  if (id === undefined) return undefined;
  return storedChange(links, id, method, body);
}
function schemaFieldEffect(
  state: SchemaState,
  url: URL,
  body: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (url.pathname === "/field") {
    assert.ok(body);
    state.fields.set(`customfield_${NEW_ID}`, {
      id: `customfield_${NEW_ID}`,
      name: body.name,
      custom: true,
    });
    return { id: `customfield_${NEW_ID}` };
  }
  if (url.pathname === "/customFields") {
    if (!state.controls.partialFieldDeletion)
      for (const id of url.searchParams.getAll("ids")) state.fields.delete(id);
    return { deletedCustomFields: [], notDeletedCustomFields: {} };
  }
  return undefined;
}
function schemaTerminologyEffect(state: SchemaState, value: unknown): Record<string, unknown> {
  assert.ok(Array.isArray(value));
  for (const item of value) {
    const entry = asRecord(item);
    assert.ok(entry);
    const prior = state.terms.find((term) => term.originalName === entry.originalName);
    assert.ok(prior);
    Object.assign(prior, entry, { isDefault: entry.newName === entry.originalName });
  }
  return {};
}
function schemaEffect(
  state: SchemaState,
  url: URL,
  method: string,
  value: unknown,
): Record<string, unknown> {
  const body = asRecord(value);
  const field = schemaFieldEffect(state, url, body);
  if (field !== undefined) return field;
  if (url.pathname === "/terminology/entries") return schemaTerminologyEffect(state, value);
  const type = schemaTypeEffect(state, url, method, body);
  if (type !== undefined) return type;
  const link = schemaLinkEffect(state, url, method, body);
  if (link !== undefined) return link;
  throw new TypeError(`Unexpected synthetic schema route ${method} ${url.pathname}`);
}
function schemaReadback(state: SchemaState, url: URL): AtlassianWriteHttpOutcome {
  const { controls } = state;
  if (state.wrote && controls.throwReadback)
    throw new TypeError("Synthetic schema readback defect");
  if (state.wrote && controls.denyReadback)
    return { ok: false, reason: "permission-denied", httpStatus: 403 };
  return schemaRead(state, url);
}
function schemaDispatch(state: SchemaState, call: SchemaCall): AtlassianWriteHttpOutcome {
  const { path, method, body, expect } = call;
  const { controls } = state;
  const url = new URL(path, "https://synthetic.invalid/");
  if (method === "GET") return schemaReadback(state, url);
  if (controls.permissionDenied)
    return {
      ok: false,
      reason: "permission-denied",
      httpStatus: 403,
      remote: { messages: ["Synthetic refusal"] },
    };
  const acknowledgement = schemaEffect(state, url, method, body);
  state.wrote = true;
  if (controls.lostAck) return { ok: false, reason: "timeout" };
  if (controls.malformed2xx) return { ok: false, reason: "malformed-payload", httpStatus: 201 };
  return {
    ok: true,
    status: controls.status,
    body: expect === "none" || controls.absentAckId ? undefined : acknowledgement,
  };
}
export function schemaMutationFixture(): {
  readonly actor: { key: string; name: string };
  readonly types: Map<string, Record<string, unknown>>;
  readonly links: Map<string, Record<string, unknown>>;
  readonly fields: Map<string, Record<string, unknown>>;
  readonly terms: Record<string, unknown>[];
  readonly controls: SchemaControls;
  readonly calls: SchemaCall[];
  readonly request: JiraMutationRequest;
} {
  const state = schemaState();
  const { actor, types, links, fields, terms, controls, calls } = state;
  const request: JiraMutationRequest = (path, method = "GET", body, expect = "json") =>
    settleSync(() => {
      calls.push({ path, method, body: structuredClone(body), expect });
      return schemaDispatch(state, { path, method, body, expect });
    });
  return { actor, types, links, fields, terms, controls, calls, request };
}
