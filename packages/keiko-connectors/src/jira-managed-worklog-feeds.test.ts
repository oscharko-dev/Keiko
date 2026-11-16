import { expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraWorklogFeedRead as read,
  isJiraWorklogFeedRead,
} from "./jira-managed-worklog-feeds.js";

function port(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    since: 0,
    until: 1000,
    isLastPage: false,
    values: [{ worklogId: 7, updatedTime: 1000 }],
    ...overrides,
  };
}
it.each(["deleted", "updated"] as const)(
  "reads exactly one complete native %s page and retains its exact cursor",
  async (kind) => {
    const request = port(
      page({
        self: `http://proxy.invalid/context/rest/api/2/worklog/${kind}?since=0`,
        nextPage: `http://proxy.invalid/context/rest/api/2/worklog/${kind}?since=1000`,
      }),
    );
    const result = await read(`jira.${kind}-worklogs`, {}, request);
    expect(result.data).toEqual({
      outcome: "succeeded",
      changeType: kind,
      feedScope: "native-visible-change-window",
      timeUnit: "unix-milliseconds",
      excludesLatestMinute: true,
      since: "0",
      until: "1000",
      isLastPage: false,
      nextSince: "1000",
      items: [{ worklogId: "7", changedAt: "1000" }],
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `worklog/${kind}?since=0`,
      "GET",
      undefined,
      "json",
    );
    expect(result.data).not.toHaveProperty("total");
    expect(result.data).not.toHaveProperty("nextPage");
  },
);
it("preserves inclusive repeated timestamps without adding one or dropping rows", async () => {
  const request = port(
    page({
      since: 1000,
      until: 2000,
      values: [
        { worklogId: 7, updatedTime: 1000 },
        { worklogId: 8, updatedTime: 2000 },
        { worklogId: 9, updatedTime: 2000 },
      ],
    }),
  );
  const result = await read("jira.updated-worklogs", { since: "1000" }, request);
  expect(result.data.items).toEqual([
    { worklogId: "7", changedAt: "1000" },
    { worklogId: "8", changedAt: "2000" },
    { worklogId: "9", changedAt: "2000" },
  ]);
  expect(result.data.nextSince).toBe("2000");
});
it("keeps an empty terminal native window distinct from all-history completeness", async () => {
  const result = await read(
    "jira.deleted-worklogs",
    {},
    port(page({ until: 0, isLastPage: true, values: [] })),
  );
  expect(result.data).toMatchObject({
    since: "0",
    until: "0",
    isLastPage: true,
    items: [],
    excludesLatestMinute: true,
  });
  expect(result.data).not.toHaveProperty("nextSince");
  expect(result.data).not.toHaveProperty("complete");
});
it("accepts the documented lastPage alias but refuses contradictory final-page flags", async () => {
  expect(
    (await read("jira.updated-worklogs", {}, port(page({ isLastPage: undefined, lastPage: true }))))
      .data.isLastPage,
  ).toBe(true);
  expect(
    (await read("jira.updated-worklogs", {}, port(page({ isLastPage: false, lastPage: true }))))
      .data.reason,
  ).toBe("malformed-payload");
});
it.each([
  {},
  { since: "0" },
  { since: "9223372036854775807" },
] satisfies readonly CatalogJsonObject[])(
  "encodes the selected cursor without numeric coercion: %j",
  async (args) => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: false, reason: "permission-denied" });
    await read("jira.updated-worklogs", args, request);
    expect(request).toHaveBeenCalledWith(
      `worklog/updated?since=${args.since ?? "0"}`,
      "GET",
      undefined,
      "json",
    );
  },
);
it.each([null, 0, -1, "-1", "01", "+1", "1e3", "9223372036854775808"])(
  "refuses invalid cursor %j before transport",
  async (since) => {
    const request = port(page());
    expect((await read("jira.updated-worklogs", { since }, request)).data.reason).toBe(
      "invalid-input",
    );
    expect(request).not.toHaveBeenCalled();
  },
);
it.each([{ maxResults: 10 }, { startAt: 0 }, { nextPage: "https://remote.invalid" }])(
  "does not invent paging inputs: %j",
  async (args) => {
    const request = port(page());
    expect((await read("jira.deleted-worklogs", args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  },
);
it.each([
  "https://remote.invalid/rest/api/2/worklog/deleted?since=1000",
  "https://remote.invalid/rest/api/2/worklog/updated?since=1001",
  "https://remote.invalid/rest/api/2/worklog/updated?since=1000&since=1000",
  "https://remote.invalid/rest/api/2/worklog/updated?since=1000&token=x",
  "https://user:password@remote.invalid/rest/api/2/worklog/updated?since=1000",
  "https://remote.invalid/rest/api/2/worklog/updated?since=1000#other",
])("refuses a contradictory continuation without following it: %s", async (nextPage) => {
  const request = port(page({ nextPage }));
  expect((await read("jira.updated-worklogs", {}, request)).data.reason).toBe("conflict");
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([
  { since: 1 },
  { until: -1 },
  { values: undefined },
  { isLastPage: undefined },
  { values: [{ worklogId: 7, updatedTime: 1001 }] },
  { values: [{ worklogId: "7", updatedTime: 1 }] },
])("refuses inconsistent native window data: %j", async (overrides) => {
  expect((await read("jira.updated-worklogs", {}, port(page(overrides)))).data.reason).toBe(
    "malformed-payload",
  );
});
it("refuses a nonadvancing nonterminal cursor rather than skipping equal-time changes", async () => {
  const request = port(page({ since: 1000, until: 1000 }));
  expect((await read("jira.updated-worklogs", { since: "1000" }, request)).data.reason).toBe(
    "bounds-exceeded",
  );
  expect(request).toHaveBeenCalledTimes(1);
});
it("rejects rounded native int64 values and oversized pages without returning a prefix", async () => {
  for (const overrides of [
    { until: Number.MAX_SAFE_INTEGER + 1 },
    { values: [{ worklogId: Number.MAX_SAFE_INTEGER + 1, updatedTime: 1 }] },
    {
      values: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
        worklogId: index + 1,
        updatedTime: 1,
      })),
    },
  ]) {
    const result = await read("jira.updated-worklogs", {}, port(page(overrides)));
    expect(result.data.reason).toBe("bounds-exceeded");
    expect(result.data).not.toHaveProperty("nextSince");
    expect(result.data).not.toHaveProperty("items");
  }
});
it("keeps ordinary native refusal semantics and closed names", async () => {
  const request = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: false, reason: "auth-failed" });
  expect((await read("jira.deleted-worklogs", {}, request)).data.reason).toBe("auth-failed");
  expect(isJiraWorklogFeedRead("jira.updated-worklogs")).toBe(true);
  expect(isJiraWorklogFeedRead("jira.worklog-list")).toBe(false);
});
