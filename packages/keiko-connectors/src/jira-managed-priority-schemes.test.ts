import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraPrioritySchemeRead, isJiraPrioritySchemeRead } from "./jira-managed-priority-schemes.js";
const SCHEME = { id: 7, name: "Delivery", description: "", defaultScheme: false, defaultOptionId: "2", optionIds: ["1", "2"] };
function requestFor(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
describe("global native priority scheme configuration", () => {
  it("preserves the native schemes/total envelope and requests only published page coordinates", async () => {
    const request = requestFor({ schemes: [SCHEME], startAt: 2, maxResults: 1, total: 4 });
    const result = await executeJiraPrioritySchemeRead("jira.priority-schemes", { startAt: 2, maxResults: 1 }, request);
    expect(result.data).toEqual({ outcome: "succeeded", items: [{ ...SCHEME, id: "7" }], startAt: 2, total: 4, nextStartAt: 3 });
    expect(request).toHaveBeenCalledExactlyOnceWith("priorityschemes?startAt=2&maxResults=1", "GET", undefined, "json");
  });
  it("reads one exact scheme without expanding project associations", async () => {
    const request = requestFor({ ...SCHEME, projectKeys: ["OTHER"], self: "https://untrusted.invalid/scheme" });
    const result = await executeJiraPrioritySchemeRead("jira.priority-scheme", { schemeId: "7" }, request);
    expect(result.data).toEqual({ outcome: "succeeded", ...SCHEME, id: "7" });
    expect(request).toHaveBeenCalledExactlyOnceWith("priorityschemes/7", "GET", undefined, "json");
  });
  it("preserves unknown defaults/options rather than empty or false values", async () => {
    const result = await executeJiraPrioritySchemeRead("jira.priority-scheme", { schemeId: "7" }, requestFor({ id: 7, name: "Delivery", defaultScheme: null, optionIds: null }));
    expect(result.data).toEqual({ outcome: "succeeded", id: "7", name: "Delivery" });
  });
  it("retains a native empty terminal page", async () => {
    const result = await executeJiraPrioritySchemeRead("jira.priority-schemes", {}, requestFor({ schemes: [], startAt: 0, maxResults: 25, total: 0 }));
    expect(result.data).toEqual({ outcome: "succeeded", items: [], startAt: 0, total: 0 });
  });
  it.each([
    { schemes: [SCHEME], startAt: 1, maxResults: 25, total: 1 },
    { schemes: [], startAt: 0, maxResults: 25, total: 1 },
    { schemes: [SCHEME], startAt: 0, maxResults: 25 },
    { schemes: [SCHEME], startAt: 0, maxResults: 25, total: null },
    { schemes: [SCHEME], startAt: 0, maxResults: 25, total: "1" },
    { schemes: [SCHEME], startAt: 0, maxResults: 25, total: -1 },
    { schemes: [SCHEME], startAt: 0, maxResults: 25, total: 1_000_001 },
    { schemes: [SCHEME, SCHEME], startAt: 0, maxResults: 25, total: 2 },
  ])("refuses malformed or contradictory native pages %j", async (body) => {
    expect((await executeJiraPrioritySchemeRead("jira.priority-schemes", {}, requestFor(body))).data.reason).toBe("malformed-payload");
  });
  it.each([
    { ...SCHEME, id: 8 }, { ...SCHEME, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...SCHEME, optionIds: ["1", "1"] }, { ...SCHEME, defaultScheme: "false" },
  ])("refuses malformed or mismatched native scheme %j", async (body) => {
    expect((await executeJiraPrioritySchemeRead("jira.priority-scheme", { schemeId: "7" }, requestFor(body))).data.reason).toBe("malformed-payload");
  });
  it("classifies nested option overflow as bounds-exceeded", async () => {
    const optionIds = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => String(index + 1));
    expect((await executeJiraPrioritySchemeRead("jira.priority-scheme", { schemeId: "7" }, requestFor({ ...SCHEME, optionIds }))).data.reason).toBe("bounds-exceeded");
  });
  it.each([
    { expand: "schemes.projectKeys" }, { maxResults: 101 }, { startAt: null }, { schemeId: "7" },
  ] satisfies readonly CatalogJsonObject[])("refuses undeclared list selectors %j", async (args) => {
    const request = requestFor({});
    expect((await executeJiraPrioritySchemeRead("jira.priority-schemes", args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it("retains native permission failure and never tries a project-associated endpoint", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await executeJiraPrioritySchemeRead("jira.priority-scheme", { schemeId: "7" }, request)).data.reason).toBe("permission-denied");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("exposes only the two declared native read names", () => {
    expect(isJiraPrioritySchemeRead("jira.priority-scheme")).toBe(true);
    expect(isJiraPrioritySchemeRead("jira.priority-schemes")).toBe(true);
    expect(isJiraPrioritySchemeRead("jira.project-priority-scheme")).toBe(false);
  });
});
