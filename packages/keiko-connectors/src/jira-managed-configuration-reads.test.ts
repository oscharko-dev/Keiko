import { describe, expect, it, vi, type Mock } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { asRecord } from "./atlassian-sync-classify.js";
import {
  executeJiraConfigurationRead,
  isJiraConfigurationRead,
} from "./jira-managed-configuration-reads.js";

type Operation = Parameters<typeof executeJiraConfigurationRead>[0];
function fixture(
  body: Record<string, unknown> | readonly unknown[],
  status = 200,
): {
  readonly request: Mock<JiraMutationRequest>;
  readonly read: (
    name: Operation,
    args?: CatalogJsonObject,
  ) => ReturnType<typeof executeJiraConfigurationRead>;
} {
  const request = vi.fn<JiraMutationRequest>(() =>
    Promise.resolve({
      ok: true,
      status,
      body: asRecord(body),
      ...(Array.isArray(body) ? { items: body } : {}),
    }),
  );
  return {
    request,
    read: (name: Operation, args: CatalogJsonObject = {}) =>
      executeJiraConfigurationRead(name, args, request),
  };
}
const SCREEN = { id: 7, name: "Main", description: "", deletable: false };
const FIELD = {
  id: "customfield_10000",
  numericId: 10000,
  name: "Risk",
  isLocked: false,
  isManaged: true,
  projectsCount: 0,
};
const OPTION = { id: 3, value: "", disabled: false, childrenIds: [4, "9223372036854775807"] };
const TERM = {
  originalName: "Epic",
  originalNamePlural: "Epics",
  newName: "Theme",
  newNamePlural: "Themes",
  isDefault: false,
};

describe("closed native configuration reads", () => {
  it("reads a native screen page without the documented copy/paste write response", async () => {
    const f = fixture({ startAt: 0, maxResults: 25, total: 1, screens: [SCREEN] });
    expect((await f.read("jira.screens", { search: "Main" })).data).toEqual({
      outcome: "succeeded",
      items: [{ ...SCREEN, id: "7" }],
      startAt: 0,
      total: 1,
    });
    expect(f.request).toHaveBeenCalledWith(
      "screens?startAt=0&maxResults=25&search=Main",
      "GET",
      undefined,
      "json",
    );
  });
  it("does not accept 201 as evidence of a screen read", async () => {
    const f = fixture({}, 201);
    expect((await f.read("jira.screens")).data).toMatchObject({ reason: "malformed-payload" });
  });
  it.each([undefined, null])(
    "retains an unknown screen total %s without invented continuation",
    async (total) => {
      const f = fixture({
        startAt: 0,
        maxResults: 25,
        ...(total === undefined ? {} : { total }),
        screens: [SCREEN],
      });
      const result = await f.read("jira.screens");
      expect(result.data).not.toHaveProperty("total");
      expect(result.data).not.toHaveProperty("nextStartAt");
      expect(result.data).toMatchObject({ items: [{ id: "7" }] });
    },
  );
  it("uses observed screen totals to continue the native offset", async () => {
    const f = fixture({ startAt: 0, maxResults: 1, total: 2, screens: [SCREEN] });
    expect((await f.read("jira.screens", { maxResults: 1 })).data).toMatchObject({
      nextStartAt: 1,
      total: 2,
    });
  });
  it("reads unpaged workflows with local paging and literal modification dates", async () => {
    const f = fixture([
      {
        name: "Delivery",
        description: "",
        steps: 0,
        isDefault: false,
        lastModifiedDate: "Yesterday",
        lastModifiedUser: "person",
        diagram: "untrusted",
      },
    ]);
    const result = await f.read("jira.workflows");
    expect(f.request).toHaveBeenCalledWith("workflow", "GET", undefined, "json-array");
    expect(result.data).toMatchObject({
      items: [{ name: "Delivery", steps: 0, isDefault: false, lastModifiedDate: "Yesterday" }],
      total: 1,
    });
    expect(JSON.stringify(result)).not.toContain("person");
    expect(JSON.stringify(result)).not.toContain("untrusted");
  });
  it("binds the exact named workflow and uses the object response", async () => {
    const f = fixture({ name: "Delivery", isDefault: true });
    expect((await f.read("jira.workflows", { workflowName: "Delivery" })).data).toMatchObject({
      items: [{ name: "Delivery" }],
      total: 1,
    });
    expect(f.request).toHaveBeenCalledWith(
      "workflow?workflowName=Delivery",
      "GET",
      undefined,
      "json",
    );
  });
  it("refuses a mismatched named workflow", async () => {
    const f = fixture({ name: "Unrelated" });
    expect((await f.read("jira.workflows", { workflowName: "Delivery" })).isError).toBe(true);
  });
  it("preserves custom field facts without inferring admission", async () => {
    const f = fixture({
      startAt: 0,
      maxResults: 25,
      isLast: true,
      total: 1,
      values: [
        {
          ...FIELD,
          projectIds: [1, "9223372036854775807"],
          issueTypeIds: ["3"],
          issuesWithValue: 0,
          type: "vendor:field",
          searcherKey: "vendor:searcher",
          self: "https://untrusted.invalid/",
        },
      ],
    });
    const result = await f.read("jira.custom-fields", { search: "Risk" });
    expect(f.request).toHaveBeenCalledWith(
      "customFields?startAt=0&maxResults=25&search=Risk",
      "GET",
      undefined,
      "json",
    );
    expect(result.data).toMatchObject({
      items: [
        {
          ...FIELD,
          numericId: "10000",
          projectIds: ["1", "9223372036854775807"],
          isLocked: false,
          issuesWithValue: 0,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
    expect(JSON.stringify(result)).not.toContain("editable");
  });
  it.each(["10000", "customfield_10000"])(
    "retains observed custom field ID spelling %s",
    async (id) => {
      const f = fixture({
        startAt: 0,
        maxResults: 25,
        isLast: true,
        values: [{ id, name: "Risk", isLocked: null }],
      });
      expect((await f.read("jira.custom-fields")).data).toMatchObject({
        items: [{ id, name: "Risk" }],
      });
    },
  );
  it("reads Jira 10.3's numeric last value update as its exact UTC instant", async () => {
    // Jira Data Center 10.3.26 reports the instant as epoch milliseconds once a value changed.
    const read = (lastValueUpdate: unknown): ReturnType<typeof executeJiraConfigurationRead> =>
      fixture({
        startAt: 0,
        maxResults: 25,
        isLast: true,
        total: 1,
        values: [{ ...FIELD, lastValueUpdate }],
      }).read("jira.custom-fields");
    expect((await read(1762675200000)).data).toMatchObject({
      items: [{ id: FIELD.id, lastValueUpdate: "2025-11-09T08:00:00.000Z" }],
    });
    expect((await read("2025-11-09T08:00:00.000+0000")).data).toMatchObject({
      items: [{ id: FIELD.id, lastValueUpdate: "2025-11-09T08:00:00.000+0000" }],
    });
    for (const malformed of [-1, 1.5, 8640000000000001, Number.MAX_SAFE_INTEGER + 1])
      expect((await read(malformed)).isError, String(malformed)).toBe(true);
  });
  it.each([
    { ...FIELD, numericId: 10001 },
    { ...FIELD, numericId: 9007199254740992 },
    { ...FIELD, id: "customfield_01" },
    { ...FIELD, issuesWithValue: -1 },
  ])("refuses inconsistent field identity/count %j", async (value) => {
    const f = fixture({ startAt: 0, maxResults: 25, total: 1, isLast: true, values: [value] });
    expect((await f.read("jira.custom-fields")).isError).toBe(true);
  });
  it("uses native one-based option pages and repeated context IDs", async () => {
    const f = fixture({ options: [OPTION], total: 2 });
    const result = await f.read("jira.custom-field-options", {
      customFieldId: "10000",
      page: 1,
      maxResults: 1,
      query: "",
      projectIds: ["1", "2"],
      issueTypeIds: ["3"],
      sortByOptionName: true,
    });
    expect(f.request).toHaveBeenCalledWith(
      "customFields/10000/options?page=1&maxResults=1&query=&sortByOptionName=true&projectIds=1&projectIds=2&issueTypeIds=3",
      "GET",
      undefined,
      "json",
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      customFieldId: "10000",
      page: 1,
      maxResults: 1,
      total: 2,
      nextPage: 2,
      items: [{ id: "3", value: "", disabled: false, childrenIds: ["4", "9223372036854775807"] }],
      optionsScope: "native-context-options",
    });
    expect(result.data).not.toHaveProperty("startAt");
  });
  it("labels explicit all-context options without inventing project context", async () => {
    const f = fixture({ options: [], total: 0 });
    expect(
      (await f.read("jira.custom-field-options", { customFieldId: "10000", useAllContexts: true }))
        .data,
    ).toMatchObject({ items: [], optionsScope: "all-field-contexts", page: 1, total: 0 });
  });
  it("retains unknown option total without inferred continuation", async () => {
    const f = fixture({ options: [OPTION] });
    const result = await f.read("jira.custom-field-options", { customFieldId: "10000" });
    expect(result.data).not.toHaveProperty("total");
    expect(result.data).not.toHaveProperty("nextPage");
  });
  it("refuses a short nonterminal option page rather than skipping unseen options", async () => {
    const f = fixture({ options: [OPTION], total: 30 });
    expect((await f.read("jira.custom-field-options", { customFieldId: "10000" })).isError).toBe(
      true,
    );
  });
  it("refuses a native continuation beyond the declared page boundary", async () => {
    const f = fixture({ options: [OPTION], total: 10001 });
    expect(
      (
        await f.read("jira.custom-field-options", {
          customFieldId: "10000",
          page: 10000,
          maxResults: 1,
        })
      ).data,
    ).toMatchObject({ reason: "bounds-exceeded" });
  });
  it("does not truncate option pages into an unresumable prefix", async () => {
    const options = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      value: "v".repeat(32768),
    }));
    const f = fixture({ options, total: 10 });
    expect(
      (await f.read("jira.custom-field-options", { customFieldId: "10000" })).data,
    ).toMatchObject({ reason: "bounds-exceeded" });
  });
  it("reads terminology through its documented array response", async () => {
    const f = fixture([TERM]);
    expect((await f.read("jira.terminology")).data).toMatchObject({ items: [TERM], total: 1 });
    expect(f.request).toHaveBeenCalledWith("terminology/entries", "GET", undefined, "json-array");
  });
  it("binds a terminology selector while preserving native capitalization", async () => {
    const f = fixture(TERM);
    expect((await f.read("jira.terminology-entry", { originalName: "epic" })).data).toEqual({
      outcome: "succeeded",
      ...TERM,
    });
  });
  it("refuses an unrelated terminology entry", async () => {
    const f = fixture(TERM);
    expect((await f.read("jira.terminology-entry", { originalName: "sprint" })).isError).toBe(true);
  });
  it("refuses duplicate terminology names even with changed capitalization", async () => {
    const f = fixture([TERM, { ...TERM, originalName: "epic" }]);
    expect((await f.read("jira.terminology")).isError).toBe(true);
  });
  it("observes read-only state without changing authority or interpreting the local time", async () => {
    const f = fixture({
      enabled: false,
      message: "",
      endTime: "2026-06-30T18:00",
      timeZone: "Asia/Beirut",
    });
    expect((await f.read("jira.read-only-mode")).data).toEqual({
      outcome: "succeeded",
      enabled: false,
      message: "",
      endTime: "2026-06-30T18:00",
      timeZone: "Asia/Beirut",
    });
    expect(f.request).toHaveBeenCalledWith("readonly-mode", "GET", undefined, "json");
  });
  it("does not turn missing read-only metadata into disabled or an empty message", async () => {
    const f = fixture({ enabled: null, endTime: null });
    expect((await f.read("jira.read-only-mode")).data).toEqual({ outcome: "succeeded" });
  });
  it.each([
    ["jira.screens", { expand: "all" }],
    ["jira.workflows", { workflowName: "Delivery", startAt: 1 }],
    ["jira.custom-fields", { sortColumn: "unknown" }],
    ["jira.custom-field-options", { customFieldId: "10000", page: 0 }],
    ["jira.custom-field-options", { customFieldId: "customfield_10000" }],
    [
      "jira.custom-field-options",
      { customFieldId: "10000", useAllContexts: true, projectIds: ["1"] },
    ],
    ["jira.custom-field-options", { customFieldId: "10000", projectIds: ["1", "1"] }],
    ["jira.terminology-entry", { originalName: "status" }],
    ["jira.read-only-mode", { enabled: true }],
  ] as const)(
    "refuses undeclared or inconsistent %s selectors before transport",
    async (name, args) => {
      const f = fixture({});
      expect((await f.read(name, args)).data).toMatchObject({ reason: "invalid-input" });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("retains exact permission refusal rather than returning empty metadata", async () => {
    const request = vi.fn<JiraMutationRequest>(() =>
      Promise.resolve({ ok: false, reason: "permission-denied" }),
    );
    expect((await executeJiraConfigurationRead("jira.workflows", {}, request)).data).toMatchObject({
      reason: "permission-denied",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("names oversized nested field contexts as bounds failures", async () => {
    const f = fixture({
      startAt: 0,
      maxResults: 25,
      isLast: true,
      values: [
        {
          ...FIELD,
          projectIds: Array.from(
            { length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 },
            (_, index) => index + 1,
          ),
        },
      ],
    });
    expect((await f.read("jira.custom-fields")).data).toMatchObject({ reason: "bounds-exceeded" });
  });
  it("keeps the seven-read guard closed", () => {
    expect(isJiraConfigurationRead("jira.read-only-mode")).toBe(true);
    expect(isJiraConfigurationRead("jira.enable-read-only-mode")).toBe(false);
  });
});
