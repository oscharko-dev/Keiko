import { describe, expect, it } from "vitest";
import { verifyJiraDataCenterConnection } from "./jira-connection-verification.js";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";

function response(body: unknown, status = 200): AtlassianHttpBodyResult {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  return {
    kind: "response",
    status,
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText),
    truncated: false,
  };
}

function fixture(results: readonly AtlassianHttpBodyResult[]): {
  port: AtlassianHttpBodyPort;
  requests: AtlassianHttpBodyRequest[];
} {
  const requests: AtlassianHttpBodyRequest[] = [];
  return {
    requests,
    port: (request): Promise<AtlassianHttpBodyResult> => {
      requests.push(request);
      return Promise.resolve(results[requests.length - 1] ?? { kind: "network-error" });
    },
  };
}

const version = { version: "10.3.26", versionNumbers: [10, 3, 26], deploymentType: "Server" };
const user = { name: "synthetic-user", key: "synthetic-key", active: true };

describe("bounded Jira Data Center verification", () => {
  it.each(["", "/jira", "/jira/"])(
    "validates both REST v2 responses under context %s",
    async (path) => {
      const { port, requests } = fixture([response(version), response(user)]);
      expect(await verifyJiraDataCenterConnection(port, `https://jira.example${path}`)).toBe("ok");
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        `${path.replace(/\/$/, "")}/rest/api/2/serverInfo`,
        `${path.replace(/\/$/, "")}/rest/api/2/myself`,
      ]);
      expect(
        requests.every((request) => request.maxBodyBytes === 65536 && request.timeoutMs <= 30000),
      ).toBe(true);
    },
  );

  it.each([
    [response("<html>login</html>"), "invalid-response"],
    [response({}, 302), "redirect-refused"],
    [response({}, 401), "auth-failed"],
    [response({}, 403), "forbidden"],
    [response({ ...version, version: "9.0.0" }), "unsupported-version"],
    [response({ ...version, deploymentType: "Cloud" }), "unsupported-version"],
    [response({}), "invalid-response"],
    [{ kind: "timeout" }, "timeout"],
    [{ kind: "network-error", reason: "tls" }, "tls-failed"],
    [{ kind: "network-error" }, "unreachable"],
  ] as const)(
    "refuses a failed first probe without requesting identity",
    async (result, expected) => {
      const { port, requests } = fixture([result]);
      expect(await verifyJiraDataCenterConnection(port, "https://jira.example")).toBe(expected);
      expect(requests).toHaveLength(1);
    },
  );

  it.each([
    response("<html>login</html>"),
    response({}),
    response({ ...user, active: false }),
    { ...response(user), truncated: true },
  ])("never treats invalid identity evidence as verified", async (identity) => {
    const { port } = fixture([response(version), identity]);
    expect(await verifyJiraDataCenterConnection(port, "https://jira.example")).toBe(
      "invalid-response",
    );
  });
});
