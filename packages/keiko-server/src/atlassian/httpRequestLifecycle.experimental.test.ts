import { describe, expect, it, vi } from "vitest";
import {
  AtlassianCredentialCustodyError,
  type AtlassianHttpBodyRequest,
} from "@oscharko-dev/keiko-connectors";
import { atlassianHttpRequestLifecycle } from "./httpRequestLifecycle.js";

const REQUEST: AtlassianHttpBodyRequest = {
  method: "PUT",
  url: "https://jira.example.invalid/context/rest/agile/1.0/sprint/unmap",
  timeoutMs: 1000,
  maxBodyBytes: 1024,
  bodyJson: '{"sprintIds":[12]}',
};
function options() {
  return {
    authRef: "synthetic-credential-reference",
    correlationId: "experimental-transport",
    beforeDispatch: vi.fn(() => true),
    credentials: {
      resolveForExecution: vi.fn(() => ({
        scheme: "bearer-pat" as const,
        apiToken: "synthetic-experimental-token",
      })),
    },
  };
}
/** Exercise hostile runtime values without relaxing the production request contract. */
function requestWithFlag(value: unknown): AtlassianHttpBodyRequest {
  const request = { ...REQUEST };
  Reflect.set(request, "jiraExperimental", value);
  return request;
}

describe("experimental Jira header custody", () => {
  it.each(["unmap", "unmap-all"])("materialises the single fixed header for PUT %s", (suffix) => {
    const deps = options();
    const request = {
      ...REQUEST,
      jiraExperimental: true as const,
      url: `https://jira.example.invalid/context/rest/agile/1.0/sprint/${suffix}`,
    };
    const lifecycle = atlassianHttpRequestLifecycle(deps, request);
    expect(deps.beforeDispatch).not.toHaveBeenCalled();
    expect(deps.credentials.resolveForExecution).not.toHaveBeenCalled();
    const headers = lifecycle.prepareHeaders();
    expect(headers.get("x-experimentalapi")).toBe("true");
    expect(headers.get("content-type")).toBe("application/json");
    expect(deps.beforeDispatch).toHaveBeenCalledExactlyOnceWith(request);
    expect(deps.credentials.resolveForExecution).toHaveBeenCalledExactlyOnceWith(deps.authRef);
  });

  it.each([false, "true", 1, null, {}])(
    "refuses non-literal opt-in %j before admission and custody",
    (value) => {
      const deps = options();
      expect(() => atlassianHttpRequestLifecycle(deps, requestWithFlag(value))).toThrow(
        AtlassianCredentialCustodyError,
      );
      expect(deps.beforeDispatch).not.toHaveBeenCalled();
      expect(deps.credentials.resolveForExecution).not.toHaveBeenCalled();
    },
  );

  it.each([
    { method: "GET", url: REQUEST.url },
    { method: "POST", url: REQUEST.url },
    { method: "DELETE", url: REQUEST.url },
    { method: "PUT", url: "https://jira.example.invalid/rest/agile/1.0/sprint/12" },
    { method: "PUT", url: `${REQUEST.url}?all=true` },
    { method: "PUT", url: `${REQUEST.url}#fragment` },
    { method: "PUT", url: `${REQUEST.url}/` },
    { method: "PUT", url: "http://jira.example.invalid/rest/agile/1.0/sprint/unmap" },
    { method: "PUT", url: "https://user:secret@jira.example.invalid/rest/agile/1.0/sprint/unmap" },
    { method: "PUT", url: "not-a-url" },
  ] as const)("refuses unsupported $method $url before admission", (target) => {
    const deps = options();
    expect(() =>
      atlassianHttpRequestLifecycle(deps, {
        ...REQUEST,
        ...target,
        jiraExperimental: true,
      }),
    ).toThrow(AtlassianCredentialCustodyError);
    expect(deps.beforeDispatch).not.toHaveBeenCalled();
    expect(deps.credentials.resolveForExecution).not.toHaveBeenCalled();
  });

  it("adds no experimental header without the closed opt-in", () => {
    const deps = options();
    const headers = atlassianHttpRequestLifecycle(deps, REQUEST).prepareHeaders();
    expect(headers.has("x-experimentalapi")).toBe(false);
  });

  it("keeps a refused dispatch ahead of credential materialisation", () => {
    const deps = options();
    deps.beforeDispatch.mockReturnValue(false);
    const lifecycle = atlassianHttpRequestLifecycle(deps, { ...REQUEST, jiraExperimental: true });
    expect(() => lifecycle.prepareHeaders()).toThrow(AtlassianCredentialCustodyError);
    expect(deps.credentials.resolveForExecution).not.toHaveBeenCalled();
  });
});
