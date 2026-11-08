import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraIssueContextRead as read, isJiraIssueContextRead, JIRA_ISSUE_CONTEXT_READS } from "./jira-managed-issue-context-reads.js";

const BASE = "https://jira.example.invalid/context";
const PARENT = { id: "10001", key: "APP-1", fields: { summary: "Parent" } };
const COMMENT = { id: "20", body: "Native comment", created: "2026-11-07T10:00:00.000+0000", author: { name: "reader", displayName: "Reader", emailAddress: "omit@example.invalid" } };
const PIN = { comment: COMMENT, pinnedBy: "reader", pinnedDate: "2026-11-07T11:00:00.000+0000" };
const CHILD = { id: "10002", key: "APP-2", self: "https://untrusted.invalid/child", fields: { summary: "Child", status: { id: "1", name: "Open" }, issuetype: { id: "5", name: "Sub-task" } } };
const REMOTE = { id: 30, globalId: "system=example&id=30", application: { type: "example", name: "Example" }, relationship: "relates to", object: { title: "External reference", summary: "", url: "https://untrusted.invalid/reference", icon: { url16x16: "https://untrusted.invalid/icon" }, status: { resolved: false } }, self: "https://public.example.invalid/other-context/rest/api/2/issue/10001/remotelink/30" };
const REMOTE_SNAPSHOT = { id: "30", globalId: REMOTE.globalId, applicationType: "example", applicationName: "Example", relationship: "relates to",
  url: REMOTE.object.url, title: REMOTE.object.title, summary: "", iconUrl: REMOTE.object.icon.url16x16, iconTitle: null,
  resolved: false, statusIconUrl: null, statusIconTitle: null, statusIconLink: null };
function object(body: Record<string, unknown>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body };
}
function array(items: readonly unknown[]): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body: undefined, items };
}
function fixture(primary: AtlassianWriteHttpOutcome, parent: AtlassianWriteHttpOutcome = object(PARENT)): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>((path) => Promise.resolve(
    path.endsWith("?fields=summary") ? parent
      : path === "project/10000" ? object({ id: "10000", key: "APP", name: "Application" })
        : primary,
  ));
}
function selectedArgs(name: (typeof JIRA_ISSUE_CONTEXT_READS)[number]): CatalogJsonObject {
  if (name === "jira.issue-picker") return {};
  return name === "jira.remote-link" ? { issueIdOrKey: "APP-1", linkId: "30" } : { issueIdOrKey: "APP-1" };
}

describe("bound native issue context reads", () => {
  it("binds a lowercase parent alias before paging pinned comments locally", async () => {
    const request = fixture(array([PIN, { comment: { ...COMMENT, id: "21", body: "Second" } }]));
    expect((await read("jira.pinned-comments", { issueIdOrKey: "app-1", startAt: 1, maxResults: 1 }, request, BASE)).data).toMatchObject({
      outcome: "succeeded", issueId: "10001", issueKey: "APP-1", startAt: 1, total: 2,
      items: [{ id: "21", body: "Second", created: COMMENT.created, author: { name: "reader", displayName: "Reader" } }],
    });
    expect(request.mock.calls).toEqual([
      ["issue/app-1?fields=summary"], ["issue/10001/pinned-comments", "GET", undefined, "json-array"],
    ]);
  });
  it("preserves native pin metadata without author email or a rendered HTML field", async () => {
    const result = await read("jira.pinned-comments", { issueIdOrKey: "10001" }, fixture(array([PIN])), BASE);
    expect(result.data.items).toEqual([{ id: "20", body: COMMENT.body, created: COMMENT.created,
      author: { name: "reader", displayName: "Reader" }, pinnedBy: "reader", pinnedDate: PIN.pinnedDate }]);
    expect(JSON.stringify(result)).not.toContain("emailAddress");
  });
  it("reuses issue summaries and server-owned browse URLs for subtasks", async () => {
    const request = fixture(array([CHILD]));
    const result = await read("jira.subtasks", { issueIdOrKey: "APP-1" }, request, BASE);
    expect(result.data).toMatchObject({ issueId: "10001", issueKey: "APP-1", total: 1,
      items: [{ id: "10002", key: "APP-2", summary: "Child", browseUrl: `${BASE}/browse/APP-2`, status: { id: "1", name: "Open" } }] });
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
    expect(request).toHaveBeenLastCalledWith("issue/10001/subtask", "GET", undefined, "json-array");
  });
  it.each([true, false])("observes the scalar subtask ordering capability %s without any effect", async (scalar) => {
    const request = fixture({ ok: true, status: 200, body: undefined, scalar });
    expect((await read("jira.subtask-move-availability", { issueIdOrKey: "APP-1" }, request, BASE)).data).toEqual({ outcome: "succeeded", issueId: "10001", issueKey: "APP-1", canReorderSubtasks: scalar });
    expect(request).toHaveBeenLastCalledWith("issue/10001/subtask/move", "GET", undefined, "json-scalar");
  });
  it.each([object({ enabled: false }), { ok: true, status: 200, body: undefined, scalar: "false" } as const])("does not coerce a nonboolean capability response", async (response) => {
    expect((await read("jira.subtask-move-availability", { issueIdOrKey: "APP-1" }, fixture(response), BASE)).data.reason).toBe("malformed-payload");
  });
  it("projects supported native remote-link review facts as text without following URLs", async () => {
    const request = fixture(array([REMOTE]));
    expect((await read("jira.remote-links", { issueIdOrKey: "APP-1" }, request, BASE)).data).toEqual({ outcome: "succeeded", issueId: "10001", issueKey: "APP-1", startAt: 0, total: 1,
      items: [{ id: "30", globalId: REMOTE.globalId, application: REMOTE.application, relationship: "relates to", title: "External reference", summary: "", resolved: false,
        reviewSnapshotAvailable: true, reviewSnapshot: REMOTE_SNAPSHOT }] });
    expect(request).toHaveBeenLastCalledWith("issue/10001/remotelink", "GET", undefined, "json-array");
    expect(request.mock.calls.every(([path]) => !path.startsWith("http"))).toBe(true);
  });
  it("uses the documented single-object response for an exact global ID selector", async () => {
    const request = fixture(object(REMOTE));
    expect((await read("jira.remote-links", { issueIdOrKey: "APP-1", globalId: REMOTE.globalId }, request, BASE)).data).toMatchObject({ outcome: "succeeded", issueId: "10001", id: "30", globalId: REMOTE.globalId });
    expect(request).toHaveBeenLastCalledWith("issue/10001/remotelink?globalId=system%3Dexample%26id%3D30", "GET", undefined, "json");
  });
  it("retains a string int64 remote-link identity and verifies the observed target", async () => {
    const id = "9223372036854775807";
    const request = fixture(object({ ...REMOTE, id, self: `https://public.example.invalid/rest/api/2/issue/10001/remotelink/${id}` }));
    expect((await read("jira.remote-link", { issueIdOrKey: "APP-1", linkId: id }, request, BASE)).data.id).toBe(id);
    expect(request).toHaveBeenLastCalledWith(`issue/10001/remotelink/${id}`, "GET", undefined, "json");
  });
  it.each([
    ["jira.remote-link", { issueIdOrKey: "APP-1", linkId: "31" }, object(REMOTE)],
    ["jira.remote-links", { issueIdOrKey: "APP-1", globalId: "other" }, object(REMOTE)],
    ["jira.remote-links", { issueIdOrKey: "APP-1", globalId: REMOTE.globalId }, array([REMOTE])],
    ["jira.remote-links", { issueIdOrKey: "APP-1" }, object(REMOTE)],
  ] as const)("refuses an unbound identity or wrong native response form for %s", async (name, args, response) => {
    expect((await read(name, args, fixture(response), BASE)).data.reason).toBe("malformed-payload");
  });
  it("keeps absent remote-link metadata unknown and explicit empty collections empty", async () => {
    expect((await read("jira.remote-link", { issueIdOrKey: "APP-1", linkId: "30" }, fixture(object({ id: 30, application: null, object: null })), BASE)).data).toEqual({ outcome: "succeeded", issueId: "10001", issueKey: "APP-1", id: "30", reviewSnapshotAvailable: false });
    expect((await read("jira.remote-links", { issueIdOrKey: "APP-1" }, fixture(array([])), BASE)).data).toMatchObject({ items: [], total: 0 });
  });
  it.each([
    { ...REMOTE, object: { title: "Only title" } },
    { ...REMOTE, extraNativeField: "Not reviewed" },
    { ...REMOTE, object: { ...REMOTE.object, url: "javascript:alert(1)" } },
    { ...REMOTE, object: { ...REMOTE.object, url: "https://secret@remote.example.invalid/value" } },
    { ...REMOTE, object: { ...REMOTE.object, icon: { url16x16: "https://example.invalid/icon", link: "https://example.invalid/unsupported-field" } } },
  ])("preserves an explicit unavailable snapshot instead of inventing a complete replacement", async (native) => {
    const request = fixture(object(native));
    const result = await read("jira.remote-link", { issueIdOrKey: "APP-1", linkId: "30" }, request, BASE);
    expect(result.data).toMatchObject({ outcome: "succeeded", id: "30", reviewSnapshotAvailable: false });
    expect(result.data).not.toHaveProperty("reviewSnapshot");
    expect(result.data).not.toHaveProperty("browseUrl");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("preserves explicit native null and false separately in the complete replacement snapshot", async () => {
    const native = { ...REMOTE, object: { ...REMOTE.object, summary: null, icon: null, status: { resolved: false, icon: null } } };
    const result = await read("jira.remote-link", { issueIdOrKey: "APP-1", linkId: "30" }, fixture(object(native)), BASE);
    expect(result.data.reviewSnapshot).toEqual({ ...REMOTE_SNAPSHOT, summary: null, iconUrl: null });
  });
  it("compares supplied comment and link self identities across proxy origins without following them", async () => {
    const pinned = { ...PIN, comment: { ...COMMENT, self: "http://public.example.invalid:8080/proxy/rest/api/2/issue/10001/comment/20" } };
    const request = fixture(array([pinned]));
    expect((await read("jira.pinned-comments", { issueIdOrKey: "APP-1" }, request, BASE)).data.outcome).toBe("succeeded");
    expect(request).toHaveBeenCalledTimes(2);
    expect((await read("jira.remote-link", { issueIdOrKey: "APP-1", linkId: "30" }, fixture(object(REMOTE)), BASE)).data.outcome).toBe("succeeded");
  });
  it.each([
    ["jira.pinned-comments", array([{ ...PIN, comment: { ...COMMENT, self: "https://public.example.invalid/rest/api/2/issue/10099/comment/20" } }])],
    ["jira.pinned-comments", array([{ ...PIN, comment: { ...COMMENT, self: "https://public.example.invalid/rest/api/2/issue/10001/comment/21" } }])],
    ["jira.remote-links", array([{ ...REMOTE, self: "https://public.example.invalid/rest/api/2/issue/10099/remotelink/30" }])],
    ["jira.remote-link", object({ ...REMOTE, self: "https://public.example.invalid/rest/api/2/issue/10001/remotelink/31" })],
  ] as const)("refuses contradictory supplied membership evidence for %s", async (name, response) => {
    const request = fixture(response);
    expect((await read(name, selectedArgs(name), request, BASE)).data.reason).toBe("conflict");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([{ id: "10099" }, { key: "APP-99" }, { id: "10001", key: "APP-99" }, {}, "APP-1"])("refuses supplied subtask parent evidence that does not bind the selected parent %j", async (parent) => {
    const request = fixture(array([{ ...CHILD, fields: { ...CHILD.fields, parent } }]));
    expect((await read("jira.subtasks", { issueIdOrKey: "APP-1" }, request, BASE)).data.reason).toBe("conflict");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([{ id: "10001" }, { key: "app-1" }, { id: "10001", key: "APP-1" }, null])("preserves matching or unknown subtask parent evidence without inventing returned fields %j", async (parent) => {
    const result = await read("jira.subtasks", { issueIdOrKey: "APP-1" }, fixture(array([{ ...CHILD, fields: { ...CHILD.fields, parent } }])), BASE);
    expect(result.data.outcome).toBe("succeeded");
    expect(result.data.items).toEqual([expect.not.objectContaining({ parent })]);
  });
  it.each([
    ["jira.pinned-comments", [PIN, PIN]], ["jira.subtasks", [CHILD, CHILD]], ["jira.remote-links", [REMOTE, REMOTE]],
    ["jira.pinned-comments", [{ comment: { ...COMMENT, id: "01" } }]],
    ["jira.subtasks", [{ ...CHILD, id: "not-an-id" }]],
    ["jira.remote-links", [{ ...REMOTE, object: { status: { resolved: "false" } } }]],
  ] as const)("refuses malformed or duplicated identities in %s", async (name, values) => {
    expect((await read(name, { issueIdOrKey: "APP-1" }, fixture(array(values)), BASE)).data.reason).toBe("malformed-payload");
  });
  it.each(["jira.pinned-comments", "jira.subtasks", "jira.remote-links"] as const)("refuses an oversized complete collection before local pagination for %s", async (name) => {
    const request = fixture(array(Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, () => ({}))));
    expect((await read(name, { issueIdOrKey: "APP-1", maxResults: 1 }, request, BASE)).data.reason).toBe("bounds-exceeded");
  });
  it.each([
    ["jira.pinned-comments", array([{ comment: { ...COMMENT, body: "界".repeat(30000) } }])],
    ["jira.remote-links", array([{ ...REMOTE, object: { summary: "x".repeat(32769) } }])],
    ["jira.remote-link", object({ ...REMOTE, id: Number.MAX_SAFE_INTEGER + 1 })],
  ] as const)("reports native byte/identity bounds on %s", async (name, response) => {
    expect((await read(name, selectedArgs(name), fixture(response), BASE)).data.reason).toBe("bounds-exceeded");
  });
  it.each([
    ["jira.subtasks", { issueIdOrKey: "APP-1", url: "https://untrusted.invalid" }],
    ["jira.subtasks", { issueIdOrKey: "../other" }],
    ["jira.subtasks", { issueIdOrKey: "APP-1", maxResults: 101 }],
    ["jira.remote-links", { issueIdOrKey: "APP-1", globalId: "a", startAt: 0 }],
    ["jira.remote-link", { issueIdOrKey: "APP-1", linkId: "01" }],
    ["jira.subtask-move-availability", { issueIdOrKey: "APP-1", newParent: "APP-2" }],
    ["jira.subtask-move-availability", { issueIdOrKey: "APP-1", startAt: 0 }],
  ] as const)("rejects invalid or effect-bearing input before any request to %s", async (name, args) => {
    const request = fixture(array([]));
    expect((await read(name, args, request, BASE)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    object({ ...PARENT, key: "APP-99" }), object({ ...PARENT, id: "not-an-id" }),
    { ok: false, reason: "permission-denied", httpStatus: 403 } as const,
  ])("does not request a child resource after failed parent attribution", async (parent) => {
    const request = fixture(array([]), parent);
    expect((await read("jira.subtasks", { issueIdOrKey: "APP-1" }, request, BASE)).data.outcome).toBe("failed");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("preserves longer canonical platform issue keys without an Agile project-prefix restriction", async () => {
    const key = `${"A".repeat(40)}-1`;
    const request = fixture(array([]), object({ ...PARENT, key }));
    expect((await read("jira.subtasks", { issueIdOrKey: key }, request, BASE)).data.issueKey).toBe(key);
  });
  it("does not translate a child-resource permission refusal into an empty collection", async () => {
    const request = fixture({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await read("jira.remote-links", { issueIdOrKey: "APP-1" }, request, BASE)).data.reason).toBe("permission-denied");
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("native issue picker suggestions", () => {
  it("binds optional contexts and sends closed native query names without arbitrary fields", async () => {
    const request = fixture(object({ sections: [{ id: "current", label: "Current search", issues: [{ key: "APP-2", summaryText: "Plain summary", summary: "<b>Untrusted HTML</b>", keyHtml: "<b>APP-2</b>", img: "https://untrusted.invalid/icon" }] }] }));
    const result = await read("jira.issue-picker", { query: "Child", currentJQL: "project = APP", currentIssueKey: "app-1", currentProjectId: "10000", showSubTasks: false, showSubTaskParent: true }, request, BASE);
    expect(result.data).toEqual({ outcome: "succeeded", suggestionsScope: "native-suggestions", sections: [{ id: "current", label: "Current search", issues: [{ key: "APP-2", summary: "Plain summary", browseUrl: `${BASE}/browse/APP-2` }] }] });
    expect(request.mock.calls).toEqual([
      ["issue/app-1?fields=summary"], ["project/10000"],
      ["issue/picker?query=Child&currentJQL=project+%3D+APP&showSubTasks=false&showSubTaskParent=true&currentIssueKey=APP-1&currentProjectId=10000", "GET", undefined, "json"],
    ]);
  });
  it("preserves unknown versus empty section populations and never substitutes HTML for plain summary", async () => {
    const response = object({ sections: [{ id: "unknown" }, { id: "null", issues: null }, { id: "empty", issues: [] }, { id: "selected", issues: [{ key: "APP-2", summary: "<b>Only HTML</b>" }] }] });
    expect((await read("jira.issue-picker", {}, fixture(response), BASE)).data.sections).toEqual([
      { id: "unknown" }, { id: "null" }, { id: "empty", issues: [] }, { id: "selected", issues: [{ key: "APP-2", browseUrl: `${BASE}/browse/APP-2` }] },
    ]);
  });
  it("allows native empty query/JQL and preserves the same suggestion in distinct sections", async () => {
    const request = fixture(object({ sections: [{ id: "a", issues: [{ key: "APP-2", summaryText: "" }] }, { id: "b", issues: [{ key: "APP-2" }] }] }));
    expect((await read("jira.issue-picker", { query: "", currentJQL: "" }, request, BASE)).data.outcome).toBe("succeeded");
    expect(request).toHaveBeenCalledExactlyOnceWith("issue/picker?query=&currentJQL=", "GET", undefined, "json");
  });
  it.each([
    {}, { sections: {} }, { sections: [{ id: "a" }, { id: "a" }] },
    { sections: [{ issues: [{ key: "APP-1" }, { key: "APP-1" }] }] },
    { sections: [{ issues: [{ key: "../escape" }] }] }, { sections: [{ issues: [{ key: "APP-1", summaryText: false }] }] },
  ])("refuses malformed picker shape or identity %j", async (body) => {
    expect((await read("jira.issue-picker", {}, fixture(object(body)), BASE)).data.reason).toBe("malformed-payload");
  });
  it.each([
    Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, () => ({})),
    [{ issues: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, () => ({ key: "APP-1" })) }],
  ].map((sections) => ({ sections })))("refuses oversized suggestions without truncating a nonpageable result", async (body) => {
    expect((await read("jira.issue-picker", {}, fixture(object(body)), BASE)).data.reason).toBe("bounds-exceeded");
  });
  it.each([
    { query: null }, { query: "x".repeat(256) }, { currentJQL: "x".repeat(2049) },
    { showSubTasks: "false" }, { currentIssueKey: "../escape" }, { currentProjectId: "01" },
    { currentIssueKey: "APP-1", currentProjectId: 10000 }, { startAt: 0 }, { fields: ["description"] },
  ] satisfies readonly CatalogJsonObject[])("refuses invalid picker input before even binding an optional parent %j", async (args) => {
    const request = fixture(object({ sections: [] }));
    expect((await read("jira.issue-picker", args, request, BASE)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it("refuses an unreadable optional context instead of silently dropping its scope", async () => {
    const request = fixture(object({ sections: [] }), { ok: false, reason: "not-found", httpStatus: 404 });
    expect((await read("jira.issue-picker", { currentIssueKey: "APP-1" }, request, BASE)).data.reason).toBe("not-found");
    expect(request).toHaveBeenCalledExactlyOnceWith("issue/APP-1?fields=summary");
  });
  it.each(JIRA_ISSUE_CONTEXT_READS)("keeps the closed tool guard read-only for %s", (name) => {
    expect(isJiraIssueContextRead(name)).toBe(true);
    expect(isJiraIssueContextRead("jira.move-subtask")).toBe(false);
    expect(isJiraIssueContextRead("jira.create-remote-link")).toBe(false);
  });
});
