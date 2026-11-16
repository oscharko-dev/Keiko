import { expect, it, vi } from "vitest";
import { ATLASSIAN_JQL_MAX_CHARS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraSearchPostRead as read,
  isJiraSearchPostRead,
} from "./jira-managed-search-post.js";

const BASE = "https://jira.example.invalid/context";
function nativeIssue(id: string, key: string): Record<string, unknown> {
  return {
    id,
    key,
    self: "https://untrusted.invalid/never-follow",
    fields: {
      summary: `Issue ${key}`,
      status: { id: "1", name: "Open" },
      customfield_10000: 0,
    },
  };
}
it("uses one native POST read and preserves the exact query, selected fields and next unreturned offset", async () => {
  const jql = 'project = "Q & A" ORDER BY key';
  const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      startAt: 40,
      maxResults: 2,
      total: 43,
      issues: [nativeIssue("10001", "SYN-1"), nativeIssue("10002", "SYN-2")],
      names: { customfield_10000: "Estimate" },
      schema: {
        customfield_10000: {
          type: "number",
          custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
        },
      },
    },
  });
  const result = await read(
    { jql, startAt: 40, maxResults: 2, fields: ["customfield_10000"] },
    request,
    BASE,
  );
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    "search",
    "POST",
    {
      jql,
      startAt: 40,
      maxResults: 2,
      validateQuery: true,
      fields: [
        "summary",
        "status",
        "issuetype",
        "project",
        "assignee",
        "priority",
        "labels",
        "created",
        "updated",
        "customfield_10000",
      ],
      expand: ["names", "schema"],
    },
    "json",
  );
  expect(result.data).toMatchObject({
    outcome: "succeeded",
    startAt: 40,
    total: 43,
    nextStartAt: 42,
    items: [
      {
        key: "SYN-1",
        browseUrl: `${BASE}/browse/SYN-1`,
        fieldValues: [{ id: "customfield_10000", number: 0 }],
      },
      { key: "SYN-2", browseUrl: `${BASE}/browse/SYN-2` },
    ],
  });
  expect(result.data).not.toHaveProperty("receipt");
  expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
});
it("steers a native POST search that asks for field values across more issues than one page", async () => {
  const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      startAt: 0,
      maxResults: 1,
      total: 90,
      issues: [nativeIssue("10001", "SYN-1")],
      names: { customfield_10000: "Estimate" },
      schema: { customfield_10000: { type: "number", custom: "x:float" } },
    },
  });
  const steered = await read(
    { jql: "project = SYN", fields: ["customfield_10000"] },
    request,
    BASE,
  );
  expect(steered.data.guidance).toEqual(expect.stringContaining("90"));
  const plain = await read({ jql: "project = SYN" }, request, BASE);
  expect(plain.data).not.toHaveProperty("guidance");
});
it("returns native query diagnostics without attempting another method or disabling validation", async () => {
  const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
    ok: false,
    reason: "field-validation",
    remote: { messages: ["The selected JQL is invalid."] },
  });
  expect((await read({ jql: "invalid JQL" }, request, BASE)).data).toMatchObject({
    outcome: "failed",
    reason: "field-validation",
    messages: ["The selected JQL is invalid."],
  });
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([
  {},
  { jql: "" },
  { jql: "x".repeat(ATLASSIAN_JQL_MAX_CHARS + 1) },
  { jql: "project = SYN", validateQuery: false },
  { jql: "project = SYN", url: BASE },
  { jql: "project = SYN", fields: ["summary", "summary"] },
  { jql: "project = SYN", fields: ["*all"] },
  { jql: "project = SYN", startAt: -1 },
] satisfies readonly CatalogJsonObject[])(
  "refuses unsupported search arguments before any request: %j",
  async (args) => {
    const request = vi.fn<JiraMutationRequest>();
    expect((await read(args, request, BASE)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  },
);
it("keeps a missing native total unknown and does not turn malformed success into an empty search", async () => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: true, status: 200, body: { startAt: 0, maxResults: 25, issues: [] } });
  const result = await read({ jql: "project = SYN" }, request, BASE);
  expect(result.data.outcome).toBe("succeeded");
  expect(result.data).not.toHaveProperty("total");
  request.mockResolvedValue({ ok: true, status: 204, body: undefined });
  expect((await read({ jql: "project = SYN" }, request, BASE)).data.reason).toBe(
    "malformed-payload",
  );
  expect(isJiraSearchPostRead("jira.search-post")).toBe(true);
  expect(isJiraSearchPostRead("jira.raw-post")).toBe(false);
});
