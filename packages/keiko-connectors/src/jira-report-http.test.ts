import { expect, it, vi, type Mock } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { createJiraReportHttp } from "./jira-report-http.js";
import { jiraReportFailure } from "./jira-report-read.js";
import { response } from "../../../tests/support/jira-managed-remote.js";

interface Fixture {
  readonly caller: AbortController;
  readonly beforeEffect: Mock<() => boolean>;
  readonly http: Mock<AtlassianHttpBodyPort>;
  readonly sleep: Mock<(ms: number) => Promise<void>>;
  readonly reader: ReturnType<typeof createJiraReportHttp>;
}
function fixture(): Fixture {
  const caller = new AbortController();
  const beforeEffect = vi.fn(() => true);
  const http = vi
    .fn<AtlassianHttpBodyPort>()
    .mockResolvedValue(response({ startAt: 0, total: 1, issues: [] }));
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  const reader = createJiraReportHttp({
    baseUrl: "https://jira.example.invalid/context",
    signal: caller.signal,
    beforeEffect,
    http,
    sleep,
  });
  return { caller, beforeEffect, http, sleep, reader };
}
it.each(["getRecord", "getArray", "getAgileRecord"] as const)(
  "keeps local %s denial distinct from a remote outage",
  async (mode) => {
    const f = fixture();
    f.beforeEffect.mockReturnValue(false);
    expect(await f.reader[mode]("field")).toEqual({ ok: false, reason: "effect-denied" });
    expect(f.http).not.toHaveBeenCalled();
    expect(jiraReportFailure("effect-denied", false)).toBe("effect-denied");
  },
);
it("preserves a cancelled report read and its closed report failure code", async () => {
  const f = fixture();
  f.caller.abort();
  expect(await f.reader.getRecord("search?startAt=0&maxResults=100")).toEqual({
    ok: false,
    reason: "cancelled",
  });
  expect(jiraReportFailure("cancelled", true)).toBe("cancelled");
  expect(f.http).not.toHaveBeenCalled();
});
it("keeps board configuration reads under the caller's cancellation guard", async () => {
  const f = fixture();
  f.caller.abort();
  expect(await f.reader.getAgileRecord("board/7/configuration")).toEqual({
    ok: false,
    reason: "cancelled",
  });
  expect(f.http).not.toHaveBeenCalled();
});
it("rechecks report admission on a retry while retaining the injected sleep and exact native page", async () => {
  const f = fixture();
  f.http.mockResolvedValueOnce(response({}, 429));
  f.sleep.mockImplementation(() => {
    f.beforeEffect.mockReturnValue(false);
    return Promise.resolve();
  });
  expect(await f.reader.getRecord("search?startAt=200&maxResults=100")).toEqual({
    ok: false,
    reason: "effect-denied",
  });
  expect(f.sleep).toHaveBeenCalledWith(500);
  expect(f.http).toHaveBeenCalledTimes(1);
  expect(f.http.mock.calls[0]?.[0]).toMatchObject({
    method: "GET",
    url: "https://jira.example.invalid/context/rest/api/2/search?startAt=200&maxResults=100",
    signal: f.caller.signal,
  });
});
it("retains an actual native permission refusal after cancellation", async () => {
  const f = fixture();
  f.http.mockImplementation(() => {
    f.caller.abort();
    return Promise.resolve(response({}, 403));
  });
  expect(await f.reader.getRecord("search")).toEqual({ ok: false, reason: "permission-denied" });
  expect(jiraReportFailure("permission-denied", true)).toBe("permission");
  expect(f.http).toHaveBeenCalledTimes(1);
});
it("retains a completed native page after cancellation instead of discarding observed evidence", async () => {
  const f = fixture();
  const body = { startAt: 200, total: 201, issues: [{ id: "10201", key: "SYN-201" }] };
  f.http.mockImplementation(() => {
    f.caller.abort();
    return Promise.resolve(response(body));
  });
  expect(await f.reader.getRecord("search?startAt=200&maxResults=100")).toEqual({ ok: true, body });
  expect(f.http).toHaveBeenCalledTimes(1);
});
it("propagates a programmer defect through the report owner even after cancellation", async () => {
  const f = fixture();
  const defect = new TypeError("Synthetic report implementation defect");
  f.http.mockImplementation(() => {
    f.caller.abort();
    return Promise.reject(defect);
  });
  await expect(f.reader.getArray("field")).rejects.toBe(defect);
});

it("shares report admission and cancellation with auxiliary parent GETs", async () => {
  const f = fixture();
  f.beforeEffect.mockReturnValue(false);
  expect(await f.reader.request("issue/REP-1?fields=issuetype")).toEqual({
    ok: false,
    reason: "effect-denied",
  });
  expect(f.http).not.toHaveBeenCalled();
  f.beforeEffect.mockReturnValue(true);
  f.caller.abort();
  expect(await f.reader.request("issue/REP-1?fields=issuetype")).toEqual({
    ok: false,
    reason: "cancelled",
  });
  expect(f.http).not.toHaveBeenCalled();
});
it("refuses write or body-bearing auxiliary requests before transport", async () => {
  const f = fixture();
  expect(await f.reader.request("issue/REP-1", "PUT", { fields: {} })).toEqual({
    ok: false,
    reason: "effect-denied",
  });
  expect(await f.reader.request("issue/REP-1", "GET", {})).toEqual({
    ok: false,
    reason: "effect-denied",
  });
  expect(await f.reader.request("issue/REP-1", "GET", undefined, "json-array")).toEqual({
    ok: false,
    reason: "effect-denied",
  });
  expect(f.http).not.toHaveBeenCalled();
});
