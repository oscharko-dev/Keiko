import { describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { executeJiraFilterRead } from "./jira-filter-reads.js";

function fixture(body: unknown): {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly run: (
    name: string,
    args: Parameters<typeof executeJiraFilterRead>[1],
  ) => ReturnType<typeof executeJiraFilterRead>;
} {
  const http = vi.fn<AtlassianHttpBodyPort>(() => {
    const bodyText = JSON.stringify(body);
    return Promise.resolve({
      kind: "response",
      status: 200,
      bodyText,
      bodyBytes: Buffer.byteLength(bodyText),
      truncated: false,
    });
  });
  const context = {
    invocationId: "filter",
    correlationId: "synthetic",
    signal: new AbortController().signal,
    beforeEffect: (): boolean => true,
  };
  return {
    http,
    run: (name, args) =>
      executeJiraFilterRead(name, args, context, {
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http,
      }),
  };
}
const FILTER = {
  id: "42",
  name: "Project backlog",
  jql: "project = APP ORDER BY Rank ASC",
  owner: { key: "actor", name: "actor", emailAddress: "not-projected@example.invalid" },
  sharePermissions: [],
  self: "https://remote.invalid/filter",
};
describe("closed native board-filter prerequisites", () => {
  it.each([null, "", "Reviewed description"])(
    "preserves an observed description value %j for later review",
    async (description) => {
      expect(
        (await fixture({ ...FILTER, description }).run("jira.filter", { filterId: "42" })).data
          .items,
      ).toMatchObject([{ description }]);
    },
  );
  it("refuses malformed description metadata rather than inventing an empty reviewed value", async () => {
    expect(
      (await fixture({ ...FILTER, description: false }).run("jira.filter", { filterId: "42" }))
        .data,
    ).toMatchObject({ outcome: "failed", reason: "malformed-payload" });
  });
  it("reads native JQL and explicit private sharing without upstream links or extra owner fields", async () => {
    const f = fixture(FILTER);
    expect((await f.run("jira.filter", { filterId: "42" })).data).toEqual({
      outcome: "succeeded",
      items: [
        {
          id: "42",
          name: FILTER.name,
          jql: FILTER.jql,
          description: null,
          owner: { key: "actor", name: "actor" },
          shareScope: "private",
          sharePermissionCount: 0,
        },
      ],
    });
    expect(f.http.mock.calls[0]?.[0].url).toBe(
      "https://jira.example.invalid/context/rest/api/2/filter/42",
    );
  });
  it("never interprets missing permissions as private", async () => {
    const { sharePermissions: _omitted, ...body } = FILTER;
    expect((await fixture(body).run("jira.filter", { filterId: "42" })).data.items).toMatchObject([
      { shareScope: "unknown" },
    ]);
  });
  it("locally pages the bounded favourites reply without inventing remote pagination", async () => {
    const f = fixture([FILTER, { ...FILTER, id: "43" }]);
    expect((await f.run("jira.favourite-filters", { maxResults: 1 })).data).toMatchObject({
      startAt: 0,
      total: 2,
      nextStartAt: 1,
    });
    expect(f.http.mock.calls[0]?.[0].url).toBe(
      "https://jira.example.invalid/context/rest/api/2/filter/favourite",
    );
  });
});
