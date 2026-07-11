// Issue #2241 — verify-connection probe tests. Hermetic: an injected fake port records every
// request so the single-request / configured-base-URL-only invariants are asserted directly.

import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_VERIFY_CONNECTION_PATHS,
  ATLASSIAN_VERIFY_CONNECTION_TIMEOUT_MS,
  buildAtlassianVerificationRequest,
  isAtlassianConnectionVerificationStatus,
  verifyAtlassianConnection,
} from "./atlassian-connection-verification.js";
import { AtlassianCredentialCustodyError } from "./atlassian-credential-custody.js";
import type {
  AtlassianHttpPort,
  AtlassianHttpRequest,
  AtlassianHttpResult,
} from "./atlassian-http-port.js";

function recordingPort(result: AtlassianHttpResult): {
  readonly port: AtlassianHttpPort;
  readonly requests: AtlassianHttpRequest[];
} {
  const requests: AtlassianHttpRequest[] = [];
  const port: AtlassianHttpPort = (request) => {
    requests.push(request);
    return Promise.resolve(result);
  };
  return { port, requests };
}

describe("buildAtlassianVerificationRequest", () => {
  it("targets the provider-specific current-user endpoint with the D3 timeout", () => {
    const jira = buildAtlassianVerificationRequest({
      provider: "jira",
      baseUrl: "https://acme.example",
    });
    expect(jira.url).toBe("https://acme.example/rest/api/3/myself");
    expect(jira.method).toBe("GET");
    expect(jira.timeoutMs).toBe(ATLASSIAN_VERIFY_CONNECTION_TIMEOUT_MS);
    expect(ATLASSIAN_VERIFY_CONNECTION_TIMEOUT_MS).toBe(30_000);

    const confluence = buildAtlassianVerificationRequest({
      provider: "confluence",
      baseUrl: "https://acme.example",
    });
    expect(confluence.url).toBe("https://acme.example/wiki/rest/api/user/current");
  });

  it("preserves a base path (Data Center context path) beneath the origin", () => {
    const withPath = buildAtlassianVerificationRequest({
      provider: "jira",
      baseUrl: "https://acme.example/jira",
    });
    expect(withPath.url).toBe("https://acme.example/jira/rest/api/3/myself");
    const withTrailingSlash = buildAtlassianVerificationRequest({
      provider: "jira",
      baseUrl: "https://acme.example/jira/",
    });
    expect(withTrailingSlash.url).toBe("https://acme.example/jira/rest/api/3/myself");
  });

  it.each([
    ["http scheme", "http://acme.example"],
    ["userinfo", "https://user:pw@acme.example"],
    ["query", "https://acme.example?q=1"],
    ["fragment", "https://acme.example#f"],
    ["whitespace", "https://acme .example"],
    ["not a URL", "acme"],
  ])("fails closed on an unsafe base URL (%s) without contacting the port", (_label, baseUrl) => {
    expect(() => buildAtlassianVerificationRequest({ provider: "jira", baseUrl })).toThrow(
      AtlassianCredentialCustodyError,
    );
  });

  it("fails closed on an unknown provider", () => {
    expect(() =>
      buildAtlassianVerificationRequest({
        provider: "bitbucket" as unknown as "jira",
        baseUrl: "https://acme.example",
      }),
    ).toThrow(AtlassianCredentialCustodyError);
  });
});

describe("verifyAtlassianConnection — closed status union", () => {
  it.each([
    [200, "ok"],
    [204, "ok"],
    [401, "auth-failed"],
    [403, "forbidden"],
    [302, "unreachable"],
    [301, "unreachable"],
    [404, "unreachable"],
    [429, "unreachable"],
    [500, "unreachable"],
  ])("maps HTTP %i to %s", async (status, expected) => {
    const { port, requests } = recordingPort({ kind: "response", status });
    const outcome = await verifyAtlassianConnection(port, {
      provider: "jira",
      baseUrl: "https://acme.example",
    });
    expect(outcome).toBe(expected);
    expect(isAtlassianConnectionVerificationStatus(outcome)).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("maps a transport timeout to timeout", async () => {
    const { port } = recordingPort({ kind: "timeout" });
    await expect(
      verifyAtlassianConnection(port, { provider: "jira", baseUrl: "https://acme.example" }),
    ).resolves.toBe("timeout");
  });

  it("maps a network refusal to unreachable", async () => {
    const { port } = recordingPort({ kind: "network-error" });
    await expect(
      verifyAtlassianConnection(port, { provider: "confluence", baseUrl: "https://acme.example" }),
    ).resolves.toBe("unreachable");
  });

  it("contacts ONLY the configured base URL, exactly once, on the base host", async () => {
    const { port, requests } = recordingPort({ kind: "response", status: 302 });
    await verifyAtlassianConnection(port, {
      provider: "confluence",
      baseUrl: "https://docs.acme.example",
    });
    // A 3xx is never followed (redirect fail-closed, ADR-0128 D3): one request, base host only.
    expect(requests).toHaveLength(1);
    const target = new URL(requests[0]?.url ?? "");
    expect(target.host).toBe("docs.acme.example");
    expect(target.protocol).toBe("https:");
    expect(target.pathname).toBe(ATLASSIAN_VERIFY_CONNECTION_PATHS.confluence);
  });
});
