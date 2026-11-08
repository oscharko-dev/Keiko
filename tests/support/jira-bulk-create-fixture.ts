import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import { field, LINKS_FIELD } from "./jira-managed-remote.js";

export const BULK_CREATE_ARGUMENTS = { expectedActorKey: "synthetic-actor", confirmUnverifiedEffect: true, issues: [
  { projectId: "10000", issueTypeId: "3", fields: { summary: "First reviewed issue" } },
  { projectId: "10000", issueTypeId: "3", fields: { summary: "Second reviewed issue" } },
] } as const;
export const BULK_CREATE_RECEIPT = { userKey: "synthetic-actor", requestedIssueCount: 2, issueIds: ["10001", "9223372036854775807"], issueKeys: ["SYN-1", "SYN-2"] } as const;
export function bulkCreateFixture() {
  const actor = { key: "synthetic-actor", name: "operator" };
  const calls: { path: string; method: string; body: unknown; expect: unknown }[] = [];
  const controls = { lostAck: false, denyReadback: false, throwReadback: false, actorChangesBefore: false, wrongReadback: false,
    includeLabels: false, includeLinks: true, duplicateExists: false, requiredCustom: false, reject: false, ackStatus: 201 };
  let effects = 0; let body: unknown;
  let acknowledgement: Record<string, unknown> = { issues: [{ id: "10001", key: "SYN-1" }, { id: "9223372036854775807", key: "SYN-2" }], errors: [] };
  const ok = (value: Record<string, unknown>): AtlassianWriteHttpOutcome => ({ ok: true, status: 200, body: value });
  function read(path: string): AtlassianWriteHttpOutcome {
    if (path === "myself") {
      const count = calls.filter((call) => call.path === "myself").length;
      return ok({ ...actor, key: controls.actorChangesBefore && count > 1 ? "changed-actor" : actor.key });
    }
    const url = new URL(path, "https://synthetic.invalid/");
    if (url.pathname === "/project/10000") return ok({ id: "10000", key: "SYN", name: "Synthetic" });
    if (url.pathname === "/issuetype/3") return ok({ id: "3", name: "Story" });
    if (url.pathname === "/issue/createmeta/10000/issuetypes/3") {
      assert.equal(url.searchParams.get("startAt"), "0"); assert.equal(url.searchParams.get("maxResults"), "100");
      const values = [field("project", "project", true), field("issuetype", "issuetype", true), field("summary", "string", true), field("description", "string")];
      if (controls.includeLabels) values.push({ ...field("labels", "array"), schema: { type: "array", items: "string", system: "labels" } });
      if (controls.includeLinks) values.push(LINKS_FIELD);
      if (controls.requiredCustom) values.push({ ...field("customfield_10000", "string", true), schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" } });
      return ok({ startAt: 0, maxResults: 100, isLast: true, total: values.length, values });
    }
    if (url.pathname === "/search") return ok({ startAt: 0, maxResults: 50, total: controls.duplicateExists ? 1 : 0,
      issues: controls.duplicateExists ? [{ id: "10009", key: "SYN-9", fields: { summary: "First reviewed issue" } }] : [] });
    const id = url.pathname.slice("/issue/".length); assert.ok(id === "10001" || id === "9223372036854775807");
    assert.equal(url.searchParams.get("fields"), "issuetype,project,summary");
    return ok({ id: controls.wrongReadback ? "10099" : id, key: id === "10001" ? "SYN-1" : "SYN-2",
      fields: { summary: id === "10001" ? "First reviewed issue" : "Second reviewed issue", project: { id: "10000" }, issuetype: { id: "3" } } });
  }
  const request: JiraMutationRequest = async (path, method = "GET", value, expect) => {
    calls.push({ path, method, body: structuredClone(value), expect });
    if (effects > 0 && controls.throwReadback) throw new Error("Synthetic bulk readback failure");
    if (effects > 0 && controls.denyReadback) return { ok: false, reason: "permission-denied", httpStatus: 403 };
    if (method === "GET") return read(path);
    assert.equal(path, "issue/bulk"); assert.equal(method, "POST"); assert.equal(expect, "json");
    const payload = asRecord(value); assert.ok(payload); assert.ok(Array.isArray(payload.issueUpdates)); assert.equal(payload.issueUpdates.length, 2);
    body = structuredClone(value); assert.equal(++effects, 1);
    if (controls.lostAck) return { ok: false, reason: "timeout" };
    if (controls.reject) return { ok: false, reason: "field-validation", httpStatus: 400 };
    return { ok: true, status: controls.ackStatus, body: structuredClone(acknowledgement) };
  };
  return { request, actor, calls, controls,
    setAcknowledgement(value: Record<string, unknown>): void { acknowledgement = value; },
    submitted: (): unknown => body,
    snapshot: (): CatalogJsonObject => ({ effects }) };
}
