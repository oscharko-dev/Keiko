import { describe, expect, it, vi, type Mock } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { jiraAgileRequests, jiraExperimentalAgileRequest } from "./jira-agile-request.js";

interface ExperimentalFixture {
  readonly http: Mock<AtlassianHttpBodyPort>;
  readonly beforeEffect: Mock<() => boolean>;
  readonly controller: AbortController;
  readonly context: Parameters<typeof jiraExperimentalAgileRequest>[1];
  readonly connection: Parameters<typeof jiraExperimentalAgileRequest>[0];
  readonly request: ReturnType<typeof jiraExperimentalAgileRequest>;
}
function fixture(admitted = true): ExperimentalFixture {
  const http = vi.fn<AtlassianHttpBodyPort>(() =>
    Promise.resolve({
      kind: "response",
      status: 204,
      bodyText: "",
      bodyBytes: 0,
      truncated: false,
    }),
  );
  const beforeEffect = vi.fn(() => admitted);
  const controller = new AbortController();
  const context = {
    invocationId: "experimental-cleanup",
    correlationId: "experimental-cleanup",
    signal: controller.signal,
    beforeEffect,
  };
  const connection = {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    http,
  };
  return {
    http,
    beforeEffect,
    controller,
    context,
    connection,
    request: jiraExperimentalAgileRequest(connection, context),
  };
}

describe("closed experimental sprint request port", () => {
  it.each(["sprint/unmap", "sprint/unmap-all"])("opts in only the fixed PUT %s", async (path) => {
    const f = fixture();
    expect(await f.request(path, "PUT", { sprintIds: [12] }, "none")).toEqual({
      ok: true,
      status: 204,
      body: undefined,
    });
    expect(f.http).toHaveBeenCalledOnce();
    expect(f.http.mock.calls[0]?.[0]).toMatchObject({
      method: "PUT",
      url: `https://jira.example.invalid/context/rest/agile/1.0/${path}`,
      bodyJson: '{"sprintIds":[12]}',
      jiraExperimental: true,
    });
    expect(f.beforeEffect).toHaveBeenCalledOnce();
  });

  it.each([
    { path: "sprint/unmap", method: "GET" },
    { path: "sprint/unmap", method: "POST" },
    { path: "sprint/unmap-all", method: "DELETE" },
    { path: "sprint/12", method: "PUT" },
    { path: "sprint/unmap?scope=all", method: "PUT" },
    { path: "sprint/unmap#fragment", method: "PUT" },
    { path: "./sprint/unmap", method: "PUT" },
    { path: "sprint/%75nmap", method: "PUT" },
    { path: "/sprint/unmap", method: "PUT" },
  ] as const)(
    "refuses unsupported $method $path without admission or HTTP",
    async ({ path, method }) => {
      const f = fixture();
      expect(await f.request(path, method)).toEqual({ ok: false, reason: "unavailable" });
      expect(f.beforeEffect).not.toHaveBeenCalled();
      expect(f.http).not.toHaveBeenCalled();
    },
  );

  it("refuses multipart data and default GET before HTTP", async () => {
    const f = fixture();
    expect(
      await f.request("sprint/unmap", "PUT", undefined, "none", {
        contentType: "multipart/form-data; boundary=synthetic",
        bytes: new Uint8Array([1]),
      }),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(await f.request("sprint/unmap")).toEqual({ ok: false, reason: "unavailable" });
    expect(f.http).not.toHaveBeenCalled();
  });

  it.each(["denied", "cancelled"])("keeps the original %s boundary", async (state) => {
    const f = fixture(state !== "denied");
    if (state === "cancelled") f.controller.abort();
    expect(await f.request("sprint/unmap", "PUT", {}, "none")).toEqual({
      ok: false,
      reason: state === "denied" ? "effect-denied" : "cancelled",
    });
    expect(f.http).not.toHaveBeenCalled();
  });

  it("does not opt ordinary validation or readback into experimental APIs", async () => {
    const f = fixture();
    const requests = jiraAgileRequests(f.connection, f.context);
    await requests.agile("sprint/12", "GET", undefined, "none");
    await requests.readback().agile("sprint/12", "GET", undefined, "none");
    expect(f.http).toHaveBeenCalledTimes(2);
    for (const [request] of f.http.mock.calls)
      expect(request).not.toHaveProperty("jiraExperimental");
  });

  it("never retries an experimental PUT after a lost acknowledgement", async () => {
    const f = fixture();
    f.http.mockResolvedValue({ kind: "timeout" });
    expect(await f.request("sprint/unmap-all", "PUT", {}, "none")).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(f.http).toHaveBeenCalledOnce();
  });
});
