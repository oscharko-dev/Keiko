import { describe, expect, it } from "vitest";
import { isJiraDataCenterCompatibilityFacts } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  verifyJiraDataCenterConnection,
  verifyJiraDataCenterCompatibility,
} from "./jira-connection-verification.js";
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
  it.each([
    [7, 13, 0],
    [8, 3, 0],
    [9, 17, 0],
    [10, 0, 0],
    [10, 2, 99],
  ])(
    "refuses release %s.%s.%s below the supported baseline before identity",
    async (...numbers) => {
      const { port, requests } = fixture([
        response({ ...version, version: numbers.join("."), versionNumbers: numbers }),
        response(user),
      ]);
      expect(await verifyJiraDataCenterCompatibility(port, "https://jira.example")).toEqual({
        status: "unsupported-version",
      });
      expect(requests).toHaveLength(1);
      expect(
        isJiraDataCenterCompatibilityFacts({
          schemaVersion: 1,
          deploymentType: "Server",
          versionNumbers: numbers,
          restApi: "v2",
          agileApi: "unverified",
        }),
      ).toBe(false);
    },
  );

  it.each(["Server", "Data Center"])(
    "retains only observed compatibility for %s",
    async (deploymentType) => {
      const { port } = fixture([
        response({ ...version, deploymentType, serverTitle: "Private project name" }),
        response(user),
      ]);
      expect(await verifyJiraDataCenterCompatibility(port, "https://jira.example")).toEqual({
        status: "ok",
        compatibility: {
          schemaVersion: 1,
          deploymentType,
          versionNumbers: [10, 3, 26],
          restApi: "v2",
          agileApi: "unverified",
        },
      });
    },
  );

  it.each([
    { version: "11.3.13", versionNumbers: [10, 3, 26] },
    { version: "11.3.13-SNAPSHOT", versionNumbers: [11, 3, 13] },
    { version: "011.3.13", versionNumbers: [11, 3, 13] },
    { version: "11.3.13", versionNumbers: [11, 3, 13, 0] },
    { version: "11.3", versionNumbers: [11, 3] },
    { version: "0.3.13", versionNumbers: [0, 3, 13] },
    { version: "11.-3.13", versionNumbers: [11, -3, 13] },
    { version: "11.3.1.3", versionNumbers: [11, 3, 1.3] },
    { version: "11.3.13", versionNumbers: ["11", 3, 13] },
    { version: "9007199254740992.3.13", versionNumbers: [Number.MAX_SAFE_INTEGER + 1, 3, 13] },
  ])("does not infer compatibility from incoherent release metadata %j", async (release) => {
    const { port, requests } = fixture([response({ ...version, ...release }), response(user)]);
    expect(await verifyJiraDataCenterCompatibility(port, "https://jira.example")).toEqual({
      status: "unsupported-version",
    });
    expect(requests).toHaveLength(1);
  });

  it("discards server facts when identity verification fails", async () => {
    const { port } = fixture([response(version), response({}, 401)]);
    expect(await verifyJiraDataCenterCompatibility(port, "https://jira.example")).toEqual({
      status: "auth-failed",
    });
  });

  it("does not request identity after the shared verification deadline", async () => {
    let now = 0;
    const requests: AtlassianHttpBodyRequest[] = [];
    const port: AtlassianHttpBodyPort = (request) => {
      requests.push(request);
      now = 30_000;
      return Promise.resolve(response(version));
    };
    expect(
      await verifyJiraDataCenterCompatibility(port, "https://jira.example", () => now),
    ).toEqual({
      status: "timeout",
    });
    expect(requests).toHaveLength(1);
  });

  it("refuses an invalid target before probing", async () => {
    const { port, requests } = fixture([]);
    await expect(
      verifyJiraDataCenterCompatibility(port, "http://jira.example"),
    ).rejects.toMatchObject({
      code: "invalid-input",
    });
    expect(requests).toHaveLength(0);
  });

  it.each([
    [10, 3, 0],
    [10, 3, 27],
    [10, 4, 0],
    [11, 2, 1],
    [11, 3, 13],
    [12, 0, 0],
  ])("verifies REST v2 identity on coherent release %s.%s.%s", async (...numbers) => {
    const { port, requests } = fixture([
      response({ ...version, version: numbers.join("."), versionNumbers: numbers }),
      response(user),
    ]);
    expect(await verifyJiraDataCenterConnection(port, "https://jira.example/context")).toBe("ok");
    expect(requests).toHaveLength(2);
  });

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
