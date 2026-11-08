import { describe, expect, it, vi } from "vitest";
import { AtlassianCredentialCustodyError, type AtlassianHttpBodyRequest } from "@oscharko-dev/keiko-connectors";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";

const BASE = "https://jira.example.invalid/context";
const AUTH = `atlassian-cred:${"Cc3-_".repeat(4)}Xx`;
const PRIORITY: AtlassianHttpBodyRequest = { method: "PUT", url: `${BASE}/rest/api/2/project/7/priorityscheme`,
  timeoutMs: 1000, maxBodyBytes: 4096, jiraProjectPriority: true, bodyJson: '{"id":9}' };
function fixture() {
  const resolveForExecution = vi.fn(() => ({ scheme: "bearer-pat" as const, apiToken: "synthetic-admitted-pat" }));
  const beforeDispatch = vi.fn(() => true); const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
  return { resolveForExecution, beforeDispatch, fetchImpl,
    port: createGatewayAtlassianHttpBodyPort({ baseUrl: BASE, authRef: AUTH, credentials: { resolveForExecution }, beforeDispatch, fetchImpl }) };
}
describe("closed native user/project experimental HTTP flags", () => {
  it("emits the fixed header and exact JSON numeric body only on the bound priority route", async () => {
    const f = fixture(); expect(await f.port(PRIORITY)).toMatchObject({ status: 204 });
    const init = f.fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("X-ExperimentalApi")).toBe("true");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json"); expect(init?.body).toBe('{"id":9}');
  });
  it("sends ordinary user metadata and never accepts a secret through the CRUD body", async () => {
    const f = fixture();
    const request: AtlassianHttpBodyRequest = { ...PRIORITY, jiraProjectPriority: undefined, jiraIdentityExperimental: true,
      url: `${BASE}/rest/api/2/user?key=native-key`, bodyJson: '{"active":false}' };
    expect(await f.port(request)).toMatchObject({ status: 204 });
    expect(f.fetchImpl.mock.calls[0]?.[1]?.body).toBe('{"active":false}');
    f.fetchImpl.mockClear(); f.resolveForExecution.mockClear();
    await expect(f.port({ ...request, bodyJson: '{"password":"model supplied"}' })).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(f.resolveForExecution).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    { url: `${BASE}/rest/api/2/project/7/priorityscheme?other=1` }, { url: "https://jira.example.invalid/rest/api/2/project/7/priorityscheme" },
    { url: `${BASE}/rest/api/2/project/07/priorityscheme` }, { url: `${BASE}/rest/api/2/project/7/permissionscheme` },
    { bodyJson: '{"id":9007199254740993}' }, { bodyJson: '{"id":"9"}' }, { bodyJson: '{"id":9,"headers":{}}' },
    { method: "POST" }, { jiraIdentityExperimental: true }, { jiraExperimental: true },
  ] satisfies readonly Partial<AtlassianHttpBodyRequest>[]) ("refuses incompatible selectors/media/flags before custody %#", async (delta) => {
    const f = fixture(); await expect(f.port({ ...PRIORITY, ...delta })).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(f.beforeDispatch).not.toHaveBeenCalled(); expect(f.resolveForExecution).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
