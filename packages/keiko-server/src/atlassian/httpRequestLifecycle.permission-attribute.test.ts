import { describe, expect, it, vi } from "vitest";
import { AtlassianCredentialCustodyError, type AtlassianHttpBodyRequest } from "@oscharko-dev/keiko-connectors";
import { atlassianHttpRequestLifecycle } from "./httpRequestLifecycle.js";

const REQUEST: AtlassianHttpBodyRequest = {
  method: "PUT", url: "https://jira.example.invalid/context/rest/api/2/permissionscheme/7/attribute/selected",
  timeoutMs: 1000, maxBodyBytes: 1024, bodyJson: "false", jiraPermissionAttribute: true,
};
function options() {
  return { authRef: "synthetic-credential-reference", correlationId: "permission-attribute",
    beforeDispatch: vi.fn(() => true),
    credentials: { resolveForExecution: vi.fn(() => ({ scheme: "bearer-pat" as const,
      apiToken: "synthetic-permission-attribute-token" })) } };
}
describe("closed text/plain permission attribute headers", () => {
  it.each(["true", "false"])("keeps %s bytes unquoted with the documented media type", (bodyJson) => {
    const deps = options();
    const request = { ...REQUEST, bodyJson };
    const lifecycle = atlassianHttpRequestLifecycle(deps, request);
    expect(deps.beforeDispatch).not.toHaveBeenCalled();
    expect(deps.credentials.resolveForExecution).not.toHaveBeenCalled();
    const headers = lifecycle.prepareHeaders();
    expect(headers.get("content-type")).toBe("text/plain");
    expect(headers.has("x-experimentalapi")).toBe(false);
    expect(deps.beforeDispatch).toHaveBeenCalledExactlyOnceWith(request);
  });
  it.each(['"true"', '"false"', " true", "false\n", "{}", "", undefined])("refuses noncanonical boolean bytes %j", (bodyJson) => {
    const deps = options();
    expect(() => atlassianHttpRequestLifecycle(deps, { ...REQUEST, bodyJson })).toThrow(AtlassianCredentialCustodyError);
    expect(deps.beforeDispatch).not.toHaveBeenCalled();
    expect(deps.credentials.resolveForExecution).not.toHaveBeenCalled();
  });
  it("admits the canonical one-time encoding of a native Unicode key", () => {
    const deps = options();
    const request = { ...REQUEST,
      url: "https://jira.example.invalid/context/rest/api/2/permissionscheme/7/attribute/pr%C3%BCfstand.enabled" };
    expect(atlassianHttpRequestLifecycle(deps, request).prepareHeaders().get("content-type"))
      .toBe("text/plain");
  });
  it.each([
    { method: "GET", url: REQUEST.url }, { method: "POST", url: REQUEST.url },
    { method: "DELETE", url: REQUEST.url },
    { method: "PUT", url: "https://jira.example.invalid/rest/api/2/project/7" },
    { method: "PUT", url: `${REQUEST.url}?enabled=false` },
    { method: "PUT", url: `${REQUEST.url}#fragment` },
    { method: "PUT", url: `${REQUEST.url}/other` },
    { method: "PUT", url: "https://jira.example.invalid/rest/api/2/permissionscheme/9223372036854775808/attribute/selected" },
    { method: "PUT", url: "https://jira.example.invalid/rest/api/2/permissionscheme/7/attribute/selected%2Fother" },
    { method: "PUT", url: "https://jira.example.invalid/rest/api/2/permissionscheme/7/attribute/%00" },
    { method: "PUT", url: "https://jira.example.invalid/rest/api/2/permissionscheme/7/attribute/%25escape" },
    { method: "PUT", url: "https://jira.example.invalid/rest/api/2/permissionscheme/7/attribute/select%65d" },
    { method: "PUT", url: "http://jira.example.invalid/rest/api/2/permissionscheme/7/attribute/selected" },
  ] as const)("refuses wrong native target $method $url before custody", (target) => {
    const deps = options();
    expect(() => atlassianHttpRequestLifecycle(deps, { ...REQUEST, ...target })).toThrow(AtlassianCredentialCustodyError);
    expect(deps.beforeDispatch).not.toHaveBeenCalled();
    expect(deps.credentials.resolveForExecution).not.toHaveBeenCalled();
  });
  it.each([false, "true", 1, null])("refuses forged opt-in %j", (value) => {
    const deps = options();
    const request = { ...REQUEST };
    Reflect.set(request, "jiraPermissionAttribute", value);
    expect(() => atlassianHttpRequestLifecycle(deps, request)).toThrow(AtlassianCredentialCustodyError);
    expect(deps.beforeDispatch).not.toHaveBeenCalled();
    expect(deps.credentials.resolveForExecution).not.toHaveBeenCalled();
  });
  it("preserves application/json for ordinary boolean JSON requests", () => {
    const deps = options();
    const request = { ...REQUEST, jiraPermissionAttribute: undefined };
    expect(atlassianHttpRequestLifecycle(deps, request).prepareHeaders().get("content-type"))
      .toBe("application/json");
  });
  it("cannot combine the attribute flag with experimental or multipart opt-ins", () => {
    const deps = options();
    expect(() => atlassianHttpRequestLifecycle(deps, { ...REQUEST, jiraExperimental: true }))
      .toThrow(AtlassianCredentialCustodyError);
    expect(() => atlassianHttpRequestLifecycle(deps, { ...REQUEST, upload: {
      contentType: "multipart/form-data; boundary=synthetic", bytes: new Uint8Array([1]),
    } })).toThrow(AtlassianCredentialCustodyError);
    expect(deps.beforeDispatch).not.toHaveBeenCalled();
    expect(deps.credentials.resolveForExecution).not.toHaveBeenCalled();
  });
});
