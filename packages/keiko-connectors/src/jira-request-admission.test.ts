import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import type { AtlassianWriteHttpRequest } from "./atlassian-write-http.js";
import { executeAdmittedJiraRequest } from "./jira-request-admission.js";
import { requestFor } from "./jira-managed-mutations.js";
import { jiraAgileRequests } from "./jira-agile-request.js";
import { response } from "../../../tests/support/jira-managed-remote.js";

const GET: AtlassianWriteHttpRequest = {
  method: "GET",
  url: "https://jira.example.invalid/context/rest/api/2/project",
  expect: "json",
};
function fixture() {
  const caller = new AbortController();
  const deadline = new AbortController();
  const signal = AbortSignal.any([caller.signal, deadline.signal]);
  const beforeEffect = vi.fn(() => true);
  const context: ManagedMcpInvocationContext = {
    invocationId: "admission",
    correlationId: "admission",
    signal: caller.signal,
    beforeEffect,
  };
  const http = vi.fn<AtlassianHttpBodyPort>().mockResolvedValue(response({ id: "10001" }));
  const connection = {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    http,
  };
  return {
    caller,
    deadline,
    signal,
    beforeEffect,
    context,
    http,
    connection,
    run: (request: AtlassianWriteHttpRequest = GET) =>
      executeAdmittedJiraRequest(connection, context, signal, request),
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("private Jira request admission over the existing HTTP owner", () => {
  it.each([false, undefined, 1, "true", Promise.resolve(true)])(
    "requires synchronous true, not merely truthiness: %s",
    async (admitted) => {
      const f = fixture();
      Reflect.set(f.context, "beforeEffect", () => admitted);
      expect(await f.run()).toEqual({ ok: false, reason: "effect-denied" });
      expect(f.http).not.toHaveBeenCalled();
    },
  );
  it.each(["caller", "deadline"] as const)(
    "preserves the local %s cause before dispatch",
    async (cause) => {
      const f = fixture();
      f[cause].abort();
      expect(await f.run()).toEqual({
        ok: false,
        reason: cause === "caller" ? "cancelled" : "timeout",
      });
      expect(f.beforeEffect).not.toHaveBeenCalled();
      expect(f.http).not.toHaveBeenCalled();
    },
  );
  it("prioritizes explicit caller cancellation when both lifetimes have ended", async () => {
    const f = fixture();
    f.deadline.abort();
    f.caller.abort();
    expect(await f.run()).toEqual({ ok: false, reason: "cancelled" });
    expect(f.http).not.toHaveBeenCalled();
  });
  it("rechecks cancellation caused synchronously by the permit guard", async () => {
    const f = fixture();
    f.beforeEffect.mockImplementation(() => {
      f.caller.abort();
      return true;
    });
    expect(await f.run()).toEqual({ ok: false, reason: "cancelled" });
    expect(f.http).not.toHaveBeenCalled();
  });
  it("rechecks admission before each actual GET retry without inventing a Jira rejection", async () => {
    const f = fixture();
    f.http.mockResolvedValueOnce(response({ errorMessages: ["Synthetic throttling"] }, 429));
    f.beforeEffect.mockReturnValueOnce(true).mockReturnValue(false);
    const pending = f.run();
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ ok: false, reason: "effect-denied" });
    expect(f.beforeEffect).toHaveBeenCalledTimes(2);
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it("keeps the existing successful bounded GET retry when admission still holds", async () => {
    const f = fixture();
    f.http.mockResolvedValueOnce(response({}, 503));
    const pending = f.run();
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ ok: true, status: 200, body: { id: "10001" } });
    expect(f.http).toHaveBeenCalledTimes(2);
    expect(f.beforeEffect).toHaveBeenCalledTimes(2);
    for (const [request] of f.http.mock.calls) {
      expect(request).toMatchObject({
        method: "GET",
        url: GET.url,
        signal: f.signal,
        maxBodyBytes: 262144,
      });
      expect(request.timeoutMs).toBeLessThanOrEqual(30000);
    }
  });
  it("preserves a real HTTP refusal when cancellation occurs at the next retry admission boundary", async () => {
    const f = fixture();
    f.http.mockResolvedValue(response({ errorMessages: ["Native throttling"] }, 429));
    f.beforeEffect.mockReturnValueOnce(true).mockImplementation(() => {
      f.caller.abort();
      return true;
    });
    const pending = f.run();
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({
      ok: false,
      reason: "rate-limited",
      httpStatus: 429,
      remote: { messages: ["Native throttling"] },
    });
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it.each(["caller", "deadline"] as const)(
    "classifies a transport interruption at its local %s cause",
    async (cause) => {
      const f = fixture();
      f.http.mockImplementation(async () => {
        await Promise.resolve();
        f[cause].abort();
        return { kind: "network-error" };
      });
      expect(await f.run()).toEqual({
        ok: false,
        reason: cause === "caller" ? "cancelled" : "timeout",
      });
      expect(f.http).toHaveBeenCalledTimes(1);
    },
  );
  it.each([200, 201, 204, 400, 401, 403, 409, 429, 503])(
    "retains a native HTTP%s after late cancellation and never replays a write",
    async (status) => {
      const f = fixture();
      f.http.mockImplementation(async () => {
        f.caller.abort();
        return response({ id: "10001", errorMessages: ["Native refusal"] }, status);
      });
      const result = await f.run({
        ...GET,
        method: "POST",
        bodyJson: '{"name":"Synthetic"}',
        expect: "none",
      });
      if (status < 300) expect(result).toEqual({ ok: true, status, body: undefined });
      else expect(result).toMatchObject({ ok: false, httpStatus: status });
      expect(f.http).toHaveBeenCalledTimes(1);
      expect(f.http.mock.calls[0]?.[0].bodyJson).toBe('{"name":"Synthetic"}');
    },
  );
  it.each(["timeout", "network-error"] as const)(
    "keeps a real %s without local cancellation",
    async (kind) => {
      const f = fixture();
      f.http.mockResolvedValue({ kind });
      expect(await f.run()).toEqual({
        ok: false,
        reason: kind === "timeout" ? "timeout" : "unavailable",
      });
    },
  );
  it("does not swallow a programmer defect just because cancellation happened too", async () => {
    const f = fixture();
    const defect = new TypeError("Synthetic implementation defect");
    f.http.mockImplementation(async () => {
      f.caller.abort();
      throw defect;
    });
    await expect(f.run()).rejects.toBe(defect);
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it("does not translate a lookalike refusal or a thrown guard defect", async () => {
    const f = fixture();
    const defect = Object.assign(new TypeError("Synthetic guard defect"), {
      reason: "effect-denied",
    });
    f.beforeEffect.mockImplementation(() => {
      throw defect;
    });
    await expect(f.run()).rejects.toBe(defect);
    expect(f.http).not.toHaveBeenCalled();
  });
  it("leaves malformed request-body refusal with the existing owner", async () => {
    const f = fixture();
    expect(await f.run({ ...GET, bodyJson: "{}" })).toEqual({
      ok: false,
      reason: "malformed-payload",
    });
    expect(f.beforeEffect).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
  });
});

describe("fixed Jira request constructors", () => {
  it("keeps an acknowledged platform write and refuses its next request without replay", async () => {
    const f = fixture();
    f.http.mockImplementation(async () => {
      f.beforeEffect.mockReturnValue(false);
      return response({ id: "10001" }, 201);
    });
    const request = requestFor(f.connection, f.context);
    expect(await request("project", "POST", { name: "Synthetic" })).toMatchObject({
      ok: true,
      status: 201,
      body: { id: "10001" },
    });
    expect(await request("project/10001")).toEqual({ ok: false, reason: "effect-denied" });
    expect(f.http.mock.calls.map(([entry]) => [entry.method, entry.url])).toEqual([
      ["POST", GET.url],
    ]);
  });
  it("keeps both Agile roots on the same current permit, including the after-ACK phase", async () => {
    const f = fixture();
    const phase = jiraAgileRequests(f.connection, f.context);
    await phase.issue("issue/SYN-1");
    await phase.agile("sprint", "POST", { name: "Synthetic" });
    f.beforeEffect.mockReturnValue(false);
    expect(await phase.readback().agile("sprint/9")).toEqual({
      ok: false,
      reason: "effect-denied",
    });
    expect(f.http.mock.calls.map(([entry]) => [entry.method, entry.url])).toEqual([
      ["GET", "https://jira.example.invalid/context/rest/api/2/issue/SYN-1"],
      ["POST", "https://jira.example.invalid/context/rest/agile/1.0/sprint"],
    ]);
    expect(await phase.readback().agile("sprint/9", "PUT", {})).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(f.http).toHaveBeenCalledTimes(2);
  });
});
