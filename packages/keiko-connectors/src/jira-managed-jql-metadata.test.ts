import { expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  executeJiraJqlMetadataRead as read,
  isJiraJqlMetadataRead,
} from "./jira-managed-jql-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

function request(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
const METADATA = {
  visibleFieldNames: [
    {
      value: "assignee",
      displayName: "<b>Assignee</b>",
      auto: "true",
      searchable: "false",
      orderable: true,
      operators: ["=", "was in"],
      types: ["User"],
    },
    { value: "cf[10000]", cfid: "cf[10000]", operators: [], types: [] },
  ],
  visibleFunctionNames: [
    { value: "currentUser()", types: ["User"], displayName: "Current user", arbitrary: "private" },
  ],
  jqlReservedWords: ["empty", "and"],
};
it("projects actual field DTOs and normalizes only explicit native boolean flags", async () => {
  const port = request(METADATA);
  expect((await read("jira.jql-autocomplete", { category: "fields" }, port)).data).toEqual({
    outcome: "succeeded",
    category: "fields",
    metadataScope: "visible-fields",
    startAt: 0,
    total: 2,
    items: [
      {
        value: "assignee",
        auto: true,
        searchable: false,
        orderable: true,
        operators: ["=", "was in"],
        types: ["User"],
      },
      { value: "cf[10000]", cfid: "cf[10000]", operators: [], types: [] },
    ],
  });
  expect(port).toHaveBeenCalledExactlyOnceWith("jql/autocompletedata", "GET", undefined, "json");
});
it("pages the selected visible collection locally without inventing server query parameters", async () => {
  const port = request(METADATA);
  const result = await read(
    "jira.jql-autocomplete",
    { category: "fields", startAt: 1, maxResults: 1 },
    port,
  );
  expect(result.data).toMatchObject({ startAt: 1, total: 2, items: [{ value: "cf[10000]" }] });
  expect(result.data).not.toHaveProperty("nextStartAt");
  expect(port).toHaveBeenCalledExactlyOnceWith("jql/autocompletedata", "GET", undefined, "json");
});
it.each([
  ["functions", "visible-functions", [{ value: "currentUser()", types: ["User"] }]],
  ["reserved-words", "reserved-words", [{ value: "empty" }, { value: "and" }]],
] as const)("keeps %s separate from unrelated metadata", async (category, metadataScope, items) => {
  expect((await read("jira.jql-autocomplete", { category }, request(METADATA))).data).toEqual({
    outcome: "succeeded",
    category,
    metadataScope,
    startAt: 0,
    total: items.length,
    items,
  });
});
it("retains actual suggestion values without native highlighting HTML or remote links", async () => {
  const port = request({
    results: [
      {
        value: "Atlassian Connect",
        displayName: "<b>AC</b> Connect",
        self: "https://untrusted.invalid",
      },
    ],
  });
  expect(
    (await read("jira.jql-suggestions", { fieldName: "project", fieldValue: "AC" }, port)).data,
  ).toEqual({
    outcome: "succeeded",
    category: "suggestions",
    metadataScope: "native-suggestions",
    fieldName: "project",
    fieldValue: "AC",
    startAt: 0,
    total: 1,
    items: [{ value: "Atlassian Connect" }],
  });
  expect(port).toHaveBeenCalledExactlyOnceWith(
    "jql/autocompletedata/suggestions?fieldName=project&fieldValue=AC",
    "GET",
    undefined,
    "json",
  );
});
it("encodes predicates and prefixes as native query values without treating them as a JQL query", async () => {
  const port = request({ results: [] });
  const result = await read(
    "jira.jql-suggestions",
    {
      fieldName: "project & team",
      fieldValue: '"Ac"',
      predicateName: "from",
      predicateValue: "Old & new",
      startAt: 0,
      maxResults: 1,
    },
    port,
  );
  expect(result.data).toMatchObject({
    fieldName: "project & team",
    predicateName: "from",
    predicateValue: "Old & new",
    total: 0,
    items: [],
  });
  expect(port).toHaveBeenCalledExactlyOnceWith(
    "jql/autocompletedata/suggestions?fieldName=project+%26+team&fieldValue=%22Ac%22&predicateName=from&predicateValue=Old+%26+new",
    "GET",
    undefined,
    "json",
  );
});
it("uses an explicit empty prefix when none was supplied", async () => {
  const port = request({ results: [] });
  expect((await read("jira.jql-suggestions", { fieldName: "status" }, port)).data.fieldValue).toBe(
    "",
  );
  expect(port.mock.calls[0]?.[0]).toBe(
    "jql/autocompletedata/suggestions?fieldName=status&fieldValue=",
  );
});
it("does not confuse a missing requested collection with an observed empty one", async () => {
  expect(
    (
      await read(
        "jira.jql-autocomplete",
        { category: "fields" },
        request({ visibleFunctionNames: [] }),
      )
    ).data.reason,
  ).toBe("malformed-payload");
  expect(
    (
      await read(
        "jira.jql-autocomplete",
        { category: "fields" },
        request({ visibleFieldNames: [] }),
      )
    ).data,
  ).toMatchObject({ items: [], total: 0 });
});
it.each([
  { visibleFieldNames: ['{"value":"assignee"}'] },
  { visibleFieldNames: [{ value: "assignee", auto: "yes" }] },
  { visibleFieldNames: [{ value: "assignee", types: "User" }] },
  { visibleFieldNames: [{ value: "assignee", operators: [7] }] },
  { visibleFieldNames: [{ value: "assignee", cfid: 10000 }] },
])(
  "refuses malformed field autocomplete data without evaluating serialized objects: %#",
  async (body) => {
    expect(
      (await read("jira.jql-autocomplete", { category: "fields" }, request(body))).data.reason,
    ).toBe("malformed-payload");
  },
);
it("refuses an oversized native collection rather than returning a deceptively complete prefix", async () => {
  const results = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
    value: `Value ${index}`,
  }));
  expect(
    (await read("jira.jql-suggestions", { fieldName: "project" }, request({ results }))).data
      .reason,
  ).toBe("bounds-exceeded");
});
const INVALID: readonly [Parameters<typeof read>[0], CatalogJsonObject][] = [
  ["jira.jql-autocomplete", {}],
  ["jira.jql-autocomplete", { category: "constructor" }],
  ["jira.jql-autocomplete", { category: "fields", url: "https://untrusted.invalid" }],
  ["jira.jql-autocomplete", { category: "fields", maxResults: 101 }],
  ["jira.jql-suggestions", { fieldName: "" }],
  ["jira.jql-suggestions", { fieldName: "project", predicateName: "unsupported" }],
  ["jira.jql-suggestions", { fieldName: "project", predicateValue: "unscoped" }],
  ["jira.jql-suggestions", { fieldName: "project", jql: "project=Other" }],
  ["jira.jql-suggestions", { fieldName: "project", fieldValue: null }],
];
it.each(INVALID)("refuses unsupported %s selections before transport", async (name, args) => {
  const port = request({});
  expect((await read(name, args, port)).data.reason).toBe("invalid-input");
  expect(port).not.toHaveBeenCalled();
});
it.each([
  ["jira.jql-autocomplete", { category: "fields" }],
  ["jira.jql-suggestions", { fieldName: "project" }],
] as const)(
  "preserves native permission refusal for %s without querying issues",
  async (name, args) => {
    const port = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await read(name, args, port)).data.reason).toBe("permission-denied");
    expect(port).toHaveBeenCalledTimes(1);
  },
);
it("recognizes only the two fixed metadata identities", () => {
  expect(isJiraJqlMetadataRead("jira.jql-suggestions")).toBe(true);
  expect(isJiraJqlMetadataRead("jira.search")).toBe(false);
});
