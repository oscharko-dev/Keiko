import { describe, expect, it, vi } from "vitest";
import { AtlassianCredentialCustodyError, type AtlassianHttpBodyRequest } from "@oscharko-dev/keiko-connectors";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";
import { atlassianHttpRequestLifecycle } from "./httpRequestLifecycle.js";

const BASE = "https://jira.example.invalid/context";
const VERSION = '"native-role-version"';
const ROLE = { key: "jira-software", groups: ["R&D team"], defaultGroups: ["R&D team"] };
const GET: AtlassianHttpBodyRequest = { method: "GET", url: `${BASE}/rest/api/2/applicationrole`, jiraApplicationRole: "version", timeoutMs: 1000, maxBodyBytes: 4096 };
const PUT: AtlassianHttpBodyRequest = { ...GET, method: "PUT", url: `${GET.url}/jira-software`, jiraApplicationRole: { ifMatch: VERSION }, bodyJson: JSON.stringify(ROLE) };
const APP: AtlassianHttpBodyRequest = { method: "POST", url: `${BASE}/rest/api/2/user/application?username=Target+User&applicationKey=jira-software`, jiraUserApplication: true, timeoutMs: 1000, maxBodyBytes: 4096 };
const COLUMNS: AtlassianHttpBodyRequest = { method: "PUT", url: `${BASE}/rest/api/2/user/columns`, jiraUserColumns: true, bodyJson: "username=Target+User&columns=summary&columns=status&columns=summary", timeoutMs: 1000, maxBodyBytes: 4096 };
function fixture(response: () => Response = () => new Response(JSON.stringify([ROLE]), { headers: { etag: VERSION, "content-type": "application/json" } })) {
  const credentials = { resolveForExecution: vi.fn(() => ({ scheme: "bearer-pat" as const, apiToken: "synthetic-directory-token" })) };
  const beforeDispatch = vi.fn(() => true); const onResponse = vi.fn(() => true);
  const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(response()));
  const options = { baseUrl: BASE, authRef: "synthetic-directory-reference", correlationId: "directory", credentials, beforeDispatch, onResponse, fetchImpl };
  return { ...options, port: createGatewayAtlassianHttpBodyPort(options) };
}
describe("fixed directory transport boundary", () => {
  it("retains one bounded strong native collection version only on its admitted GET", async () => {
    const f = fixture();
    expect(await f.port(GET)).toMatchObject({ kind: "response", status: 200, applicationRoleVersion: VERSION });
    expect(await f.port({ ...GET, jiraApplicationRole: undefined })).not.toHaveProperty("applicationRoleVersion");
    expect(await f.port(PUT)).not.toHaveProperty("applicationRoleVersion");
    expect(new Headers(f.fetchImpl.mock.calls[2]?.[1]?.headers).get("if-match")).toBe(VERSION);
    expect(new Headers(f.fetchImpl.mock.calls[0]?.[1]?.headers).has("if-match")).toBe(false);
  });
  it.each([undefined, "*", "plain", 'W/"weak"', '"one", "two"', `"${"x".repeat(255)}"`])("does not expose unsupported native version %s", async (etag) => {
    const f = fixture(() => new Response("[]", { headers: etag === undefined ? {} : { etag } }));
    expect(await f.port(GET)).not.toHaveProperty("applicationRoleVersion");
  });
  it("sends a bulk JSON list with the exact same native CAS", async () => {
    const f = fixture(() => new Response(null, { status: 204 }));
    await f.port({ ...PUT, url: GET.url, bodyJson: JSON.stringify([ROLE]) });
    const sent = f.fetchImpl.mock.calls[0]?.[1];
    expect(sent?.body).toBe(JSON.stringify([ROLE]));
    expect(new Headers(sent?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(sent?.headers).get("if-match")).toBe(VERSION);
  });
  it.each(["POST", "DELETE"] as const)("adds ExperimentalApi only on bodyless fixed user/application %s", async (method) => {
    const f = fixture(() => new Response(null, { status: 204 })); await f.port({ ...APP, method });
    const sent = f.fetchImpl.mock.calls[0]?.[1];
    expect(sent?.body).toBeUndefined(); expect(new Headers(sent?.headers).get("x-experimentalapi")).toBe("true");
    expect(new Headers(sent?.headers).has("content-type")).toBe(false);
  });
  it("sends canonical form bytes with one username and ordered repeated columns", async () => {
    const f = fixture(() => new Response(null, { status: 204 })); await f.port(COLUMNS);
    const sent = f.fetchImpl.mock.calls[0]?.[1];
    expect(sent?.body).toBe(COLUMNS.bodyJson);
    expect(new Headers(sent?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(new Headers(sent?.headers).has("x-experimentalapi")).toBe(false);
    expect(new Headers(sent?.headers).has("x-atlassian-token")).toBe(false);
  });
  it.each([
    { ...GET, url: "https://foreign.example/rest/api/2/applicationrole" },
    { ...GET, url: "https://jira.example.invalid/rest/api/2/applicationrole" },
    { ...GET, url: `${BASE}/other/rest/api/2/applicationrole` },
    { ...GET, url: `${GET.url}?expand=roles` }, { ...GET, url: `${GET.url}/jira-software` },
    { ...GET, bodyJson: "[]" }, { ...GET, method: "POST" },
    { ...PUT, jiraApplicationRole: { ifMatch: "*" } }, { ...PUT, jiraApplicationRole: { ifMatch: 'W/"weak"' } },
    { ...PUT, bodyJson: "{}" }, { ...PUT, bodyJson: JSON.stringify([ROLE]) },
    { ...PUT, bodyJson: JSON.stringify({ ...ROLE, key: "other-role" }) },
    { ...PUT, bodyJson: JSON.stringify({ ...ROLE, name: "model rename" }) },
    { ...PUT, bodyJson: JSON.stringify({ ...ROLE, defaultGroups: ["outside"] }) },
    { ...PUT, url: GET.url, bodyJson: JSON.stringify(ROLE) },
    { ...PUT, url: `${BASE}/rest/api/2/applicationrole%2fextra` },
    { ...APP, method: "PUT" }, { ...APP, bodyJson: "{}" },
    { ...APP, url: `${APP.url}&username=other` }, { ...APP, url: `${APP.url}&other=true` },
    { ...APP, url: `${BASE}/rest/api/2/user/application?applicationKey=jira-software` },
    { ...APP, jiraExperimental: true }, { ...APP, jiraUserColumns: true },
    { ...COLUMNS, bodyJson: '{"columns":["summary"]}' },
    { ...COLUMNS, bodyJson: "username=Target+User" },
    { ...COLUMNS, bodyJson: "username=Target+User&username=other&columns=summary" },
    { ...COLUMNS, bodyJson: "username=Target+User&columns=summary&headers=x" },
    { ...COLUMNS, bodyJson: "username=Target%20User&columns=summary" },
    { ...COLUMNS, bodyJson: "username=Target+User&columns=" },
    { ...COLUMNS, url: `${COLUMNS.url}?username=other` },
    { ...COLUMNS, jiraPermissionAttribute: true }, { ...COLUMNS, jiraEmailTemplateArchive: true },
  ] satisfies readonly AtlassianHttpBodyRequest[])("refuses malformed special path/flag/body before dispatch and credentials", async (request) => {
    const f = fixture(); await expect(f.port(request)).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(f.beforeDispatch).not.toHaveBeenCalled(); expect(f.credentials.resolveForExecution).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([false, null, 1, "true"])("rejects forged opt-in %j", (value) => {
    const f = fixture(); const request = { ...APP }; Reflect.set(request, "jiraUserApplication", value);
    expect(() => atlassianHttpRequestLifecycle(f, request)).toThrow(AtlassianCredentialCustodyError);
    expect(f.credentials.resolveForExecution).not.toHaveBeenCalled();
  });
  it("records native 412 before a late abort and never exposes response header maps", async () => {
    const f = fixture(() => new Response('{"errorMessages":["Version changed"]}', { status: 412, headers: { etag: '"changed"' } }));
    const controller = new AbortController(); f.onResponse.mockImplementation(() => { controller.abort(); return true; });
    const result = await f.port({ ...PUT, signal: controller.signal });
    expect(result).toMatchObject({ kind: "response", status: 412 });
    expect(result).not.toHaveProperty("headers"); expect(result).not.toHaveProperty("applicationRoleVersion");
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
});
