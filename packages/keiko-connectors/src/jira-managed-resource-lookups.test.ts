import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraResourceLookupRead as read, isJiraResourceLookupRead, JIRA_RESOURCE_LOOKUP_READS } from "./jira-managed-resource-lookups.js";

const VERSION = { id: "7", name: "Release", description: "", projectId: 10001, released: false, archived: false, releaseDate: "2026-11-07" };
const COMPONENT = { id: "8", name: "Service", project: "SYN", projectId: 10001, description: "", lead: { name: "owner", emailAddress: "unprojected@example.invalid" }, assigneeType: "PROJECT_LEAD", archived: false, deleted: false };
const LINK_TYPE = { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" };
function object(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
function nativePage(values: readonly unknown[]): Record<string, unknown> {
  return { values, startAt: 0, maxResults: 25, total: values.length, isLast: true };
}
function settings(items: readonly unknown[]): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body: undefined, items });
}
describe("native resource pages and connected-user accessibility metadata", () => {
  it("reuses version metadata on the native global page and encodes exact repeated project IDs", async () => {
    const request = object({ values: [VERSION], startAt: 2, maxResults: 1, total: 4, isLast: false, nextPage: "https://untrusted.invalid/other" });
    expect((await read("jira.global-version-page", { startAt: 2, maxResults: 1, query: "Release 1", projectIds: ["10001", "9223372036854775807"] }, request)).data).toEqual({
      outcome: "succeeded", items: [{ versionId: "7", name: "Release", description: "", projectId: "10001", released: false, archived: false, releaseDate: "2026-11-07" }], startAt: 2, total: 4, nextStartAt: 3,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("version?startAt=2&maxResults=1&query=Release+1&projectIds=10001&projectIds=9223372036854775807", "GET", undefined, "json");
  });
  it("uses the published List<Long> component filter instead of a CSV/JSON string", async () => {
    const request = object(nativePage([COMPONENT]));
    expect((await read("jira.component-page", { projectIds: ["10001", "10002"], query: "" }, request)).data).toEqual({ outcome: "succeeded", items: [{
      id: "8", name: "Service", project: "SYN", projectId: "10001", description: "", leadUserName: "owner", assigneeType: "PROJECT_LEAD", archived: false, deleted: false,
    }], startAt: 0, total: 1 });
    expect(request).toHaveBeenCalledExactlyOnceWith("component/page?startAt=0&maxResults=25&query=&projectIds=10001&projectIds=10002", "GET", undefined, "json");
  });
  it("preserves absent project ID and total as unknown without echoing selected IDs", async () => {
    const request = object({ values: [{ id: "7", name: "Release" }], startAt: 0, maxResults: 25, total: null, isLast: true });
    expect((await read("jira.global-version-page", { projectIds: ["10001"] }, request)).data).toEqual({ outcome: "succeeded", items: [{ versionId: "7", name: "Release" }], startAt: 0 });
  });
  it("requires the existing component projector's observed project key", async () => {
    expect((await read("jira.component-page", {}, object(nativePage([{ id: "8", name: "Service" }])))).data.reason).toBe("malformed-payload");
  });
  it.each([
    ["jira.global-version-page", VERSION], ["jira.component-page", COMPONENT],
  ] as const)("preserves string int64 project IDs in %s without rounding", async (name, value) => {
    const result = await read(name, {}, object(nativePage([{ ...value, projectId: "9223372036854775807" }])));
    expect(result.data.items).toEqual([expect.objectContaining({ projectId: "9223372036854775807" })]);
  });
  it.each([
    { values: [VERSION], startAt: 1, maxResults: 25, isLast: true, total: 1 },
    { values: [], startAt: 0, maxResults: 25, isLast: false, total: 1 },
    { values: [VERSION], startAt: 0, maxResults: 25, total: 1 },
    { values: [VERSION, VERSION], startAt: 0, maxResults: 25, isLast: true, total: 2 },
  ])("refuses inconsistent or duplicate global version pages %j", async (body) => {
    expect((await read("jira.global-version-page", {}, object(body))).data.reason).toBe("malformed-payload");
  });
  it.each(["jira.global-version-page", "jira.component-page"] as const)("refuses oversized returned pages from %s", async (name) => {
    const value = name === "jira.component-page" ? COMPONENT : VERSION;
    expect((await read(name, { maxResults: 1 }, object(nativePage([value, { ...value, id: "9" }])))).data.reason).toBe("bounds-exceeded");
  });
  it.each([
    ["jira.global-version-page", { ...VERSION, projectId: Number.MAX_SAFE_INTEGER + 1 }],
    ["jira.component-page", { ...COMPONENT, description: "x".repeat(32769) }],
    ["jira.global-version-page", { ...VERSION, description: "界".repeat(30000) }],
  ] as const)("classifies unrepresentable resource data as a bound refusal on %s", async (name, value) => {
    expect((await read(name, {}, object(nativePage([value])))).data.reason).toBe("bounds-exceeded");
  });
  it("binds one native link-type ID and retains relation direction without following self", async () => {
    const request = object({ ...LINK_TYPE, self: "https://untrusted.invalid/issueLinkType/999" });
    expect((await read("jira.link-type", { linkTypeId: "10000" }, request)).data).toEqual({ outcome: "succeeded", ...LINK_TYPE });
    expect(request).toHaveBeenCalledExactlyOnceWith("issueLinkType/10000", "GET", undefined, "json");
  });
  it.each([{ ...LINK_TYPE, id: "10001" }, { ...LINK_TYPE, inward: null }, { id: "10000" }])("refuses unbound or incomplete link-type data %j", async (body) => {
    expect((await read("jira.link-type", { linkTypeId: "10000" }, object(body))).data.reason).toBe("malformed-payload");
  });
  it("decodes the documented accessibility array and only pages it locally", async () => {
    const request = settings([{ key: "setting-a", enabled: true }, { key: "setting-b", enabled: false, image: { url: "https://untrusted.invalid/image" }, label: "Native label" }]);
    expect((await read("jira.accessibility-settings", { startAt: 1, maxResults: 1 }, request)).data).toEqual({ outcome: "succeeded", items: [{ key: "setting-b", enabled: false }], startAt: 1, total: 2, settingsScope: "connected-user" });
    expect(request).toHaveBeenCalledExactlyOnceWith("user/a11y/personal-settings", "GET", undefined, "json-array");
  });
  it("keeps missing accessibility preferences unknown and the explicit empty list empty", async () => {
    expect((await read("jira.accessibility-settings", {}, settings([{ key: "setting-a" }, { key: "setting-b", enabled: null }]))).data.items).toEqual([{ key: "setting-a" }, { key: "setting-b" }]);
    expect((await read("jira.accessibility-settings", {}, settings([]))).data).toEqual({ outcome: "succeeded", items: [], startAt: 0, total: 0, settingsScope: "connected-user" });
  });
  it("does not use the misleading singular Swagger reference as a fallback codec", async () => {
    expect((await read("jira.accessibility-settings", {}, object({ key: "setting-a", enabled: true }))).data.reason).toBe("malformed-payload");
  });
  it.each([
    [{ key: "setting-a", enabled: "false" }], [{ enabled: true }], [{ key: "" }],
    [{ key: "setting-a" }, { key: "setting-a", enabled: true }],
  ].map((items) => ({ items })))("refuses malformed accessibility identities/preferences %j", async ({ items }) => {
    expect((await read("jira.accessibility-settings", {}, settings(items))).data.reason).toBe("malformed-payload");
  });
  it("refuses an excessive accessibility collection before claiming a subset is complete", async () => {
    const items = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, i) => ({ key: `setting-${i}` }));
    expect((await read("jira.accessibility-settings", {}, settings(items))).data.reason).toBe("bounds-exceeded");
  });
  it.each([
    { projectIds: [] }, { projectIds: ["01"] }, { projectIds: [10001] }, { projectIds: ["7", "7"] },
    { projectIds: "7,8" }, { projectIds: null }, { query: null }, { maxResults: 101 },
    { expand: "projects" },
  ] satisfies readonly CatalogJsonObject[])("rejects undeclared or invalid native-page selectors %j", async (args) => {
    const request = object(nativePage([]));
    expect((await read("jira.component-page", args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it("refuses accessibility user selection and link-type mutation arguments before transport", async () => {
    const request = object({});
    expect((await read("jira.accessibility-settings", { username: "other" }, request)).data.reason).toBe("invalid-input");
    expect((await read("jira.link-type", { linkTypeId: "10000", inward: "changed" }, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it.each(JIRA_RESOURCE_LOOKUP_READS)("preserves native permission failure for %s", async (name) => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    const args: CatalogJsonObject = name === "jira.link-type" ? { linkTypeId: "10000" } : {};
    expect((await read(name, args, request)).data.reason).toBe("permission-denied");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not expose preference, version or component writes through the read guard", () => {
    expect(isJiraResourceLookupRead("jira.link-type")).toBe(true);
    expect(isJiraResourceLookupRead("jira.update-accessibility-settings")).toBe(false);
    expect(isJiraResourceLookupRead("jira.create-version")).toBe(false);
  });
});
