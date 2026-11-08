import { expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraRemoteLinkMutation, isJiraRemoteLinkMutation } from "./jira-managed-remote-link-mutations.js";

const ISSUE = { id: "10001", key: "SYN-1", fields: { summary: "Synthetic issue" } };
const ID = "9007199254740993";
const VALUE = { globalId: "synthetic:42&part=1", applicationType: null, applicationName: null, relationship: null,
  url: "https://example.invalid/remote/42", title: "Synthetic target", summary: null,
  iconUrl: null, iconTitle: null, resolved: false, statusIconUrl: null, statusIconTitle: null, statusIconLink: null };
const UPDATED = { ...VALUE, title: "Updated target", summary: "Reviewed replacement" };
const EXPECTED = { id: ID, ...VALUE };
const BASE = { issueIdOrKey: ISSUE.key, expectedActorKey: "synthetic-actor" };
const CREATE: CatalogJsonObject = { ...BASE, value: VALUE, expectAbsent: true };
const UPDATE: CatalogJsonObject = { ...BASE, linkId: ID, expected: EXPECTED, value: UPDATED };
const DELETE: CatalogJsonObject = { ...BASE, linkId: ID, expected: EXPECTED };
const NATIVE = { id: ID, globalId: VALUE.globalId, object: { url: VALUE.url, title: VALUE.title, status: { resolved: false } } };
const AFTER = { ...NATIVE, object: { ...NATIVE.object, title: UPDATED.title, summary: UPDATED.summary } };
const LIST = `issue/${ISSUE.id}/remotelink`;
type Operation = Parameters<typeof executeJiraRemoteLinkMutation>[0];
function response(body: Record<string, unknown> | undefined, status = 200): AtlassianWriteHttpOutcome { return { ok: true, status, body }; }
function collection(items: readonly unknown[]): AtlassianWriteHttpOutcome { return { ok: true, status: 200, body: undefined, items }; }
interface Scenario {
  readonly existing?: boolean;
  readonly deleting?: boolean;
  readonly before?: readonly unknown[];
  readonly after?: readonly unknown[];
  readonly afterList?: AtlassianWriteHttpOutcome | Error;
  readonly write?: AtlassianWriteHttpOutcome;
  readonly actor?: string;
  readonly afterActor?: string;
  readonly afterIssue?: Record<string, unknown>;
  readonly detail?: Record<string, unknown>;
  readonly afterDetail?: Record<string, unknown>;
  readonly heldChange?: boolean;
}
function fixture(options: Scenario = {}): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let written = false;
  let collections = 0;
  return vi.fn<JiraMutationRequest>(async (path, method = "GET") => {
    if (method !== "GET") {
      written = true;
      return options.write ?? response(method === "POST" ? { id: ID } : undefined, method === "POST" ? 201 : 204);
    }
    if (path === "myself") return response({ key: written ? options.afterActor ?? "synthetic-actor" : options.actor ?? "synthetic-actor", name: "synthetic.user" });
    if (path.endsWith("?fields=summary")) return response(written ? options.afterIssue ?? ISSUE : ISSUE);
    if (path === LIST) {
      collections++;
      if (written && options.afterList !== undefined) {
        if (options.afterList instanceof Error) throw options.afterList;
        return options.afterList;
      }
      if (!written && options.heldChange && collections > 1) return collection([AFTER]);
      return collection(written ? options.after ?? (options.deleting ? [] : options.existing ? [AFTER] : [NATIVE])
        : options.before ?? (options.existing ? [NATIVE] : []));
    }
    if (path === `${LIST}/${ID}`) return response(written ? options.afterDetail ?? (options.existing ? AFTER : NATIVE) : options.detail ?? NATIVE);
    throw new TypeError(`Unexpected fixed native path: ${path}`);
  });
}
function effects(request: ReturnType<typeof fixture>): readonly Parameters<JiraMutationRequest>[] { return request.mock.calls.filter(([, method = "GET"]) => method !== "GET"); }
function run(request: JiraMutationRequest, operation: Operation = "jira.upsert-remote-link", args: CatalogJsonObject = CREATE, check = false) {
  return executeJiraRemoteLinkMutation(operation, args, request, check);
}

it("exposes only the four single-parent native remote-link effects", () => {
  expect(isJiraRemoteLinkMutation("jira.upsert-remote-link")).toBe(true);
  expect(isJiraRemoteLinkMutation("jira.reciprocal-remote-link")).toBe(false);
});
it.each([ISSUE.key.toLowerCase(), ISSUE.id])("creates under canonical parent for %s with one POST and independent exact readback", async (issueIdOrKey) => {
  const request = fixture();
  expect(await run(request, "jira.upsert-remote-link", { ...CREATE, issueIdOrKey })).toEqual({ ok: true, receipt: {
    issueId: ISSUE.id, issueKey: ISSUE.key, userKey: "synthetic-actor", linkPresent: true, linkId: ID,
  } });
  expect(effects(request)).toEqual([[LIST, "POST", {
    globalId: VALUE.globalId, application: { type: null, name: null }, relationship: null,
    object: { url: VALUE.url, title: VALUE.title, summary: null, icon: { url16x16: null, title: null },
      status: { resolved: false, icon: { url16x16: null, title: null, link: null } } },
  }, "json"]]);
  expect(request.mock.calls.at(-1)?.[0]).toBe(`${LIST}/${ID}`);
  expect(request.mock.calls.every(([path]) => !path.startsWith("http"))).toBe(true);
});
it("uses explicit expected snapshot for POST replacement, never treats upsert as unconditional create", async () => {
  const request = fixture({ existing: true });
  expect(await run(request, "jira.upsert-remote-link", { ...BASE, expected: EXPECTED, value: UPDATED })).toMatchObject({ ok: true, receipt: { linkId: ID } });
  expect(effects(request)[0]?.slice(0, 2)).toEqual([LIST, "POST"]);
});
it("uses status-only PUT with the already bound ID and preserves explicit false/null", async () => {
  const request = fixture({ existing: true });
  expect(await run(request, "jira.update-remote-link", UPDATE)).toMatchObject({ ok: true, receipt: { linkId: ID } });
  expect(effects(request)[0]).toMatchObject([`${LIST}/${ID}`, "PUT", { object: { title: UPDATED.title, summary: UPDATED.summary, status: { resolved: false } } }, "none"]);
});
it.each([
  ["jira.delete-remote-link", DELETE, `${LIST}/${ID}`],
  ["jira.delete-remote-link-by-global-id", { ...BASE, globalId: VALUE.globalId, expected: EXPECTED }, `${LIST}?globalId=synthetic%3A42%26part%3D1`],
] as const)("deletes one exact %s member and confirms complete same-parent absence", async (operation, args, path) => {
  const request = fixture({ existing: true, deleting: true });
  expect(await run(request, operation, args)).toMatchObject({ ok: true, receipt: { linkId: ID, linkPresent: false } });
  expect(effects(request)).toEqual([[path, "DELETE", undefined, "none"]]);
});
it.each([
  ["jira.upsert-remote-link", CREATE, false], ["jira.update-remote-link", UPDATE, true], ["jira.delete-remote-link", DELETE, true],
  ["jira.delete-remote-link-by-global-id", { ...BASE, globalId: VALUE.globalId, expected: EXPECTED }, true],
] as const)("dry-run %s has zero effects", async (operation, args, existing) => {
  const request = fixture({ existing });
  expect(await run(request, operation, args, true)).toEqual({ ok: true, receipt: {} });
  expect(effects(request)).toHaveLength(0);
});
it("refuses expectAbsent if native POST would silently overwrite a global ID", async () => {
  const request = fixture({ existing: true });
  expect(await run(request)).toMatchObject({ ok: false, reason: "conflict" });
  expect(effects(request)).toHaveLength(0);
});
it("refuses a changed replacement snapshot before PUT", async () => {
  const request = fixture({ existing: true, before: [AFTER] });
  expect(await run(request, "jira.update-remote-link", UPDATE)).toMatchObject({ ok: false, reason: "conflict" });
  expect(effects(request)).toHaveLength(0);
});
it("reports a native unchanged value without dispatch or a fabricated success", async () => {
  const request = fixture({ existing: true });
  expect(await run(request, "jira.update-remote-link", { ...UPDATE, value: VALUE })).toMatchObject({ ok: false, detail: { unchanged: true }, receipt: { linkId: ID } });
  expect(effects(request)).toHaveLength(0);
});
it.each([
  { actor: "another-actor" }, { existing: true, heldChange: true },
  { existing: true, detail: { ...NATIVE, self: "https://proxy.example.invalid/context/rest/api/2/issue/999/remotelink/9007199254740993" } },
  { existing: true, before: [NATIVE, NATIVE] },
  { existing: true, before: [{ ...NATIVE, unreviewedPluginField: true }] },
  { existing: true, before: [{ ...NATIVE, object: { ...NATIVE.object, icon: { unreviewed: true } } }] },
])("refuses incomplete, changed or foreign pre-effect evidence: %j", async (options) => {
  const request = fixture(options);
  expect(await run(request, "jira.update-remote-link", UPDATE)).toMatchObject({ ok: false });
  expect(effects(request)).toHaveLength(0);
});
it("accepts comparison-only proxy self metadata without following it", async () => {
  const observed = { ...NATIVE, self: `http://proxy.example.invalid/different/rest/api/2/${LIST}/${ID}` };
  const request = fixture({ existing: true, before: [observed], detail: observed });
  expect(await run(request, "jira.update-remote-link", UPDATE)).toMatchObject({ ok: true });
  expect(request.mock.calls.every(([path]) => !path.startsWith("http"))).toBe(true);
});
it.each(["unavailable", "timeout"] as const)("lost %s acknowledgement stays unknown with no replay or later adoption", async (reason) => {
  const request = fixture({ existing: true, write: { ok: false, reason } });
  expect(await run(request, "jira.update-remote-link", UPDATE)).toMatchObject({ ok: false, reason, receipt: { linkId: ID, linkPresent: true } });
  expect(effects(request)).toHaveLength(1);
  expect(request.mock.calls.at(-1)?.[1]).toBe("PUT");
});
it("does not adopt a newly searched ID when POST acknowledgement omits identity", async () => {
  const request = fixture({ write: response({}, 200) });
  const outcome = await run(request);
  expect(outcome).toMatchObject({ ok: false, reason: "unavailable", receipt: { issueId: ISSUE.id } });
  expect(outcome.receipt).not.toHaveProperty("linkId");
  expect(effects(request)).toHaveLength(1);
});
it("a known upsert identity can be independently confirmed after an empty acknowledgement body", async () => {
  const request = fixture({ existing: true, write: response({}, 200) });
  expect(await run(request, "jira.upsert-remote-link", { ...BASE, expected: EXPECTED, value: UPDATED })).toMatchObject({ ok: true, receipt: { linkId: ID } });
});
it("a contradictory POST acknowledgement cannot retarget a reviewed update", async () => {
  const request = fixture({ existing: true, write: response({ id: "88" }, 200) });
  expect(await run(request, "jira.upsert-remote-link", { ...BASE, expected: EXPECTED, value: UPDATED })).toMatchObject({ ok: false, reason: "conflict", receipt: { linkId: ID } });
  expect(request.mock.calls.some(([path]) => path === `${LIST}/88`)).toBe(false);
});
it.each(["invalid", "092", null, Number.MAX_SAFE_INTEGER + 1])("retains a reviewed ID but refuses explicit malformed ACK identity %s", async (id) => {
  const request = fixture({ existing: true, write: response({ id }, 200) });
  expect(await run(request, "jira.upsert-remote-link", { ...BASE, expected: EXPECTED, value: UPDATED })).toMatchObject({ ok: false, reason: "conflict", receipt: { linkId: ID } });
  expect(effects(request)).toHaveLength(1);
});
it("retains the acknowledged exact ID even when readback is denied", async () => {
  const request = fixture({ afterList: { ok: false, reason: "permission-denied" } });
  expect(await run(request)).toMatchObject({ ok: false, reason: "permission-denied", receipt: { linkId: ID } });
});
it("does not convert404 or an object envelope into proof of deletion", async () => {
  for (const afterList of [{ ok: false, reason: "not-found" }, response({ total: 0, values: [] })] as const) {
    const request = fixture({ existing: true, deleting: true, afterList });
    expect(await run(request, "jira.delete-remote-link", DELETE)).toMatchObject({ ok: false, receipt: { linkId: ID, linkPresent: false } });
    expect(effects(request)).toHaveLength(1);
  }
});
it("actor loss after ACK preserves the known remote-link receipt", async () => {
  const request = fixture({ afterActor: "changed-actor" });
  expect(await run(request)).toMatchObject({ ok: false, reason: "conflict", receipt: { linkId: ID } });
  expect(effects(request)).toHaveLength(1);
});
it("post-ACK programming failures propagate with original cause and receipt", async () => {
  const cause = new TypeError("Synthetic readback fault");
  const request = fixture({ afterList: cause });
  await expect(run(request)).rejects.toMatchObject({ name: "JiraAcknowledgedMutationError", cause, receipt: { linkId: ID } });
  expect(effects(request)).toHaveLength(1);
});
it.each([
  { ...CREATE, expected: EXPECTED }, { ...BASE, value: VALUE }, { ...CREATE, method: "PUT" },
  { ...CREATE, value: { ...VALUE, globalId: "x".repeat(256) } },
  { ...CREATE, value: { ...VALUE, url: "javascript:alert(1)" } },
  { ...CREATE, value: { ...VALUE, url: "https://secret@example.invalid/item" } },
  { ...CREATE, value: { ...VALUE, title: "\ud800" } }, { ...CREATE, value: { title: "partial" } },
])("rejects widened or incomplete input before requesting any native resource", async (args) => {
  const request = fixture();
  expect(await run(request, "jira.upsert-remote-link", args)).toMatchObject({ ok: false, reason: "field-validation" });
  expect(request).not.toHaveBeenCalled();
});
