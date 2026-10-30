/**
 * The authorization URL the runtime hands back for a human to open (#3903 AC3). Keiko shows it only
 * when it addresses the validated authorization endpoint of the operator's expected issuer and
 * carries the request the MCP authorization profile requires: the code flow, a PKCE S256
 * challenge, a state, the MCP server as the RFC 8707 resource, and a redirect to the runtime's own
 * loopback callback. Anything else is not the authorization the operator accepted.
 */
export const MCP_OAUTH_AUTHORIZATION_REFUSALS = [
  "malformed",
  "endpoint-mismatch",
  "response-type",
  "pkce-missing",
  "state-missing",
  "resource-mismatch",
  "redirect-not-loopback",
  "client-mismatch",
] as const;
export type McpOAuthAuthorizationRefusal = (typeof MCP_OAUTH_AUTHORIZATION_REFUSALS)[number];

export interface McpOAuthAuthorizationExpectation {
  readonly authorizationEndpoint: string;
  readonly serverUrl: string;
  readonly clientId?: string | undefined;
}

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/u;

export function mcpOAuthAuthorizationRefusal(
  value: string,
  expected: McpOAuthAuthorizationExpectation,
): McpOAuthAuthorizationRefusal | undefined {
  if (!URL.canParse(value)) return "malformed";
  const url = new URL(value);
  if (!uniqueAuthorizationParameters(url.searchParams)) return "malformed";
  const endpoint = new URL(expected.authorizationEndpoint);
  if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || url.hash !== "")
    return "endpoint-mismatch";
  return requestRefusal(url.searchParams, expected);
}

function uniqueAuthorizationParameters(query: URLSearchParams): boolean {
  return [
    "response_type",
    "client_id",
    "redirect_uri",
    "state",
    "code_challenge",
    "code_challenge_method",
    "resource",
    "scope",
  ].every((name) => query.getAll(name).length <= 1);
}

// The authorization request itself, in the order a reader checks it.
function requestRefusal(
  query: URLSearchParams,
  expected: McpOAuthAuthorizationExpectation,
): McpOAuthAuthorizationRefusal | undefined {
  const checks: readonly (readonly [boolean, McpOAuthAuthorizationRefusal])[] = [
    [query.get("response_type") === "code", "response-type"],
    [
      query.get("code_challenge_method") === "S256" &&
        PKCE_CHALLENGE.test(query.get("code_challenge") ?? ""),
      "pkce-missing",
    ],
    [(query.get("state") ?? "").length > 0, "state-missing"],
    [query.get("resource") === expected.serverUrl, "resource-mismatch"],
    [loopbackCallback(query.get("redirect_uri")), "redirect-not-loopback"],
    [clientMatches(query.get("client_id"), expected.clientId), "client-mismatch"],
  ];
  return checks.find(([passed]) => !passed)?.[1];
}

function clientMatches(client: string | null, expected: string | undefined): boolean {
  return client !== null && client.length > 0 && (expected === undefined || client === expected);
}

// The runtime's own listener: plain http on the IPv4 loopback, an explicit port, its callback path.
function loopbackCallback(value: string | null): boolean {
  if (value === null || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port !== "" &&
    url.pathname === "/callback" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}
