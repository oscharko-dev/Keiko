import { expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraWorklogsByIdRead as read } from "./jira-managed-worklogs-by-id.js";

const WORKLOG = {
  id: "7",
  issueId: "10001",
  timeSpentSeconds: 0,
  comment: "",
  author: {
    name: "reviewed-user",
    displayName: "Reviewed User",
    emailAddress: "never@example.invalid",
  },
  self: "https://untrusted.invalid/worklog/7",
};
function port(items: readonly Record<string, unknown>[]) {
  return vi.fn<JiraMutationRequest>(async (path, method) => {
    if (path === "worklog/list" && method === "POST")
      return { ok: true, status: 200, body: undefined, items };
    if (path === "issue/10001?fields=summary")
      return {
        ok: true,
        status: 200,
        body: { id: "10001", key: "SYN-1", fields: { summary: "Issue" } },
      };
    throw new TypeError("Unexpected requested worklog route");
  });
}
it("reads only selected visible IDs, preserves zero/empty values and independently binds each returned parent", async () => {
  const request = port([WORKLOG]);
  const result = await read({ worklogIds: ["7", "8"] }, request);
  expect(request).toHaveBeenNthCalledWith(1, "worklog/list", "POST", { ids: [7, 8] }, "json-array");
  expect(request).toHaveBeenNthCalledWith(2, "issue/10001?fields=summary");
  expect(result.data).toEqual({
    outcome: "succeeded",
    selectionScope: "native-visible-requested-worklogs",
    requestedCount: 2,
    returnedCount: 1,
    unreturnedWorklogIds: ["8"],
    items: [
      {
        id: "7",
        issueKey: "SYN-1",
        timeSpentSeconds: 0,
        comment: "",
        authorName: "reviewed-user",
        authorDisplayName: "Reviewed User",
      },
    ],
  });
  expect(result.data).not.toHaveProperty("total");
  expect(JSON.stringify(result)).not.toMatch(/untrusted\.invalid|never@example/iu);
});
it("labels a fully omitted selection without claiming absence, project totals or zero effort", async () => {
  const request = port([]);
  expect((await read({ worklogIds: ["7", "8"] }, request)).data).toEqual({
    outcome: "succeeded",
    selectionScope: "native-visible-requested-worklogs",
    requestedCount: 2,
    returnedCount: 0,
    unreturnedWorklogIds: ["7", "8"],
    items: [],
  });
  expect(request).toHaveBeenCalledTimes(1);
});
it("uses exact native numeric request IDs and binds a repeated parent once per read", async () => {
  const request = port([WORKLOG, { ...WORKLOG, id: "9007199254740991", timeSpentSeconds: 60 }]);
  const result = await read({ worklogIds: ["7", "9007199254740991"] }, request);
  expect(result.data.returnedCount).toBe(2);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenNthCalledWith(
    1,
    "worklog/list",
    "POST",
    { ids: [7, Number.MAX_SAFE_INTEGER] },
    "json-array",
  );
});
it.each([
  {},
  { worklogIds: [] },
  { worklogIds: [7] },
  { worklogIds: ["07"] },
  { worklogIds: ["7", "7"] },
  { worklogIds: ["9007199254740992"] },
  { worklogIds: ["7"], startAt: 0 },
  { worklogIds: ["7"], url: "https://untrusted.invalid" },
  {
    worklogIds: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) =>
      String(index + 1),
    ),
  },
] satisfies readonly CatalogJsonObject[])(
  "refuses invalid or inexact selections before transport: %j",
  async (args) => {
    const request = port([]);
    expect((await read(args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  },
);
it.each([
  { items: [{ ...WORKLOG, id: "9" }] },
  { items: [WORKLOG, WORKLOG] },
  { items: [{ ...WORKLOG, timeSpentSeconds: -1 }] },
  { items: [{ ...WORKLOG, timeSpentSeconds: Number.MAX_SAFE_INTEGER + 1 }] },
])("refuses inconsistent returned rows without delivering a prefix: $items", async ({ items }) => {
  const result = await read({ worklogIds: ["7", "8"] }, port(items));
  expect(result.isError).toBe(true);
  expect(result.data).not.toHaveProperty("items");
});
it("does not expose orphaned worklogs after parent access or identity changes", async () => {
  const request = port([WORKLOG]);
  request.mockImplementation(async (path) =>
    path === "worklog/list"
      ? { ok: true, status: 200, body: undefined, items: [WORKLOG] }
      : { ok: false, reason: "permission-denied" },
  );
  const result = await read({ worklogIds: ["7"] }, request);
  expect(result.data.reason).toBe("permission-denied");
  expect(result.data).not.toHaveProperty("items");
  expect(request).toHaveBeenCalledTimes(2);
});
it("refuses an oversized complete selection instead of dropping rows and misreporting counts", async () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    ...WORKLOG,
    id: String(index + 1),
    comment: "x".repeat(32768),
  }));
  const result = await read({ worklogIds: rows.map(({ id }) => id) }, port(rows));
  expect(result.data.reason).toBe("bounds-exceeded");
  expect(result.data).not.toHaveProperty("items");
  expect(result.data).not.toHaveProperty("returnedCount");
});
