import { beforeEach, describe, expect, it, vi } from "vitest";

const requests = [];
const statuses = new Map();
vi.mock("../testing/jira-chat-lab/lab-client.mjs", () => ({
  actorDetails: (actor) => ({ name: `keiko-${actor}` }),
  basicAuth: (_session, actor) => `auth:${actor}`,
  checked: vi.fn(),
  labRequest: vi.fn(async (_session, method, path, auth) => {
    requests.push({ method, path, auth });
    return { status: statuses.get(path) ?? 204 };
  }),
}));

const { removeNative } = await import("../testing/jira-chat-lab/catalog-selection-objects.mjs");

describe("removeNative", () => {
  beforeEach(() => {
    requests.length = 0;
    statuses.clear();
  });

  it("removes a path as the given actor and a voter's entry as its own actor", async () => {
    await removeNative({}, [
      "/rest/api/2/issue/K-1/worklog/9",
      {
        key: "/rest/api/2/issue/K-1/votes@keiko-api",
        path: "/rest/api/2/issue/K-1/votes",
        actor: "api",
      },
    ]);
    expect(requests).toEqual([
      { method: "DELETE", path: "/rest/api/2/issue/K-1/worklog/9", auth: "auth:admin" },
      { method: "DELETE", path: "/rest/api/2/issue/K-1/votes", auth: "auth:api" },
    ]);
  });

  it("removes a version through removeAndSwap, which Jira 10 offers instead of DELETE", async () => {
    statuses.set("/rest/api/2/version/7/removeAndSwap", 204);
    await removeNative({}, ["/rest/api/2/version/7"]);
    expect(requests).toEqual([
      { method: "POST", path: "/rest/api/2/version/7/removeAndSwap", auth: "auth:admin" },
    ]);
  });

  it("accepts an already absent object and attempts every entry before it fails", async () => {
    statuses.set("/rest/api/2/component/1", 404);
    statuses.set("/rest/api/2/issue/K-1/comment/3", 403);
    await expect(
      removeNative({}, [
        "/rest/api/2/component/1",
        "/rest/api/2/issue/K-1/comment/3",
        "/rest/api/2/issue/K-1/worklog/9",
      ]),
    ).rejects.toThrow(/^Native cleanup failed for 1 paths \(403 \S*comment/u);
    expect(requests).toHaveLength(3);
  });
});
