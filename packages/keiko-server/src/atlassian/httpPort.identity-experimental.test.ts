import { describe, expect, it, vi } from "vitest";
import {
  AtlassianCredentialCustodyError,
  type AtlassianHttpBodyRequest,
} from "@oscharko-dev/keiko-connectors";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";

const BASE = "https://jira.example.invalid/context";
const AUTH = `atlassian-cred:${"Cc3-_".repeat(4)}Xx`;
const PRIORITY: AtlassianHttpBodyRequest = {
  method: "PUT",
  url: `${BASE}/rest/api/2/project/7/priorityscheme`,
  timeoutMs: 1000,
  maxBodyBytes: 4096,
  jiraProjectPriority: true,
  bodyJson: '{"id":9}',
};
function fixture(): {
  resolveForExecution: import("vitest").Mock<() => { scheme: "bearer-pat"; apiToken: string }>;
  beforeDispatch: import("vitest").Mock<() => boolean>;
  fetchImpl: import("vitest").Mock<typeof fetch>;
  port: import("@oscharko-dev/keiko-connectors").AtlassianHttpBodyPort;
} {
  const resolveForExecution = vi.fn(() => ({
    scheme: "bearer-pat" as const,
    apiToken: "synthetic-admitted-pat",
  }));
  const beforeDispatch = vi.fn(() => true);
  const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
  return {
    resolveForExecution,
    beforeDispatch,
    fetchImpl,
    port: createGatewayAtlassianHttpBodyPort({
      baseUrl: BASE,
      authRef: AUTH,
      credentials: { resolveForExecution },
      beforeDispatch,
      fetchImpl,
    }),
  };
}
function observedTarget(value: unknown): string {
  return String(value);
}
function projectReadResponse(input: unknown, suffix: string, status: number): Response {
  const url = observedTarget(input);
  if (url === `${BASE}/rest/api/2/project/syn`)
    return Response.json({ id: "9007199254740993", key: "SYN", name: "Synthetic project" });
  if (url === `${BASE}/rest/api/2/project/9007199254740993/${suffix}`)
    return Response.json({ id: 9, name: "Synthetic scheme" }, { status });
  throw new TypeError("Unexpected native project association request");
}
function projectReadFixture(
  name: "jira.project-priority-scheme" | "jira.project-permission-scheme",
  suffix: "priorityscheme" | "permissionscheme",
  status = 200,
): {
  beforeEffect: import("vitest").Mock<() => boolean>;
  run: () => Promise<
    import("@oscharko-dev/keiko-contracts/runtime/managed-mcp").ManagedMcpToolResult
  >;
  resolveForExecution: import("vitest").Mock<() => { scheme: "bearer-pat"; apiToken: string }>;
  beforeDispatch: import("vitest").Mock<() => boolean>;
  fetchImpl: import("vitest").Mock<typeof fetch>;
  port: import("@oscharko-dev/keiko-connectors").AtlassianHttpBodyPort;
} {
  const f = fixture();
  f.fetchImpl.mockImplementation(
    (input): Promise<Response> =>
      new Promise((resolve) => {
        resolve(projectReadResponse(input, suffix, status));
      }),
  );
  const provider = createJiraProviderForCatalog(
    () => ({ deployment: "data-center", baseUrl: BASE, http: f.port }),
    [name],
  );
  const tool = provider.tools()[0];
  if (tool === undefined) throw new TypeError("Missing project association read");
  const beforeEffect = vi.fn(() => true);
  return {
    ...f,
    beforeEffect,
    run: (): Promise<
      import("@oscharko-dev/keiko-contracts/runtime/managed-mcp").ManagedMcpToolResult
    > =>
      tool.execute(
        { projectIdOrKey: "syn" },
        {
          invocationId: "native-project-priority-read",
          correlationId: "native-project-priority-read",
          signal: new AbortController().signal,
          beforeEffect,
        },
      ),
  };
}
describe("closed native user/project experimental HTTP flags", () => {
  it.each([
    ["jira.project-priority-scheme", "priorityscheme", "true"],
    ["jira.project-permission-scheme", "permissionscheme", null],
  ] as const)(
    "composes %s through its real provider while leaving ordinary GET headers unchanged",
    async (name, suffix, expectedHeader) => {
      const f = projectReadFixture(name, suffix);
      expect(await f.run()).toMatchObject({
        data: {
          outcome: "succeeded",
          projectId: "9007199254740993",
          projectKey: "SYN",
          id: "9",
          name: "Synthetic scheme",
        },
      });
      expect(
        f.fetchImpl.mock.calls.map(([url, init]) => [
          observedTarget(url),
          init?.method,
          new Headers(init?.headers).get("X-ExperimentalApi"),
          init?.body,
        ]),
      ).toEqual([
        [`${BASE}/rest/api/2/project/syn`, "GET", null, undefined],
        [`${BASE}/rest/api/2/project/9007199254740993/${suffix}`, "GET", expectedHeader, undefined],
      ]);
      expect(f.beforeEffect).toHaveBeenCalledTimes(2);
      expect(f.beforeDispatch).toHaveBeenCalledTimes(2);
      expect(f.resolveForExecution).toHaveBeenCalledTimes(2);
    },
  );
  it("preserves native permission refusal without falling back to an unflagged priority GET", async () => {
    const f = projectReadFixture("jira.project-priority-scheme", "priorityscheme", 403);
    expect(await f.run()).toMatchObject({
      isError: true,
      data: { outcome: "failed", reason: "permission-denied" },
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    const primary = f.fetchImpl.mock.calls[1];
    expect(observedTarget(primary?.[0])).toBe(
      `${BASE}/rest/api/2/project/9007199254740993/priorityscheme`,
    );
    expect(new Headers(primary?.[1]?.headers).get("X-ExperimentalApi")).toBe("true");
  });
  it("rechecks admission before the priority GET without materialising further credentials", async () => {
    const f = projectReadFixture("jira.project-priority-scheme", "priorityscheme");
    f.beforeEffect.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await f.run()).toMatchObject({
      isError: true,
      data: { outcome: "failed", reason: "effect-denied" },
    });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.beforeDispatch).toHaveBeenCalledOnce();
    expect(f.resolveForExecution).toHaveBeenCalledOnce();
  });
  it("emits the fixed header and exact JSON numeric body only on the bound priority route", async () => {
    const f = fixture();
    expect(await f.port(PRIORITY)).toMatchObject({ status: 204 });
    const init = f.fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("X-ExperimentalApi")).toBe("true");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe('{"id":9}');
  });
  it("sends ordinary user metadata and never accepts a secret through the CRUD body", async () => {
    const f = fixture();
    const request: AtlassianHttpBodyRequest = {
      ...PRIORITY,
      jiraProjectPriority: undefined,
      jiraIdentityExperimental: true,
      url: `${BASE}/rest/api/2/user?key=native-key`,
      bodyJson: '{"active":false}',
    };
    expect(await f.port(request)).toMatchObject({ status: 204 });
    expect(f.fetchImpl.mock.calls[0]?.[1]?.body).toBe('{"active":false}');
    f.fetchImpl.mockClear();
    f.resolveForExecution.mockClear();
    await expect(
      f.port({ ...request, bodyJson: '{"password":"model supplied"}' }),
    ).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(f.resolveForExecution).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    { url: `${BASE}/rest/api/2/project/7/priorityscheme?other=1` },
    { url: "https://jira.example.invalid/rest/api/2/project/7/priorityscheme" },
    { url: `${BASE}/rest/api/2/project/07/priorityscheme` },
    { url: `${BASE}/rest/api/2/project/7/permissionscheme` },
    { bodyJson: '{"id":9007199254740993}' },
    { bodyJson: '{"id":"9"}' },
    { bodyJson: '{"id":9,"headers":{}}' },
    { method: "POST" },
    { jiraIdentityExperimental: true },
    { jiraExperimental: true },
  ] satisfies readonly Partial<AtlassianHttpBodyRequest>[])(
    "refuses incompatible selectors/media/flags before custody %#",
    async (delta) => {
      const f = fixture();
      await expect(f.port({ ...PRIORITY, ...delta })).rejects.toBeInstanceOf(
        AtlassianCredentialCustodyError,
      );
      expect(f.beforeDispatch).not.toHaveBeenCalled();
      expect(f.resolveForExecution).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
    },
  );
});
