import { describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { executeJiraAgileRead } from "./jira-agile-reads.js";

interface Fixture {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly context: Parameters<typeof executeJiraAgileRead>[2];
  readonly connection: Parameters<typeof executeJiraAgileRead>[3];
}
function fixture(body: unknown): Fixture {
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
    invocationId: "agile-read",
    correlationId: "agile-proof",
    signal: new AbortController().signal,
    beforeEffect: (): boolean => true,
  };
  const connection = {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    http,
  };
  return { http, context, connection };
}

describe("closed Jira Agile reads", () => {
  it.each([undefined, 7])(
    "retains only observed sprint board context (%s)",
    async (originBoardId) => {
      const f = fixture({
        id: 9,
        name: "Sprint one",
        state: "future",
        ...(originBoardId === undefined ? {} : { originBoardId }),
        self: "https://foreign.invalid/sprint",
        boardBrowseUrl: "https://foreign.invalid/board",
      });
      const result = await executeJiraAgileRead(
        "jira.sprint",
        { sprintId: "9" },
        f.context,
        f.connection,
      );
      expect(result.data).toMatchObject({ outcome: "succeeded", items: [{ id: "9" }] });
      expect(JSON.stringify(result)).not.toContain("foreign.invalid");
      if (originBoardId === undefined)
        expect(JSON.stringify(result)).not.toContain("boardBrowseUrl");
      else
        expect(result.data).toMatchObject({
          items: [
            {
              originBoardId: "7",
              boardBrowseUrl:
                "https://jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=7",
            },
          ],
        });
    },
  );
  it.each([
    [
      "jira.board",
      { boardId: "7" },
      { id: 7, name: "Team", type: "scrum" },
      "secure/RapidBoard.jspa?rapidView=7",
    ],
    [
      "jira.board-configuration",
      { boardId: "7" },
      { id: 7, name: "Team", type: "scrum", filter: { id: "42" }, columnConfig: { columns: [] } },
      "secure/RapidBoard.jspa?rapidView=7",
    ],
    [
      "jira.epic",
      { epicIdOrKey: "SYN-11" },
      { id: 11, key: "SYN-11", name: "Delivery", summary: "Delivery epic", done: false },
      "browse/SYN-11",
    ],
  ] as const)(
    "mints %s links only from the bound instance and context path",
    async (operation, args, entity, suffix) => {
      const f = fixture({
        ...entity,
        self: "https://untrusted.invalid/",
        browseUrl: "https://untrusted.invalid/",
      });
      const result = await executeJiraAgileRead(operation, args, f.context, f.connection);
      expect(result.data).toMatchObject({
        outcome: "succeeded",
        items: [{ browseUrl: `https://jira.example.invalid/context/${suffix}` }],
      });
      expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
    },
  );
  it("reads a board page through its fixed Agile root, normalizing IDs and retaining the next page", async () => {
    const f = fixture({
      startAt: 0,
      maxResults: 2,
      isLast: false,
      total: 3,
      values: [
        { id: 7, name: "Team", type: "scrum", self: "https://untrusted.invalid/" },
        { id: 8, name: "Delivery", type: "kanban" },
      ],
    });
    const result = await executeJiraAgileRead(
      "jira.boards",
      { maxResults: 2 },
      f.context,
      f.connection,
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      items: [
        {
          id: "7",
          name: "Team",
          type: "scrum",
          browseUrl: "https://jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=7",
        },
        {
          id: "8",
          name: "Delivery",
          type: "kanban",
          browseUrl: "https://jira.example.invalid/context/secure/RapidBoard.jspa?rapidView=8",
        },
      ],
      startAt: 0,
      total: 3,
      nextStartAt: 2,
    });
    expect(f.http.mock.calls[0]?.[0].url).toBe(
      "https://jira.example.invalid/context/rest/agile/1.0/board?startAt=0&maxResults=2",
    );
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
  });

  it("refuses malformed and cross-entity responses", async () => {
    const f = fixture({ id: 8, name: "Wrong", type: "scrum" });
    expect(
      (await executeJiraAgileRead("jira.board", { boardId: "7" }, f.context, f.connection)).isError,
    ).toBe(true);
  });

  it.each([
    { boardId: "../sprint" },
    { boardId: "7", url: "https://elsewhere.invalid" },
    { boardId: "9007199254740992" },
  ])("refuses an unbounded or extra routing argument before transport", async (args) => {
    const f = fixture({});
    expect((await executeJiraAgileRead("jira.board", args, f.context, f.connection)).isError).toBe(
      true,
    );
    expect(f.http).not.toHaveBeenCalled();
  });

  it("does not dispatch for Cloud or withdrawn authority", async () => {
    const f = fixture({});
    expect(
      (
        await executeJiraAgileRead("jira.boards", {}, f.context, {
          ...f.connection,
          deployment: "cloud",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await executeJiraAgileRead(
          "jira.boards",
          {},
          { ...f.context, beforeEffect: () => false },
          f.connection,
        )
      ).isError,
    ).toBe(true);
    expect(f.http).not.toHaveBeenCalled();
  });
});
