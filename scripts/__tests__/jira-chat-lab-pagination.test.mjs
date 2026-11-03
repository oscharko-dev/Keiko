import { URL, URLSearchParams } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  paginationObserver,
  observedPaginationPage,
  verifyPaginationPage,
} from "../testing/jira-chat-lab/pagination-chat.mjs";

const keys = ["SYNTHETIC-1", "SYNTHETIC-2", "SYNTHETIC-3", "SYNTHETIC-4"];
const first = {
  outcome: "succeeded",
  items: keys.slice(0, 2).map((key) => ({ key })),
  startAt: 0,
  total: 4,
  nextStartAt: 2,
};
const expectation = { keys, startAt: 0, maxResults: 2, seen: [] };

function completedPage(grant) {
  const intent = {
    arguments: { jql: "project = SYNTHETIC", startAt: 2, maxResults: 2 },
    expectedReadGrants: 0,
    reusedReadGrantId: "existing-grant",
    transport: "stream",
  };
  const observed = {
    completed: {
      messages: [
        {
          id: "new-turn",
          role: "user",
          turnState: "completed",
          toolTranscript: {
            ...(grant === undefined ? {} : { readGrant: grant }),
            exchanges: [
              {
                call: { name: "jira_search", arguments: intent.arguments },
                result: { status: "completed", invocationId: "new-invocation", data: first },
              },
            ],
          },
        },
      ],
    },
    decisions: { grants: 0, approvals: 0 },
    events: new Set(),
  };
  return { observed, intent };
}

it("accepts the actual repeated-turn transcript after its exact existing grant was verified", () => {
  const { observed, intent } = completedPage();
  expect(observedPaginationPage(observed, intent)).toMatchObject({
    userId: "new-turn",
    invocationId: "new-invocation",
    grantId: "existing-grant",
    data: first,
  });
});

it.each([
  { kind: "jira-chat-read", state: "pending", grantId: "existing-grant" },
  { kind: "jira-chat-read", state: "granted", grantId: "different-grant" },
  { kind: "mcp-chat-read", state: "granted", grantId: "existing-grant" },
])("refuses contradictory public grant projections: %j", (grant) => {
  const { observed, intent } = completedPage(grant);
  expect(() => observedPaginationPage(observed, intent)).toThrow();
});

it("requires a first-turn grant and refuses reuse without its exact reference", () => {
  const { observed, intent } = completedPage();
  delete intent.reusedReadGrantId;
  expect(() => observedPaginationPage(observed, intent)).toThrow();
  intent.expectedReadGrants = 1;
  observed.decisions.grants = 1;
  observed.events.add("tool-read-consent");
  expect(() => observedPaginationPage(observed, intent)).toThrow();
  observed.completed.messages[0].toolTranscript.readGrant = {
    kind: "jira-chat-read",
    state: "granted",
    grantId: "fresh-grant",
  };
  expect(observedPaginationPage(observed, intent).grantId).toBe("fresh-grant");
});

describe("real Jira pagination evidence", () => {
  it("requires the actual continuation and complete ordered reference without skipped records", () => {
    expect(verifyPaginationPage(first, expectation)).toEqual({
      keys: keys.slice(0, 2),
      nextStartAt: 2,
    });
    const final = { ...first, startAt: 2, items: keys.slice(2).map((key) => ({ key })) };
    delete final.nextStartAt;
    expect(
      verifyPaginationPage(final, { ...expectation, startAt: 2, seen: keys.slice(0, 2) }),
    ).toEqual({ keys: keys.slice(2), nextStartAt: undefined });
    expect(
      verifyPaginationPage(
        { ...final, startAt: 4, items: [] },
        { ...expectation, startAt: 4, seen: keys },
      ),
    ).toEqual({ keys: [], nextStartAt: undefined });
  });

  it("accepts a bounded prefix only with the cursor at its first unreturned record", () => {
    expect(
      verifyPaginationPage(
        { ...first, items: first.items.slice(0, 1), nextStartAt: 1 },
        expectation,
      ),
    ).toEqual({ keys: keys.slice(0, 1), nextStartAt: 1 });
  });

  it.each([
    ["missing continuation", { nextStartAt: undefined }],
    ["skipped cursor", { nextStartAt: 3 }],
    ["stale cursor", { nextStartAt: 0 }],
    ["wrong start", { startAt: 2 }],
    ["fabricated total", { total: 2 }],
    ["empty nonterminal page", { items: [], nextStartAt: 0 }],
    ["duplicated record", { items: [first.items[0], first.items[0]] }],
    ["out-of-order page", { items: [...first.items].reverse() }],
    ["over-limit page", { items: keys.slice(0, 3).map((key) => ({ key })), nextStartAt: 3 }],
    ["failed observation", { outcome: "failed" }],
  ])("refuses %s instead of recording incomplete success", (_name, patch) => {
    expect(() => verifyPaginationPage({ ...first, ...patch }, expectation)).toThrow();
  });

  it("refuses overlap with an earlier accepted page and a false continuation after the end", () => {
    expect(() => verifyPaginationPage(first, { ...expectation, seen: [keys[0]] })).toThrow();
    expect(() =>
      verifyPaginationPage(
        { ...first, startAt: 4, items: [], nextStartAt: 4 },
        { ...expectation, startAt: 4, seen: keys },
      ),
    ).toThrow();
  });
});

function transportFixture() {
  const response = { status: 200, body: "private synthetic response" };
  const request = vi.fn().mockResolvedValue(response);
  const factory = vi.fn().mockReturnValue(request);
  const observer = paginationObserver();
  const metadata = { authRef: "opaque" };
  const lifecycle = { onResponse: vi.fn() };
  const port = observer.decorate(factory)(metadata, "correlation", lifecycle);
  const page = { jql: "project = SYNTHETIC ORDER BY key", startAt: 0, maxResults: 2 };
  const search = {
    method: "GET",
    url: `https://fixture.invalid/jira/rest/api/2/search?${new URLSearchParams(page)}`,
  };
  return { observer, port, request, factory, metadata, lifecycle, response, page, search };
}

describe("read-only production transport observation", () => {
  it("forwards verification and one exact page unchanged and records only bounded metadata", async () => {
    const fixture = transportFixture();
    const { observer, port, request, factory, metadata, lifecycle, response, page, search } =
      fixture;
    await port({ method: "GET", url: "https://fixture.invalid/jira/rest/api/2/myself" });
    expect(factory).toHaveBeenCalledWith(metadata, "correlation", lifecycle);
    observer.arm(page);
    await expect(port(search)).resolves.toBe(response);
    expect(request).toHaveBeenLastCalledWith(search);
    expect(observer.snapshot()).toEqual({
      requests: [{ startAt: 0, maxResults: 2, status: 200 }],
      mutationAttempts: 0,
    });
    await expect(port(search)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["POST", "PUT", "DELETE"])("refuses %s before any forwarded effect", async (method) => {
    const { port, observer, request, search } = transportFixture();
    await expect(port({ ...search, method })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(observer.snapshot()).toEqual({ requests: [], mutationAttempts: 1 });
  });

  it.each([
    ["startAt", "1"],
    ["maxResults", "100"],
    ["jql", "project = OTHER"],
  ])("refuses changed %s before forwarding", async (name, value) => {
    const { observer, port, request, search, page } = transportFixture();
    observer.arm(page);
    const url = new URL(search.url);
    url.searchParams.set(name, value);
    await expect(port({ ...search, url: url.href })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("cannot change cursor while its prior physical request is still pending", async () => {
    const { observer, port, request, search, page, response } = transportFixture();
    let settle;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    observer.arm(page);
    const pending = port(search);
    expect(() => observer.arm({ ...page, startAt: 2 })).toThrow();
    settle(response);
    await pending;
    expect(() => observer.arm({ ...page, startAt: 2 })).not.toThrow();
    expect(observer.snapshot().requests).toEqual([{ startAt: 0, maxResults: 2, status: 200 }]);
  });
});
