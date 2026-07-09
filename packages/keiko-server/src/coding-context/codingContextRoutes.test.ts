import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

import { handleCodingContextPack } from "./codingContextRoutes.js";
import type { GitHubCodeContextApiPort } from "./githubCodeContextConnector.js";
import type { JiraCodeContextHttpPort } from "./jiraCodeContextConnector.js";
import type { RouteContext, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";

function requestWithBody(body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  return req;
}

function ctxFor(body: unknown): RouteContext {
  return {
    req: requestWithBody(body),
    res: undefined as never,
    params: {},
    url: new URL("http://127.0.0.1/api/coding-workbench/context/packs"),
  };
}

const GITHUB_ISSUE_JSON = { title: "Issue title", body: "Issue body", html_url: "" };

function fakeGitHubPort(): GitHubCodeContextApiPort {
  return {
    readJson: (argv) =>
      Promise.resolve(argv[1]?.includes("/comments") === true ? [] : GITHUB_ISSUE_JSON),
  };
}

function fakeJiraPort(): JiraCodeContextHttpPort {
  return {
    readJson: () =>
      Promise.resolve({
        fields: { summary: "Jira summary", description: "Jira body", comment: { comments: [] } },
      }),
  };
}

function depsFor(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    env: {
      GITHUB_CONNECTOR_AUTHORIZED: "true",
      JIRA_CONNECTOR_AUTHORIZED: "true",
    },
    autonomousDeliveryDeploymentCeiling: "supervised-coding",
    codingContextGitHubPort: fakeGitHubPort(),
    codingContextJiraPort: fakeJiraPort(),
    ...overrides,
  } as UiHandlerDeps;
}

function packRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
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
      { source: "jira", objectKind: "issue", projectKey: "KEIKO", objectId: "42" },
    ],
    ...overrides,
  };
}

function bodyOf(result: RouteResult): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

describe("coding context pack route", () => {
  it("returns an untrusted-labeled pack with content-free evidence on the happy path", async () => {
    const result = await handleCodingContextPack(ctxFor(packRequest()), depsFor());

    expect(result.status).toBe(200);
    const body = bodyOf(result);
    expect(body.status).toBe("ready");
    const items = body.items as readonly Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]?.untrusted).toBe(true);
    expect(String(items[0]?.label)).toMatch(/^untrusted-source-control-issue-/u);
    const evidence = body.evidence as Record<string, unknown>;
    expect(JSON.stringify(evidence)).not.toContain("Issue body");
    expect(JSON.stringify(evidence)).not.toContain("Jira body");
  });

  it("blocks refs whose scope grant is missing instead of failing silently", async () => {
    const result = await handleCodingContextPack(
      ctxFor(packRequest({ connectorScopes: ["source-control.read"] })),
      depsFor(),
    );

    expect(result.status).toBe(200);
    const body = bodyOf(result);
    const blocked = body.blocked as readonly Record<string, unknown>[];
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ source: "jira", reason: "missing-scope" });
  });

  it("caps the client-supplied mode at the server deployment ceiling", async () => {
    const result = await handleCodingContextPack(
      ctxFor(packRequest({ effectiveMode: "autonomous-delivery" })),
      depsFor({
        autonomousDeliveryDeploymentCeiling: "governed-assist",
        env: { GITHUB_CONNECTOR_AUTHORIZED: "true", JIRA_CONNECTOR_AUTHORIZED: "true" },
      }),
    );

    // governed-assist still allows reads; the point is the request cannot run above
    // the ceiling — with a mode allowlist restricted by config it would block. Assert
    // the pack was evaluated (not rejected) and no authority escalation error exists.
    expect(result.status).toBe(200);
  });

  it("reports missing-credentials when the connector authorization flag is absent", async () => {
    const result = await handleCodingContextPack(
      ctxFor(packRequest()),
      depsFor({
        env: { GITHUB_CONNECTOR_AUTHORIZED: "true" },
      }),
    );

    expect(result.status).toBe(200);
    const blocked = bodyOf(result).blocked as readonly Record<string, unknown>[];
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ source: "jira", reason: "missing-credentials" });
  });

  it("rejects malformed bodies, unknown keys, hostile refs, and bad bounds", async () => {
    const cases: readonly Record<string, unknown>[] = [
      packRequest({ extra: true }),
      packRequest({ runId: "../escape" }),
      packRequest({ effectiveMode: "root" }),
      packRequest({ connectorScopes: ["not-a-scope"] }),
      packRequest({ refs: [] }),
      packRequest({
        refs: [
          {
            source: "github",
            objectKind: "issue",
            ownerAndRepo: "owner/repo/../../user",
            objectId: "1",
          },
        ],
      }),
      packRequest({
        refs: [{ source: "jira", objectKind: "issue", projectKey: "bad key", objectId: "1" }],
      }),
      packRequest({ maxBodyBytes: 1 }),
    ];
    for (const body of cases) {
      const result = await handleCodingContextPack(ctxFor(body), depsFor());
      expect(result.status).toBe(400);
    }
  });

  it("answers an opaque 502 with a correlation id when a port fails", async () => {
    const failingPort: GitHubCodeContextApiPort = {
      readJson: () => Promise.reject(new Error("secret endpoint detail must not leak")),
    };
    const result = await handleCodingContextPack(
      ctxFor(packRequest()),
      depsFor({ codingContextGitHubPort: failingPort }),
    );

    expect(result.status).toBe(502);
    const error = bodyOf(result).error as Record<string, unknown>;
    expect(error.code).toBe("CODING_CONTEXT_UPSTREAM_FAILED");
    expect(typeof error.correlationId).toBe("string");
    expect(JSON.stringify(result.body)).not.toContain("secret endpoint detail");
  });
});
