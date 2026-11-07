import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraFieldDirectoryRead, isJiraFieldDirectoryRead } from "./jira-managed-field-directory.js";
const FIELD = { id: "customfield_10001", name: "Category", custom: true, orderable: true, navigable: false, searchable: true, clauseNames: ["Category", "cf[10001]"], schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select", customId: 10001 } };
function fields(items: readonly unknown[]): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body: undefined, items });
}
function option(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
describe("native field and custom option observations", () => {
  it("keeps field flags/schema facts separate from editable/required metadata", async () => {
    const request = fields([{ ...FIELD, required: true, hasDefaultValue: true, operations: ["set"] }]);
    const result = await executeJiraFieldDirectoryRead("jira.fields", {}, request);
    expect(result.data).toEqual({ outcome: "succeeded", items: [{ ...FIELD, schema: { ...FIELD.schema, customId: "10001" } }], startAt: 0, total: 1 });
    expect(request).toHaveBeenCalledExactlyOnceWith("field", "GET", undefined, "json-array");
  });
  it("preserves missing flags/schema rather than manufacturing mutation admission", async () => {
    const result = await executeJiraFieldDirectoryRead("jira.fields", {}, fields([{ id: "summary", name: "Summary", custom: null, schema: null }]));
    expect(result.data.items).toEqual([{ id: "summary", name: "Summary" }]);
  });
  it("pages the validated native field array locally", async () => {
    const request = fields([{ id: "summary", name: "Summary" }, FIELD]);
    const result = await executeJiraFieldDirectoryRead("jira.fields", { startAt: 1, maxResults: 1 }, request);
    expect(result.data).toMatchObject({ startAt: 1, total: 2, items: [{ id: FIELD.id }] });
    expect(request.mock.calls[0]?.[0]).toBe("field");
  });
  it("retains exact custom IDs and explicit empty schema/clause collections", async () => {
    const result = await executeJiraFieldDirectoryRead("jira.fields", {}, fields([{ id: "summary", name: "Summary", schema: {}, clauseNames: [] }, { ...FIELD, schema: { customId: "9223372036854775807" } }]));
    expect(result.data.items).toEqual([{ id: "summary", name: "Summary", schema: {}, clauseNames: [] }, { ...FIELD, schema: { customId: "9223372036854775807" } }]);
  });
  it("reads an exact custom option including zero-length native value and observed disabled=false", async () => {
    const request = option({ id: 3, value: "", disabled: false, childrenIds: [4, "9223372036854775807"], self: "https://untrusted.invalid/option" });
    const result = await executeJiraFieldDirectoryRead("jira.custom-field-option", { optionId: "3" }, request);
    expect(result.data).toEqual({ outcome: "succeeded", id: "3", value: "", disabled: false, childrenIds: ["4", "9223372036854775807"] });
    expect(request).toHaveBeenCalledExactlyOnceWith("customFieldOption/3", "GET", undefined, "json");
  });
  it("keeps missing disabled/children fields unknown", async () => {
    expect((await executeJiraFieldDirectoryRead("jira.custom-field-option", { optionId: "3" }, option({ id: 3, value: "Blue", disabled: null, childrenIds: null }))).data).toEqual({ outcome: "succeeded", id: "3", value: "Blue" });
  });
  it.each([
    { ...FIELD, custom: "true" },
    { ...FIELD, schema: { customId: Number.MAX_SAFE_INTEGER + 1 } },
    { ...FIELD, clauseNames: ["Category", "Category"] },
    { ...FIELD, schema: { type: false } },
    { ...FIELD, id: "../field" },
  ])("refuses malformed native field facts %j", async (value) => {
    expect((await executeJiraFieldDirectoryRead("jira.fields", {}, fields([value]))).data.reason).toBe("malformed-payload");
  });
  it.each([
    { id: 4, value: "Wrong identity" },
    { id: 3, value: "Blue", disabled: "false" },
    { id: 3, value: "Blue", childrenIds: [4, 4] },
    { id: 3, value: "Blue", childrenIds: [Number.MAX_SAFE_INTEGER + 1] },
    { id: 3, value: false },
  ])("refuses malformed or mismatched native option %j", async (value) => {
    expect((await executeJiraFieldDirectoryRead("jira.custom-field-option", { optionId: "3" }, option(value))).data.reason).toBe("malformed-payload");
  });
  it("classifies oversized field/child collections as budget refusals", async () => {
    const values = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({ id: `customfield_${index + 1}`, name: `Field ${index}` }));
    expect((await executeJiraFieldDirectoryRead("jira.fields", {}, fields(values))).data.reason).toBe("bounds-exceeded");
    const childrenIds = values.map((_, index) => index + 1);
    expect((await executeJiraFieldDirectoryRead("jira.custom-field-option", { optionId: "3" }, option({ id: 3, value: "Blue", childrenIds }))).data.reason).toBe("bounds-exceeded");
  });
  it("enforces projected option value byte limits", async () => {
    expect((await executeJiraFieldDirectoryRead("jira.custom-field-option", { optionId: "3" }, option({ id: 3, value: "界".repeat(30000) }))).data.reason).toBe("bounds-exceeded");
  });
  it.each([
    ["jira.fields", { expand: "all" }], ["jira.fields", { maxResults: 101 }],
    ["jira.custom-field-option", { optionId: "03" }], ["jira.custom-field-option", { optionId: "3", maxResults: 1 }],
  ] as const)("refuses unsupported %s selectors before transport", async (name, args) => {
    const request = fields([]);
    expect((await executeJiraFieldDirectoryRead(name, args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it("retains native not-found/visibility refusal instead of reading another option", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason: "not-found", httpStatus: 404 });
    expect((await executeJiraFieldDirectoryRead("jira.custom-field-option", { optionId: "3" }, request)).data.reason).toBe("not-found");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not conflate this global field directory with create/edit metadata", () => {
    expect(isJiraFieldDirectoryRead("jira.fields")).toBe(true);
    expect(isJiraFieldDirectoryRead("jira.create-fields")).toBe(false);
    expect(isJiraFieldDirectoryRead("jira.edit-fields")).toBe(false);
  });
});
