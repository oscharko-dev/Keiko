import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraSchemaMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";

const ACTOR = "synthetic-actor";
const REVIEW = { expectedActorKey: ACTOR };
export const SCHEMA_TYPE = { id: "1", name: "Task", description: "Reviewed type", subtask: false, avatarId: "10" };
export const SCHEMA_ALTERNATIVE = { id: "2", name: "Story", description: "Alternative", subtask: false };
export const SCHEMA_LINK = { id: "7", name: "Blocks", inward: "is blocked by", outward: "blocks" };
export const SCHEMA_OTHER_LINK = { id: "8", name: "Relates", inward: "relates to", outward: "relates to" };
export const SCHEMA_FIELD = { id: "customfield_12", name: "Evidence", custom: true } as const;
export const SCHEMA_TERMS = [
  { originalName: "epic", originalNamePlural: "epics", newName: "epic", newNamePlural: "epics", isDefault: true },
  { originalName: "sprint", originalNamePlural: "sprints", newName: "sprint", newNamePlural: "sprints", isDefault: true },
];
const NEW_ID = "9007199254740993";
const NEW_LINK = { name: "Requires", inward: "is required by", outward: "requires" };
const ORDER = [SCHEMA_LINK, SCHEMA_OTHER_LINK];
const FIELD_CREATE = { name: "New evidence", description: "", type: "com.atlassian.jira.plugin.system.customfieldtypes:textfield", searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:textsearcher", projectIds: ["10000"], issueTypeIds: ["1"] };
interface Scenario { readonly name: JiraSchemaMutation; readonly args: CatalogJsonObject; readonly method: "POST" | "PUT" | "DELETE"; readonly path: string; readonly body: unknown; readonly receipt: CatalogJsonObject; readonly confirmed: boolean; readonly create?: boolean }
export const SCHEMA_MUTATION_FIXTURE_CASES = [
  { name: "jira.create-custom-field", args: { ...REVIEW, ...FIELD_CREATE }, method: "POST", path: "field", body: { ...FIELD_CREATE, projectIds: [10000] }, receipt: { userKey: ACTOR, fieldId: `customfield_${NEW_ID}`, fieldPresent: true }, confirmed: false, create: true },
  { name: "jira.delete-custom-fields", args: { ...REVIEW, expectedFields: [SCHEMA_FIELD], confirmUnverifiedDeletion: true }, method: "DELETE", path: "customFields?ids=customfield_12", body: undefined, receipt: { userKey: ACTOR, fieldIds: ["customfield_12"], fieldPresent: false }, confirmed: false },
  { name: "jira.create-issue-type", args: { ...REVIEW, name: "New type", description: "", type: "standard" }, method: "POST", path: "issuetype", body: { name: "New type", description: "", type: "standard" }, receipt: { userKey: ACTOR, issueTypeId: NEW_ID, issueTypePresent: true }, confirmed: false, create: true },
  { name: "jira.update-issue-type", args: { ...REVIEW, expectedIssueType: SCHEMA_TYPE, description: "" }, method: "PUT", path: "issuetype/1", body: { description: "" }, receipt: { userKey: ACTOR, issueTypeId: "1", issueTypePresent: true }, confirmed: true },
  { name: "jira.delete-issue-type", args: { ...REVIEW, expectedIssueType: SCHEMA_TYPE, expectedAlternative: SCHEMA_ALTERNATIVE, confirmUnverifiedMigration: true }, method: "DELETE", path: "issuetype/1?alternativeIssueTypeId=2", body: undefined, receipt: { userKey: ACTOR, issueTypeId: "1", replacementIssueTypeId: "2", issueTypePresent: false }, confirmed: false },
  { name: "jira.create-link-type", args: { ...REVIEW, ...NEW_LINK }, method: "POST", path: "issueLinkType", body: NEW_LINK, receipt: { userKey: ACTOR, linkTypeId: NEW_ID, linkTypePresent: true }, confirmed: true, create: true },
  { name: "jira.update-link-type", args: { ...REVIEW, expectedLinkType: SCHEMA_LINK, ...NEW_LINK }, method: "PUT", path: "issueLinkType/7", body: NEW_LINK, receipt: { userKey: ACTOR, linkTypeId: "7", linkTypePresent: true }, confirmed: true },
  { name: "jira.delete-link-type", args: { ...REVIEW, expectedLinkType: SCHEMA_LINK, confirmUnverifiedDeletion: true }, method: "DELETE", path: "issueLinkType/7", body: undefined, receipt: { userKey: ACTOR, linkTypeId: "7", linkTypePresent: false }, confirmed: false },
  { name: "jira.reset-link-type-order", args: { ...REVIEW, expectedLinkTypes: ORDER, direction: "desc" }, method: "PUT", path: "issueLinkType/order", body: { direction: "desc" }, receipt: { userKey: ACTOR, linkTypeIds: ["7", "8"] }, confirmed: false },
  { name: "jira.move-link-type", args: { ...REVIEW, expectedLinkTypes: ORDER, linkTypeId: "8", newPosition: 1 }, method: "PUT", path: "issueLinkType/8/order", body: { newPosition: 1 }, receipt: { userKey: ACTOR, linkTypeId: "8", linkTypeIds: ["7", "8"] }, confirmed: false },
  { name: "jira.set-terminology", args: { ...REVIEW, expectedEntries: SCHEMA_TERMS, entries: [{ originalName: "epic", newName: "initiative", newNamePlural: "initiatives" }] }, method: "POST", path: "terminology/entries", body: [{ originalName: "epic", newName: "initiative", newNamePlural: "initiatives" }], receipt: { userKey: ACTOR, terminologyNames: ["epic"] }, confirmed: true },
] as const satisfies readonly Scenario[];

export function schemaMutationFixture() {
  const actor = { key: ACTOR, name: "operator" };
  const types = new Map<string, Record<string, unknown>>([["1", { ...SCHEMA_TYPE }], ["2", { ...SCHEMA_ALTERNATIVE }]]);
  const links = new Map<string, Record<string, unknown>>([["7", { ...SCHEMA_LINK }], ["8", { ...SCHEMA_OTHER_LINK }]]);
  const fields = new Map<string, Record<string, unknown>>([[SCHEMA_FIELD.id, { ...SCHEMA_FIELD }]]);
  const terms: Record<string, unknown>[] = structuredClone(SCHEMA_TERMS);
  const controls = { lostAck: false, denyReadback: false, throwReadback: false, wrongReadback: false,
    absentAckId: false, preexistingAckId: false, malformed2xx: false, permissionDenied: false, incompatibleAlternative: false,
    partialFieldDeletion: false, omitDescription: false, status: 200 };
  const calls: { path: string; method: string; body: unknown; expect: unknown }[] = [];
  let wrote = false;
  const ok = (body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome => ({ ok: true, status: 200, body: { ...body } });
  const array = (items: readonly unknown[]): AtlassianWriteHttpOutcome => ({ ok: true, status: 200, body: undefined, items: structuredClone(items) });
  const missing = (): AtlassianWriteHttpOutcome => ({ ok: false, reason: "not-found", httpStatus: 404 });
  function typeRead(path: string): AtlassianWriteHttpOutcome | undefined {
    if (path === "/issuetype") return array([...types.values()]);
    if (path === "/issuetype/1/alternatives") return array(controls.incompatibleAlternative ? [] : [SCHEMA_ALTERNATIVE]);
    const match = /^\/issuetype\/(\d+)$/u.exec(path); if (match === null) return undefined;
    const item = types.get(match[1] ?? ""); if (item === undefined) return missing();
    const body = { ...item }; if (controls.omitDescription) delete body.description;
    if (wrote && controls.wrongReadback) body.name = "Concurrent type";
    return ok(body);
  }
  function read(url: URL): AtlassianWriteHttpOutcome {
    if (url.pathname === "/myself") return ok(actor);
    if (url.pathname === "/project/10000") return ok({ id: "10000", key: "SYN", name: "Synthetic" });
    if (url.pathname === "/field") return array([{ id: "summary", name: "Summary", custom: false }, ...fields.values()]);
    if (url.pathname === "/terminology/entries") return array(terms);
    const type = typeRead(url.pathname); if (type !== undefined) return type;
    if (url.pathname === "/issueLinkType") return ok({ issueLinkTypes: [...links.values()] });
    const id = /^\/issueLinkType\/(\d+)$/u.exec(url.pathname)?.[1];
    const link = id === undefined ? undefined : links.get(id);
    if (link !== undefined) return ok({ ...link, ...(wrote && controls.wrongReadback ? { name: "Concurrent link" } : {}) });
    return missing();
  }
  function typeEffect(url: URL, method: string, body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (url.pathname === "/issuetype") { assert.ok(body); types.set(NEW_ID, { id: NEW_ID, name: body.name, description: body.description, subtask: body.type === "subtask" }); return { id: controls.preexistingAckId ? "1" : NEW_ID }; }
    const id = /^\/issuetype\/(\d+)$/u.exec(url.pathname)?.[1]; if (id === undefined) return undefined;
    if (method === "DELETE") { assert.ok(types.delete(id)); return {}; }
    const current = types.get(id); assert.ok(current); assert.ok(body); Object.assign(current, body); return {};
  }
  function linkEffect(url: URL, method: string, body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (url.pathname === "/issueLinkType") { assert.ok(body); links.set(NEW_ID, { ...body, id: NEW_ID }); return { id: controls.preexistingAckId ? "7" : NEW_ID }; }
    if (url.pathname === "/issueLinkType/order" || /^\/issueLinkType\/\d+\/order$/u.test(url.pathname)) return {};
    const id = /^\/issueLinkType\/(\d+)$/u.exec(url.pathname)?.[1]; if (id === undefined) return undefined;
    if (method === "DELETE") { assert.ok(links.delete(id)); return {}; }
    const current = links.get(id); assert.ok(current); assert.ok(body); Object.assign(current, body); return {};
  }
  function effect(url: URL, method: string, value: unknown): Record<string, unknown> {
    const body = asRecord(value);
    if (url.pathname === "/field") { assert.ok(body); fields.set(`customfield_${NEW_ID}`, { id: `customfield_${NEW_ID}`, name: body.name, custom: true }); return { id: `customfield_${NEW_ID}` }; }
    if (url.pathname === "/customFields") { if (!controls.partialFieldDeletion) for (const id of url.searchParams.getAll("ids")) fields.delete(id); return { deletedCustomFields: [], notDeletedCustomFields: {} }; }
    if (url.pathname === "/terminology/entries") {
      assert.ok(Array.isArray(value)); for (const item of value) { const entry = asRecord(item); assert.ok(entry); const prior = terms.find((term) => term.originalName === entry.originalName); assert.ok(prior); Object.assign(prior, entry, { isDefault: entry.newName === entry.originalName }); } return {};
    }
    const type = typeEffect(url, method, body); if (type !== undefined) return type;
    const link = linkEffect(url, method, body); if (link !== undefined) return link;
    throw new TypeError(`Unexpected synthetic schema route ${method} ${url.pathname}`);
  }
  function readback(url: URL): AtlassianWriteHttpOutcome {
    if (wrote && controls.throwReadback) throw new TypeError("Synthetic schema readback defect");
    if (wrote && controls.denyReadback) return { ok: false, reason: "permission-denied", httpStatus: 403 };
    return read(url);
  }
  const request: JiraMutationRequest = async (path, method = "GET", body, expect = "json") => {
    calls.push({ path, method, body: structuredClone(body), expect });
    const url = new URL(path, "https://synthetic.invalid/");
    if (method === "GET") return readback(url);
    if (controls.permissionDenied) return { ok: false, reason: "permission-denied", httpStatus: 403, remote: { messages: ["Synthetic refusal"] } };
    const acknowledgement = effect(url, method, body); wrote = true;
    if (controls.lostAck) return { ok: false, reason: "timeout" };
    if (controls.malformed2xx) return { ok: false, reason: "malformed-payload", httpStatus: 201 };
    return { ok: true, status: controls.status, body: expect === "none" || controls.absentAckId ? undefined : acknowledgement };
  };
  return { actor, types, links, fields, terms, controls, calls, request };
}
