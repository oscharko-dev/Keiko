import { describe, expect, it, vi } from "vitest";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraParticipationMutation as mutate,
  executeJiraParticipationRead as read,
} from "./jira-managed-participation.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

const BASE = "https://jira.example.invalid/context";
function executeJiraParticipationMutation(
  operation: Parameters<typeof mutate>[0],
  args: Parameters<typeof mutate>[1],
  request: JiraMutationRequest,
  check = false,
): ReturnType<typeof mutate> {
  return mutate(operation, args, request, check, BASE);
}
function executeJiraParticipationRead(
  operation: Parameters<typeof read>[0],
  args: Parameters<typeof read>[1],
  request: JiraMutationRequest,
): ReturnType<typeof read> {
  return read(operation, args, request, BASE);
}

const ISSUE = {
  ok: true,
  status: 200,
  body: { id: "10001", key: "APP-1", fields: { summary: "Fixture" } },
} as const;
function response(watch: boolean, state: boolean): Awaited<ReturnType<JiraMutationRequest>> {
  return {
    ok: true,
    status: 200,
    body: watch
      ? {
          watchCount: 1,
          isWatching: state,
          watchers: [
            {
              name: "reviewer",
              displayName: "Reviewer",
              emailAddress: "hidden@example.invalid",
              self: "https://untrusted.invalid",
            },
          ],
        }
      : { votes: 1, hasVoted: state, voters: [{ name: "reviewer" }] },
  } as const;
}
describe("closed current-user participation", () => {
  it.each(["app-1", "10001"])(
    "binds %s to the actual canonical issue key and allows only its observed self",
    async (issueKey) => {
      const request = vi
        .fn<JiraMutationRequest>()
        .mockResolvedValueOnce(ISSUE)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: {
            watchCount: 0,
            isWatching: false,
            self: `${BASE}/rest/api/2/issue/APP-1/watchers`,
          },
        })
        .mockResolvedValueOnce({ ok: true, status: 204, body: undefined })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: {
            watchCount: 1,
            isWatching: true,
            self: `${BASE}/rest/api/2/issue/10001/watchers`,
          },
        });
      expect(await executeJiraParticipationMutation("jira.watch", { issueKey }, request)).toEqual({
        ok: true,
        receipt: { issueKey: "APP-1", issueId: "10001", isWatching: true },
      });
    },
  );
  it.each([
    "https://untrusted.invalid/context/rest/api/2/issue/APP-1/watchers",
    "https://jira.example.invalid/other/rest/api/2/issue/APP-1/watchers",
    `${BASE}/rest/api/2/issue/OTHER-2/watchers`,
  ])("refuses a contradictory native self before writing", async (self) => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValueOnce(ISSUE)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { watchCount: 0, isWatching: false, self },
      });
    expect(
      await executeJiraParticipationMutation("jira.watch", { issueKey: "APP-1" }, request),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    { watchCount: -1, isWatching: false },
    { watchCount: 2, isWatching: "false" },
    { watchCount: 0, isWatching: false, watchers: [{ name: "unexpected" }] },
    { watchCount: 1, isWatching: false, watchers: [{ name: "first" }, { name: "first" }] },
  ])("refuses malformed native participation without effects", async (body) => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValueOnce(ISSUE)
      .mockResolvedValueOnce({ ok: true, status: 200, body });
    expect(
      await executeJiraParticipationMutation("jira.watch", { issueKey: "APP-1" }, request),
    ).toMatchObject({ ok: false, reason: "malformed-payload" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(["jira.watch", "jira.unwatch", "jira.vote", "jira.unvote"] as const)(
    "confirms %s independently after exactly one native effect",
    async (operation) => {
      const watch = operation.endsWith("watch");
      const desired = operation === "jira.watch" || operation === "jira.vote";
      const request = vi
        .fn<JiraMutationRequest>()
        .mockResolvedValueOnce(ISSUE)
        .mockResolvedValueOnce(response(watch, !desired));
      if (operation === "jira.unwatch")
        request.mockResolvedValueOnce({ ok: true, status: 200, body: { name: "current user" } });
      request
        .mockResolvedValueOnce({ ok: true, status: 204, body: undefined })
        .mockResolvedValueOnce(response(watch, desired));
      const result = await executeJiraParticipationMutation(
        operation,
        { issueKey: "APP-1" },
        request,
      );
      expect(result).toEqual({
        ok: true,
        receipt: {
          issueKey: "APP-1",
          issueId: "10001",
          ...(watch ? { isWatching: desired } : { hasVoted: desired }),
        },
      });
      const writes = request.mock.calls.filter((call) => call[1] !== undefined);
      expect(writes).toEqual([
        [
          `issue/10001/${watch ? "watchers" : "votes"}${operation === "jira.unwatch" ? "?username=current+user" : ""}`,
          desired ? "POST" : "DELETE",
          undefined,
          "none",
        ],
      ]);
      expect(request.mock.calls.at(-1)).toEqual([`issue/10001/${watch ? "watchers" : "votes"}`]);
    },
  );
  it.each(["jira.watch", "jira.unwatch", "jira.vote", "jira.unvote"] as const)(
    "refuses unchanged %s without an effect",
    async (operation) => {
      const watch = operation.endsWith("watch");
      const desired = operation === "jira.watch" || operation === "jira.vote";
      const request = vi
        .fn<JiraMutationRequest>()
        .mockResolvedValueOnce(ISSUE)
        .mockResolvedValueOnce(response(watch, desired));
      expect(
        await executeJiraParticipationMutation(operation, { issueKey: "APP-1" }, request),
      ).toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true } });
      expect(request.mock.calls.every((call) => call[1] === undefined)).toBe(true);
    },
  );
  it("preflights unwatch identity without dispatching DELETE", async () => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValueOnce(ISSUE)
      .mockResolvedValueOnce(response(true, true))
      .mockResolvedValueOnce({ ok: true, status: 200, body: { name: "current user" } });
    expect(
      await executeJiraParticipationMutation("jira.unwatch", { issueKey: "APP-1" }, request, true),
    ).toEqual({ ok: true, receipt: {} });
    expect(request.mock.calls.every((call) => call[1] === undefined)).toBe(true);
  });
  it("retains acknowledged identity when the independent read is denied", async () => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValueOnce(ISSUE)
      .mockResolvedValueOnce(response(false, false))
      .mockResolvedValueOnce({ ok: true, status: 200, body: undefined })
      .mockResolvedValueOnce({ ok: false, reason: "permission-denied" });
    expect(
      await executeJiraParticipationMutation("jira.vote", { issueKey: "APP-1" }, request),
    ).toEqual({
      ok: false,
      reason: "permission-denied",
      receipt: { issueKey: "APP-1", issueId: "10001" },
    });
    expect(request.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
  });
  it("preserves the original post-ack exception and receipt for the existing diagnostic owner", async () => {
    const cause = new TypeError("fixture failure");
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValueOnce(ISSUE)
      .mockResolvedValueOnce(response(false, false))
      .mockResolvedValueOnce({ ok: true, status: 204, body: undefined })
      .mockRejectedValueOnce(cause);
    const pending = executeJiraParticipationMutation("jira.vote", { issueKey: "APP-1" }, request);
    await expect(pending).rejects.toBeInstanceOf(JiraAcknowledgedMutationError);
    await expect(pending).rejects.toMatchObject({
      cause,
      receipt: { issueKey: "APP-1", issueId: "10001" },
    });
  });
  it.each([
    { issueKey: "../outside" },
    { issueKey: "APP-1", username: "another" },
    { issueKey: "APP-1", url: "https://untrusted.invalid" },
  ])("refuses model-selected target or actor expansion", async (args) => {
    const request = vi.fn<JiraMutationRequest>();
    expect(await executeJiraParticipationMutation("jira.watch", args, request)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it("does not equate a permission-hidden watcher list with zero watchers", async () => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValueOnce(ISSUE)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { watchCount: 4, isWatching: false, watchers: [] },
      });
    expect(
      await executeJiraParticipationRead("jira.watchers", { issueKey: "APP-1" }, request),
    ).toMatchObject({
      data: { watchCount: 4, isWatching: false, total: 0, items: [], listComplete: false },
    });
  });
  it("omits unknown state and excludes upstream URLs and email fields", async () => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValueOnce(ISSUE)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: {
          watchCount: 1,
          watchers: [
            {
              name: "reviewer",
              displayName: "Reviewer",
              emailAddress: "hidden@example.invalid",
              self: "https://untrusted.invalid",
            },
          ],
        },
      });
    const result = await executeJiraParticipationRead(
      "jira.watchers",
      { issueKey: "APP-1" },
      request,
    );
    expect(result.data).toMatchObject({
      items: [{ name: "reviewer", displayName: "Reviewer" }],
      listComplete: true,
    });
    expect(result.data).not.toHaveProperty("isWatching");
    expect(JSON.stringify(result)).not.toContain("hidden@example");
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
  });
  it("refuses unknown caller state before dispatch", async () => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValueOnce(ISSUE)
      .mockResolvedValueOnce({ ok: true, status: 200, body: { watchCount: 4, watchers: [] } });
    expect(
      await executeJiraParticipationMutation("jira.watch", { issueKey: "APP-1" }, request),
    ).toMatchObject({ ok: false, reason: "malformed-payload" });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
