import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import { isCommandAllowed } from "@oscharko-dev/keiko-tools";
import { describe, expect, it } from "vitest";

import {
  buildCodeContextPack,
  GITHUB_CODE_CONTEXT_OBJECT_JQ,
  buildGitHubCodeContextArgv,
  buildGitHubCodeContextCommentsArgv,
  type CodeContextConnector,
  type CodeContextRawObject,
  type CodeContextRef,
  type CodeContextReadRequest,
} from "./codeContextConnector.js";
import {
  createGitHubCodeContextConnector,
  gitHubCodeContextArgvIsGoverned,
} from "./githubCodeContextConnector.js";
import { GH_CODE_CONTEXT_COMMAND_RULES } from "./githubCodeContextPort.js";
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
  // CWE-863: the grant is stored against a LOCAL checkout while the request names the REMOTE
  // repository freely, so "authorized" used to mean "may read GitHub" rather than "may read THIS
  // repository" — a grant for one checkout admitted any repository the credentials could reach.
  // `github_allowed_owner_and_repo` is the checkout's own resolved remote; a ref naming anything
  // else is refused before the connector is called.
  it("refuses a GitHub ref that names a repository the grant does not cover", async () => {
    const calls: string[] = [];
    const pack = await buildCodeContextPack(
      {
        runId: "run-bypass",
        effectiveMode: "autonomous-delivery",
        connectorScopes: ["source-control.read"],
        refs: [
          {
            source: "github",
            objectKind: "issue",
            ownerAndRepo: "attacker/private",
            objectId: "1",
          },
        ],
        maxBodyBytes: 4096,
      },
      {
        connectors: {
          github: {
            read: (ref): Promise<CodeContextRawObject> => {
              calls.push(ref.source);
              return Promise.resolve({
                source: ref.source,
                objectKind: ref.objectKind,
                objectId: ref.objectId,
                title: "leaked",
                body: "leaked",
                comments: [],
              });
            },
          },
          jira: { read: () => Promise.reject(new Error("unused")) },
        },
        connectorConfig: {
          github_connector_authorized: true,
          github_allowed_owner_and_repo: "oscharko-dev/Keiko",
        },
        nowIso: () => "2026-09-04T00:00:00.000Z",
      },
    );

    expect(calls).toEqual([]);
    expect(pack.items).toHaveLength(0);
    expect(pack.blocked).toContainEqual(
      expect.objectContaining({ source: "github", reason: "missing-credentials" }),
    );
  });

  it("accepts the covered repository regardless of owner and name casing", async () => {
    const calls: string[] = [];
    const pack = await buildCodeContextPack(
      {
        runId: "run-casing",
        effectiveMode: "autonomous-delivery",
        connectorScopes: ["source-control.read"],
        refs: [
          {
            source: "github",
            objectKind: "issue",
            ownerAndRepo: "OsCharko-Dev/KEIKO",
            objectId: "7",
          },
        ],
        maxBodyBytes: 4096,
      },
      {
        connectors: {
          github: {
            read: (ref): Promise<CodeContextRawObject> => {
              if (ref.source !== "github") throw new Error("unexpected jira read");
              calls.push(ref.ownerAndRepo);
              return Promise.resolve({
                source: ref.source,
                objectKind: ref.objectKind,
                objectId: ref.objectId,
                title: "t",
                body: "b",
                comments: [],
              });
            },
          },
          jira: { read: () => Promise.reject(new Error("unused")) },
        },
        connectorConfig: {
          github_connector_authorized: true,
          github_allowed_owner_and_repo: "oscharko-dev/Keiko",
        },
        nowIso: () => "2026-09-04T00:00:00.000Z",
      },
    );

    expect(calls).toEqual(["OsCharko-Dev/KEIKO"]);
    expect(pack.items).toHaveLength(1);
  });

  it("refuses every GitHub ref when the checkout resolves no covered repository", async () => {
    const calls: string[] = [];
    const pack = await buildCodeContextPack(
      {
        runId: "run-no-remote",
        effectiveMode: "autonomous-delivery",
        connectorScopes: ["source-control.read"],
        refs: [
          {
            source: "github",
            objectKind: "issue",
            ownerAndRepo: "oscharko-dev/Keiko",
            objectId: "1",
          },
        ],
        maxBodyBytes: 4096,
      },
      {
        connectors: {
          github: {
            read: (ref): Promise<CodeContextRawObject> => {
              calls.push("called");
              return Promise.resolve({
                source: ref.source,
                objectKind: ref.objectKind,
                objectId: ref.objectId,
                title: "t",
                body: "b",
                comments: [],
              });
            },
          },
          jira: { read: () => Promise.reject(new Error("unused")) },
        },
        // Authorized, but no repository resolved — the fail-closed direction.
        connectorConfig: { github_connector_authorized: true },
        nowIso: () => "2026-09-04T00:00:00.000Z",
      },
    );

    expect(calls).toEqual([]);
    expect(pack.items).toHaveLength(0);
  });

  it("builds one untrusted context pack through the unified GitHub and Jira read seam", async () => {
    const github = connector("github");
    const jira = connector("jira");

    const result = await buildCodeContextPack(request(), {
      connectors: { github: github.connector, jira: jira.connector },
      connectorConfig: {
        github_connector_authorized: true,
        github_allowed_owner_and_repo: "oscharko-dev/Keiko",
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
        connectorConfig: {
          github_connector_authorized: true,
          github_allowed_owner_and_repo: "oscharko-dev/Keiko",
        },
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
        connectorConfig: {
          github_connector_authorized: true,
          github_allowed_owner_and_repo: "oscharko-dev/Keiko",
        },
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
      GITHUB_CODE_CONTEXT_OBJECT_JQ,
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
    expect(() =>
      buildGitHubCodeContextArgv({
        source: "github",
        objectKind: "issue",
        ownerAndRepo: "oscharko-dev/..",
        objectId: "1989",
      }),
    ).toThrow("ownerAndRepo must match");
    expect(() =>
      buildGitHubCodeContextArgv({
        source: "github",
        objectKind: "issue",
        ownerAndRepo: "oscharko-dev/Keiko",
        objectId: "１２",
      }),
    ).toThrow("objectId must be a positive number");
  });

  it("keeps Jira issue numbers ASCII-only and bounded", () => {
    expect(
      buildJiraCodeContextRequest({
        source: "jira",
        objectKind: "issue",
        projectKey: "KEIKO",
        objectId: "9999999999",
      }).path,
    ).toBe("/rest/api/3/issue/KEIKO-9999999999");
    expect(() =>
      buildJiraCodeContextRequest({
        source: "jira",
        objectKind: "issue",
        projectKey: "KEIKO",
        objectId: "１２",
      }),
    ).toThrow("objectId must be a positive Jira issue number");
  });

  it("keeps GitHub context reads on the port-canonical read-only gh api command allowlist (KEIKO-0223)", () => {
    const argv = buildGitHubCodeContextArgv({
      source: "github",
      objectKind: "issue",
      ownerAndRepo: "oscharko-dev/Keiko",
      objectId: "1989",
    });

    expect(isCommandAllowed(GH_CODE_CONTEXT_COMMAND_RULES, "gh", argv)).toMatchObject({
      allowed: true,
    });
    expect(
      isCommandAllowed(GH_CODE_CONTEXT_COMMAND_RULES, "gh", ["api", "/repos/o/r/issues/1"]),
    ).toMatchObject({ allowed: true });
    // Mutation-adjacent flags every canonical rule denies — the earlier connector-owned
    // duplicate admitted `--method` / `-X` / `--hostname` via `valueFlags`; the canonical rule
    // set (this one) denies them outright.
    for (const denied of ["--method", "-X", "--hostname", "-f", "-F", "--input", "--verbose"]) {
      expect(
        isCommandAllowed(GH_CODE_CONTEXT_COMMAND_RULES, "gh", [
          "api",
          "/repos/o/r/issues/1",
          denied,
          "body=mutation",
        ]),
      ).toMatchObject({ allowed: false });
    }
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
          github_allowed_owner_and_repo: "oscharko-dev/Keiko",
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
      ["api", "/repos/oscharko-dev/Keiko/issues/1989", "--jq", GITHUB_CODE_CONTEXT_OBJECT_JQ],
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
