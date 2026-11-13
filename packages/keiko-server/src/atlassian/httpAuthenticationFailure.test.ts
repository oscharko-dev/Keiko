import { describe, expect, it } from "vitest";
import type { AtlassianResolvedCredential } from "@oscharko-dev/keiko-connectors";
import {
  authenticationMarkerHeaders,
  classifyAuthenticationFailure,
} from "./httpAuthenticationFailure.js";
import { createGatewayAtlassianHttpBodyPort, createGatewayAtlassianHttpPort } from "./httpPort.js";

// Observed on the laboratory Jira Data Center 10.3 (read-only requests, no credential of a
// person): a missing or unknown bearer token, which is also how an expired or a revoked personal
// access token looks to Jira, answers 401 with `X-AREQUESTID`, `X-AUSERNAME: anonymous`,
// `WWW-Authenticate: OAuth realm=…`, a JSON content type and the body
// `{"message":"Client must be authenticated to access this resource.","status-code":401,…}`.
const JIRA_AUTHORED = { "X-AREQUESTID": "740x4743x1", "X-AUSERNAME": "anonymous" };
const SHAPES: readonly (readonly [string, number, Record<string, string>, string | undefined])[] = [
  ["a Jira-authored 401 (unknown, expired or revoked token)", 401, JIRA_AUTHORED, "jira"],
  [
    "a Jira 401 that refuses the login for another reason (captcha challenge)",
    401,
    { ...JIRA_AUTHORED, "X-Authentication-Denied-Reason": "CAPTCHA_CHALLENGE; login-url=x" },
    "denied",
  ],
  [
    "a single sign-on proxy's 401 with an HTML body",
    401,
    { "Content-Type": "text/html" },
    "foreign",
  ],
  ["an empty gateway 401", 401, {}, "foreign"],
  [
    "a proxy 401 imitating only the anonymous marker",
    401,
    { "X-AUSERNAME": "anonymous" },
    "foreign",
  ],
  ["a 403", 403, JIRA_AUTHORED, undefined],
  ["a 200", 200, JIRA_AUTHORED, undefined],
];

describe("closed 401 origin fact", () => {
  it.each(SHAPES)("classifies %s", (_name, status, headers, expected) => {
    expect(classifyAuthenticationFailure(status, new Headers(headers))).toBe(expected);
  });
  it("keeps only the three marker headers when an anonymous success is rewritten", () => {
    const kept = authenticationMarkerHeaders(
      new Headers({ ...JIRA_AUTHORED, "Set-Cookie": "secret=1", "X-Other": "x" }),
    );
    expect([...kept.keys()].sort()).toEqual(["x-arequestid", "x-ausername"]);
  });
});

function ports(
  headers: Record<string, string>,
  status: number,
  body = "{}",
): {
  readonly body: ReturnType<typeof createGatewayAtlassianHttpBodyPort>;
  readonly plain: ReturnType<typeof createGatewayAtlassianHttpPort>;
  readonly request: {
    readonly method: "GET";
    readonly url: string;
    readonly timeoutMs: number;
    readonly maxBodyBytes: number;
  };
} {
  const options = {
    baseUrl: "https://jira.example",
    authRef: "atlassian-cred:synthetic-reference",
    credentials: {
      resolveForExecution: (): AtlassianResolvedCredential => ({
        scheme: "bearer-pat",
        apiToken: "synthetic-token",
      }),
    },
    fetchImpl: (): Promise<Response> => Promise.resolve(new Response(body, { status, headers })),
  };
  const request = {
    method: "GET" as const,
    url: "https://jira.example/rest/api/2/project",
    timeoutMs: 1000,
    maxBodyBytes: 1024,
  };
  return {
    body: createGatewayAtlassianHttpBodyPort(options),
    plain: createGatewayAtlassianHttpPort(options),
    request,
  };
}

describe("the transport exposes the fact, never a header value", () => {
  it.each(SHAPES.filter(([, status]) => status === 401))(
    "projects %s on both ports",
    async (_name, status, headers, expected) => {
      const { body, plain, request } = ports(headers, status);
      const withBody = await body(request);
      const bodyless = await plain({ method: "GET", url: request.url, timeoutMs: 1000 });
      expect(withBody).toMatchObject({ kind: "response", status, authenticationFailure: expected });
      expect(bodyless).toMatchObject({ kind: "response", status, authenticationFailure: expected });
      expect(JSON.stringify([withBody, bodyless])).not.toMatch(/740x4743x1|CAPTCHA|login-url/u);
    },
  );
  it("keeps an anonymous success Jira-authored when it is rewritten into a 401", async () => {
    const { body, request } = ports(JIRA_AUTHORED, 200, "[]");
    expect(await body(request)).toMatchObject({ status: 401, authenticationFailure: "jira" });
    const proxy = ports({ "X-AUSERNAME": "anonymous" }, 200, "[]");
    expect(await proxy.body(proxy.request)).toMatchObject({
      status: 401,
      authenticationFailure: "foreign",
    });
  });
  it("carries no fact on a success or a 403", async () => {
    for (const [status, headers] of [
      [200, { "X-AREQUESTID": "740x4743x1" }],
      [403, JIRA_AUTHORED],
    ] as const) {
      const { body, request } = ports(headers, status);
      expect(await body(request)).not.toHaveProperty("authenticationFailure");
    }
  });
});
