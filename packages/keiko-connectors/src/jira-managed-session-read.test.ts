import { expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
import { executeJiraSessionRead as read, isJiraSessionRead } from "./jira-managed-session-read.js";

function response(body: unknown, status = 200): AtlassianHttpBodyResult {
  const bodyText = JSON.stringify(body) ?? "";
  return {
    kind: "response",
    status,
    bodyText,
    bodyBytes: new TextEncoder().encode(bodyText).length,
    truncated: false,
  };
}
function context(beforeEffect: () => boolean = () => true): ManagedMcpInvocationContext {
  return {
    invocationId: "session-observation",
    correlationId: "session-observation",
    signal: new AbortController().signal,
    beforeEffect,
  };
}
function connection(http: AtlassianHttpBodyPort) {
  return {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    identity: "bound-credential-generation",
    http,
  };
}
function remote(body: unknown, status = 200) {
  return vi
    .fn<AtlassianHttpBodyPort>()
    .mockResolvedValueOnce(response({ key: "U1", name: "Canonical-Name" }))
    .mockResolvedValueOnce(response(body, status));
}
it("binds the fixed session GET to the current actor and never projects cookie/token/self fields", async () => {
  const http = remote({
    name: "Canonical-Name",
    self: "https://untrusted.invalid/redirect",
    session: { name: "JSESSIONID", value: "omitted-session-value" },
    loginInfo: {
      failedLoginCount: 0,
      loginCount: 7,
      previousLoginTime: "2026-11-08T10:00:00.000+0000",
      lastFailedLoginTime: null,
      password: "omitted",
    },
  });
  expect((await read({}, context(), connection(http))).data).toEqual({
    outcome: "succeeded",
    observationScope: "bound-current-user-session",
    userKey: "U1",
    username: "Canonical-Name",
    loginInfo: {
      failedLoginCount: 0,
      loginCount: 7,
      previousLoginTime: "2026-11-08T10:00:00.000+0000",
    },
  });
  expect(
    http.mock.calls.map(([request]) => [
      request.method,
      request.url,
      request.bodyJson,
      request.upload,
    ]),
  ).toEqual([
    ["GET", "https://jira.example.invalid/context/rest/api/2/myself", undefined, undefined],
    ["GET", "https://jira.example.invalid/context/rest/auth/1/session", undefined, undefined],
  ]);
});
it.each([undefined, null])("keeps omitted login metadata unknown: %j", async (loginInfo) => {
  const http = remote({ name: "Canonical-Name", loginInfo });
  expect((await read({}, context(), connection(http))).data).toEqual({
    outcome: "succeeded",
    observationScope: "bound-current-user-session",
    userKey: "U1",
    username: "Canonical-Name",
  });
});
it("keeps an explicit empty login-info object without inventing zero counters", async () => {
  expect(
    (await read({}, context(), connection(remote({ name: "Canonical-Name", loginInfo: {} })))).data
      .loginInfo,
  ).toEqual({});
});
it.each([
  {},
  { name: "different-user" },
  { name: "canonical-name" },
  { name: "Canonical-Name", loginInfo: [] },
  { name: "Canonical-Name", loginInfo: { failedLoginCount: -1 } },
  { name: "Canonical-Name", loginInfo: { loginCount: "0" } },
  { name: "Canonical-Name", loginInfo: { loginCount: 0.5 } },
  { name: "Canonical-Name", loginInfo: { previousLoginTime: "" } },
])("refuses foreign identity or malformed native session facts: %j", async (body) => {
  expect((await read({}, context(), connection(remote(body)))).data.reason).toBe(
    "malformed-payload",
  );
});
it.each([
  { loginCount: Number.MAX_SAFE_INTEGER + 1 },
  { failedLoginCount: Number.MAX_SAFE_INTEGER + 1 },
  { previousLoginTime: "x".repeat(129) },
])(
  "reports native precision/text bounds without silently rounding or truncating: %j",
  async (loginInfo) => {
    expect(
      (await read({}, context(), connection(remote({ name: "Canonical-Name", loginInfo })))).data
        .reason,
    ).toBe("bounds-exceeded");
  },
);
it.each([401, 403, 404])(
  "preserves native session refusal HTTP%s without login or another target",
  async (status) => {
    const http = remote({}, status);
    const result = await read({}, context(), connection(http));
    expect(result.data.outcome).toBe("failed");
    expect(result.data.reason).toBe(
      status === 401 ? "auth-failed" : status === 403 ? "permission-denied" : "not-found",
    );
    expect(http).toHaveBeenCalledTimes(2);
    expect(http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  },
);
it("refuses an unexpected empty success and does not claim an authenticated session", async () => {
  expect((await read({}, context(), connection(remote({}, 204)))).data.outcome).toBe("failed");
});
it.each([
  { username: "other" },
  { password: "not-sent" },
  { session: "not-sent" },
  { method: "POST" },
  { url: "https://untrusted.invalid" },
] satisfies readonly CatalogJsonObject[])(
  "refuses all selectors and credential/effect parameters before transport: %j",
  async (args) => {
    const http = remote({ name: "Canonical-Name" });
    expect((await read(args, context(), connection(http))).data.reason).toBe("invalid-input");
    expect(http).not.toHaveBeenCalled();
  },
);
it("does not dispatch session when the prerequisite current-user identity is unavailable", async () => {
  const http = vi
    .fn<AtlassianHttpBodyPort>()
    .mockResolvedValue(response({ name: "Canonical-Name" }));
  expect((await read({}, context(), connection(http))).data.reason).toBe("malformed-payload");
  expect(http).toHaveBeenCalledTimes(1);
});
it("rechecks current authority before the second native request", async () => {
  let allowed = true;
  const http = vi.fn<AtlassianHttpBodyPort>(async () => {
    allowed = false;
    return response({ key: "U1", name: "Canonical-Name" });
  });
  expect(
    (
      await read(
        {},
        context(() => allowed),
        connection(http),
      )
    ).data,
  ).toEqual({ outcome: "failed", reason: "effect-denied" });
  expect(http).toHaveBeenCalledTimes(1);
});
it("refuses an already cancelled invocation before sending either GET", async () => {
  const controller = new AbortController();
  controller.abort();
  const http = remote({ name: "Canonical-Name" });
  expect(
    (await read({}, { ...context(), signal: controller.signal }, connection(http))).data,
  ).toEqual({ outcome: "failed", reason: "cancelled" });
  expect(http).not.toHaveBeenCalled();
});
it("observes caller cancellation during an awaited transport interruption", async () => {
  const controller = new AbortController();
  const http = vi.fn<AtlassianHttpBodyPort>(async () => {
    await Promise.resolve();
    controller.abort();
    return { kind: "network-error" };
  });
  const result = await read({}, { ...context(), signal: controller.signal }, connection(http));
  expect(result.data).toEqual({ outcome: "failed", reason: "cancelled" });
  expect(http).toHaveBeenCalledTimes(1);
});
it("does not reinterpret a programmer defect after abort as ordinary cancellation", async () => {
  const controller = new AbortController();
  const defect = new TypeError("Synthetic implementation defect");
  const http = vi.fn<AtlassianHttpBodyPort>(async () => {
    controller.abort();
    throw defect;
  });
  await expect(
    read({}, { ...context(), signal: controller.signal }, connection(http)),
  ).rejects.toBe(defect);
  expect(http).toHaveBeenCalledTimes(1);
});
it.each(["identity", "session"] as const)(
  "retains a native401 from %s after late cancellation",
  async (phase) => {
    const controller = new AbortController();
    const http = vi.fn<AtlassianHttpBodyPort>(async (request) => {
      if (phase === "session" && request.url.endsWith("/myself"))
        return response({ key: "U1", name: "Canonical-Name" });
      controller.abort();
      return response({ errorMessages: ["Native authentication refusal"] }, 401);
    });
    expect(
      (await read({}, { ...context(), signal: controller.signal }, connection(http))).data,
    ).toMatchObject({
      outcome: "failed",
      reason: "auth-failed",
      messages: ["Native authentication refusal"],
    });
    expect(http).toHaveBeenCalledTimes(phase === "identity" ? 1 : 2);
    expect(
      http.mock.calls.every(
        ([request]) =>
          request.method === "GET" &&
          request.bodyJson === undefined &&
          request.upload === undefined,
      ),
    ).toBe(true);
  },
);
it("labels a refused current permit without inventing a network failure", async () => {
  const http = remote({ name: "Canonical-Name" });
  const result = await read(
    {},
    context(() => false),
    connection(http),
  );
  expect(result.data).toEqual({ outcome: "failed", reason: "effect-denied" });
  expect(http).not.toHaveBeenCalled();
});
it("does not expose an authentication mutation or claim a Cloud transport", async () => {
  const http = remote({ name: "Canonical-Name" });
  expect(
    (await read({}, context(), { ...connection(http), deployment: "cloud" })).data.reason,
  ).toBe("unavailable");
  expect(http).not.toHaveBeenCalled();
  expect(isJiraSessionRead("jira.current-session")).toBe(true);
  expect(isJiraSessionRead("jira.login")).toBe(false);
  expect(isJiraSessionRead("jira.logout")).toBe(false);
});
