import { isCommandAllowed } from "@oscharko-dev/keiko-tools";
import { describe, expect, it } from "vitest";

import {
  buildCodeContextPack,
  buildGitHubCodeContextArgv,
  buildGitHubCodeContextCommentsArgv,
  type CodeContextConnector,
  type CodeContextRawObject,
  type CodeContextRef,
  type CodeContextReadRequest,
} from "./codeContextConnector.js";
import {
  createGitHubCodeContextConnector,
  GITHUB_CODE_CONTEXT_COMMAND_RULES,
  gitHubCodeContextArgvIsGoverned,
} from "./githubCodeContextConnector.js";
import {
  buildJiraCodeContextRequest,
  createJiraCodeContextConnector,
} from "./jiraCodeContextConnector.js";

function request(overrides: Partial<CodeContextReadRequest> = {}): CodeContextReadRequest {
  return {
    runId: "run-1989",
    effectiveMode: "supervised-coding",
    connectorScopes: ["source-control.read", "issue-tracker.read"],
    refs: [
      {
        source: "github",
        objectKind: "issue",
        ownerAndRepo: "oscharko-dev/Keiko",
        objectId: "1989",
      },
      {
        source: "jira",
        objectKind: "issue",
        projectKey: "KEIKO",
        objectId: "42",
      },
    ],
    maxBodyBytes: 64,
    ...overrides,
  };
}

interface ConnectorHarness {
  readonly connector: CodeContextConnector;
  callCount(): number;
}

function connector(source: "github" | "jira"): ConnectorHarness {
  const calls: CodeContextRef[] = [];
  return {
    connector: {
      read: (ref): Promise<CodeContextRawObject> => {
        calls.push(ref);
        return Promise.resolve({
          source,
          objectKind: ref.objectKind,
          objectId: ref.objectId,
          title: `${source} title`,
          body: `raw ${source} body with https://private.example.local/path and token=secret-value`,
          comments: [
            { id: `${source}-comment-1`, body: `comment body for ${source}` },
            { id: `${source}-comment-2`, body: "second comment" },
          ],
          url: "https://private.example.local/browse/PRIVATE-1",
        });
      },
    },
    callCount: (): number => calls.length,
  };
}

describe("CodeContextConnector", () => {
  it("builds one untrusted context pack through the unified GitHub and Jira read seam", async () => {
    const github = connector("github");
    const jira = connector("jira");

    const result = await buildCodeContextPack(request(), {
      connectors: { github: github.connector, jira: jira.connector },
      connectorConfig: {
        github_connector_authorized: true,
        jira_connector_authorized: true,
      },
      nowIso: () => "2026-07-07T15:30:00.000Z",
    });

    expect(result.status).toBe("ready");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      source: "github",
      untrusted: true,
      label: "untrusted-source-control-issue-1989",
      bodyTruncated: true,
    });
    expect(result.items[1]).toMatchObject({
      source: "jira",
      untrusted: true,
      label: "untrusted-issue-tracker-issue-42",
    });
    expect(github.callCount()).toBe(1);
    expect(jira.callCount()).toBe(1);
  });

  it("blocks GitHub context before the connector runs when source-control scope is missing", async () => {
    const github = connector("github");
    const result = await buildCodeContextPack(
      request({
        connectorScopes: ["issue-tracker.read"],
        refs: [
          {
            source: "github",
            objectKind: "pull-request",
            ownerAndRepo: "oscharko-dev/Keiko",
            objectId: "2069",
          },
        ],
      }),
      {
        connectors: { github: github.connector, jira: connector("jira").connector },
        connectorConfig: { github_connector_authorized: true },
        nowIso: () => "2026-07-07T15:30:00.000Z",
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.blocked).toEqual([
      {
        source: "github",
        objectKind: "pull-request",
        objectId: "2069",
        reason: "missing-scope",
        requiredScope: "source-control.read",
      },
    ]);
    expect(github.callCount()).toBe(0);
  });

  it("defaults Jira authorization to false even when issue-tracker scope is present", async () => {
    const jira = connector("jira");

    const result = await buildCodeContextPack(
      request({
        connectorScopes: ["issue-tracker.read"],
        refs: [{ source: "jira", objectKind: "issue", projectKey: "KEIKO", objectId: "42" }],
      }),
      {
        connectors: { github: connector("github").connector, jira: jira.connector },
        connectorConfig: {},
        nowIso: () => "2026-07-07T15:30:00.000Z",
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.blocked[0]).toMatchObject({
      source: "jira",
      reason: "missing-credentials",
      requiredScope: "issue-tracker.read",
    });
    expect(jira.callCount()).toBe(0);
  });

  it("keeps evidence content-free while hashing raw connector bodies", async () => {
    const [githubRef] = request().refs;
    const result = await buildCodeContextPack(
      request({ refs: githubRef === undefined ? [] : [githubRef] }),
      {
        connectors: { github: connector("github").connector, jira: connector("jira").connector },
        connectorConfig: { github_connector_authorized: true },
        nowIso: () => "2026-07-07T15:30:00.000Z",
      },
    );

    const evidenceJson = JSON.stringify(result.evidence);
    expect(result.evidence).toMatchObject({
      schemaVersion: "1",
      runId: "run-1989",
      status: "ready",
      sourceCounts: { github: 1, jira: 0 },
      objectCount: 1,
      blockedCount: 0,
      commentCount: 2,
      safeSummary: "connector-read",
    });
    expect(result.evidence.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidenceJson).not.toContain("raw github body");
    expect(evidenceJson).not.toContain("private.example.local");
    expect(evidenceJson).not.toContain("secret-value");
  });

  it("builds a constrained read-only gh api argv for GitHub context", () => {
    expect(
      buildGitHubCodeContextArgv({
        source: "github",
        objectKind: "issue",
        ownerAndRepo: "oscharko-dev/Keiko",
        objectId: "1989",
      }),
    ).toEqual([
      "api",
      "/repos/oscharko-dev/Keiko/issues/1989",
      "--jq",
      "{title:.title,body:.body,comments:.comments,url:.html_url}",
    ]);
    expect(
      buildGitHubCodeContextCommentsArgv({
        source: "github",
        objectKind: "pull-request",
        ownerAndRepo: "oscharko-dev/Keiko",
        objectId: "2069",
      }),
    ).toEqual([
      "api",
      "/repos/oscharko-dev/Keiko/issues/2069/comments?per_page=50",
      "--jq",
      "[.[]|{id:(.id|tostring),body:.body}]",
    ]);
  });

  it("rejects malformed GitHub refs before any gh api argv can be built", () => {
    expect(() =>
      buildGitHubCodeContextArgv({
        source: "github",
        objectKind: "issue",
        ownerAndRepo: "oscharko-dev/Keiko --paginate",
        objectId: "1989",
      }),
    ).toThrow("ownerAndRepo must match");
  });

  it("keeps GitHub context reads on a dedicated read-only gh api command allowlist", () => {
    const argv = buildGitHubCodeContextArgv({
      source: "github",
      objectKind: "issue",
      ownerAndRepo: "oscharko-dev/Keiko",
      objectId: "1989",
    });

    expect(isCommandAllowed(GITHUB_CODE_CONTEXT_COMMAND_RULES, "gh", argv)).toMatchObject({
      allowed: true,
    });
    expect(
      isCommandAllowed(GITHUB_CODE_CONTEXT_COMMAND_RULES, "gh", ["api", "/repos/o/r/issues/1"]),
    ).toMatchObject({ allowed: true });
    expect(
      isCommandAllowed(GITHUB_CODE_CONTEXT_COMMAND_RULES, "gh", [
        "api",
        "/repos/o/r/issues/1",
        "--paginate",
      ]),
    ).toMatchObject({ allowed: false });
    expect(
      isCommandAllowed(GITHUB_CODE_CONTEXT_COMMAND_RULES, "gh", [
        "api",
        "/repos/o/r/issues/1",
        "-f",
        "body=mutation",
      ]),
    ).toMatchObject({ allowed: false });
  });

  it("blocks connector reads when the deployment mode ceiling excludes the request mode", async () => {
    const github = connector("github");

    const result = await buildCodeContextPack(
      request({
        effectiveMode: "autonomous-delivery",
        refs: [
          {
            source: "github",
            objectKind: "issue",
            ownerAndRepo: "oscharko-dev/Keiko",
            objectId: "1989",
          },
        ],
      }),
      {
        connectors: { github: github.connector, jira: connector("jira").connector },
        connectorConfig: {
          coding_context_allowed_modes: ["governed-assist", "supervised-coding"],
          github_connector_authorized: true,
        },
        nowIso: () => "2026-07-07T15:30:00.000Z",
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.evidence).toMatchObject({ status: "blocked", blockedCount: 1 });
    expect(result.blocked[0]).toMatchObject({
      source: "github",
      reason: "mode-ceiling",
      requiredScope: "source-control.read",
    });
    expect(github.callCount()).toBe(0);
  });

  it("reads GitHub object and comments through the dedicated gh api connector", async () => {
    const calls: string[][] = [];
    const api = {
      readJson: (argv: readonly string[]): Promise<unknown> => {
        calls.push([...argv]);
        if (argv[1]?.includes("/comments")) {
          return Promise.resolve([{ id: "1001", body: "review context comment" }]);
        }
        return Promise.resolve({
          title: "GitHub context",
          body: "issue body",
          url: "https://github.com/oscharko-dev/Keiko/issues/1989",
        });
      },
    };

    const raw = await createGitHubCodeContextConnector(api).read({
      source: "github",
      objectKind: "issue",
      ownerAndRepo: "oscharko-dev/Keiko",
      objectId: "1989",
    });

    expect(raw).toMatchObject({
      source: "github",
      objectKind: "issue",
      objectId: "1989",
      title: "GitHub context",
      body: "issue body",
      comments: [{ id: "1001", body: "review context comment" }],
    });
    expect(calls).toEqual([
      [
        "api",
        "/repos/oscharko-dev/Keiko/issues/1989",
        "--jq",
        "{title:.title,body:.body,comments:.comments,url:.html_url}",
      ],
      [
        "api",
        "/repos/oscharko-dev/Keiko/issues/1989/comments?per_page=50",
        "--jq",
        "[.[]|{id:(.id|tostring),body:.body}]",
      ],
    ]);
    expect(gitHubCodeContextArgvIsGoverned(calls[0] ?? [])).toBe(true);
  });

  it("builds and reads Jira issue context through the read-only HTTP port", async () => {
    const requests: ReturnType<typeof buildJiraCodeContextRequest>[] = [];
    const http = {
      readJson: (jiraRequest: ReturnType<typeof buildJiraCodeContextRequest>): Promise<unknown> => {
        requests.push(jiraRequest);
        return Promise.resolve({
          fields: {
            summary: "Jira coding context",
            description: { content: [{ content: [{ text: "ADF body text" }] }] },
            comment: {
              comments: [{ id: "2001", body: { content: [{ text: "ADF comment" }] } }],
            },
          },
        });
      },
    };

    const raw = await createJiraCodeContextConnector(http).read({
      source: "jira",
      objectKind: "issue",
      projectKey: "KEIKO",
      objectId: "42",
    });

    expect(requests).toEqual([
      {
        method: "GET",
        path: "/rest/api/3/issue/KEIKO-42",
        query: { fields: "summary,description,comment" },
      },
    ]);
    expect(raw).toMatchObject({
      source: "jira",
      objectKind: "issue",
      objectId: "42",
      title: "Jira coding context",
      body: "ADF body text",
      comments: [{ id: "2001", body: "ADF comment" }],
    });
  });
});
