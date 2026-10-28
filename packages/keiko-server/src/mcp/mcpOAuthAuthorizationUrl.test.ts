import { describe, expect, it } from "vitest";
import { mcpOAuthAuthorizationRefusal } from "./mcpOAuthAuthorizationUrl.js";

const EXPECTED = {
  authorizationEndpoint: "https://login.example.test/tenant/authorize",
  serverUrl: "https://issues.example.test/mcp",
} as const;
const CHALLENGE = "ie52-7QwMw-CfISp4KUQQ1xfC8dFYe0C0Hv1UV6hi04";

function authorizationUrl(
  overrides: Readonly<Record<string, string | undefined>> = {},
  base: string = EXPECTED.authorizationEndpoint,
): string {
  const url = new URL(base);
  const parameters: Readonly<Record<string, string | undefined>> = {
    response_type: "code",
    client_id: "dyn-client",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    redirect_uri: "http://127.0.0.1:65374/callback",
    state: "61Sv1crbA5peVh3OvD3L7QY6vr33m_PHrFMD06R7Obo",
    resource: EXPECTED.serverUrl,
    ...overrides,
  };
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.href;
}

describe("the authorization URL the runtime hands back (#3903 AC3)", () => {
  it("accepts the runtime's own PKCE request to the validated endpoint", () => {
    expect(mcpOAuthAuthorizationRefusal(authorizationUrl(), EXPECTED)).toBeUndefined();
    expect(
      mcpOAuthAuthorizationRefusal(authorizationUrl({ client_id: "keiko" }), {
        ...EXPECTED,
        clientId: "keiko",
      }),
    ).toBeUndefined();
  });

  it.each([
    ["not a URL", "::", "malformed"],
    [
      "another host",
      authorizationUrl({}, "https://evil.example.test/tenant/authorize"),
      "endpoint-mismatch",
    ],
    [
      "another path",
      authorizationUrl({}, "https://login.example.test/other/authorize"),
      "endpoint-mismatch",
    ],
    [
      "plain http",
      authorizationUrl({}, "http://login.example.test/tenant/authorize"),
      "endpoint-mismatch",
    ],
    ["the implicit flow", authorizationUrl({ response_type: "token" }), "response-type"],
    ["a plain challenge", authorizationUrl({ code_challenge_method: "plain" }), "pkce-missing"],
    ["no challenge", authorizationUrl({ code_challenge: undefined }), "pkce-missing"],
    ["no state", authorizationUrl({ state: undefined }), "state-missing"],
    [
      "another resource",
      authorizationUrl({ resource: "https://evil.example.test/mcp" }),
      "resource-mismatch",
    ],
    ["no resource", authorizationUrl({ resource: undefined }), "resource-mismatch"],
    [
      "a remote redirect",
      authorizationUrl({ redirect_uri: "https://evil.example.test/callback" }),
      "redirect-not-loopback",
    ],
    [
      "a loopback name",
      authorizationUrl({ redirect_uri: "http://localhost:65374/callback" }),
      "redirect-not-loopback",
    ],
    [
      "another callback path",
      authorizationUrl({ redirect_uri: "http://127.0.0.1:65374/steal" }),
      "redirect-not-loopback",
    ],
    ["no client", authorizationUrl({ client_id: undefined }), "client-mismatch"],
  ])("refuses %s", (_label, url, reason) => {
    expect(mcpOAuthAuthorizationRefusal(url, EXPECTED)).toBe(reason);
  });

  it("refuses another client than the operator registered", () => {
    expect(
      mcpOAuthAuthorizationRefusal(authorizationUrl(), { ...EXPECTED, clientId: "keiko" }),
    ).toBe("client-mismatch");
  });
});
