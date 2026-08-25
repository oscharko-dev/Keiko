import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { URL } from "node:url";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeCodingContextConnectors, handleCodingContextPack } from "./codingContextRoutes.js";
import type { GitHubCodeContextApiPort } from "./githubCodeContextConnector.js";
import type { JiraCodeContextHttpPort } from "./jiraCodeContextConnector.js";
import type { RouteContext, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "../editor/agentAuthorityRegistry.js";

const WORKSPACE_ROOT = "/workspace/project";
const TEST_NOW = "2026-07-07T13:00:00.000Z";

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
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
    codingContextGitHubPort: fakeGitHubPort(),
    codingContextJiraPort: fakeJiraPort(),
    ...overrides,
  } as UiHandlerDeps;
}

interface AuthorityOptions {
  readonly actionClasses?: CodingWorkbenchAuthorityEnvelope["actionClasses"] | undefined;
  readonly connectorScopes?: readonly CodingWorkbenchConnectorScope[] | undefined;
  readonly deploymentCeiling?: CodingWorkbenchMode | undefined;
  readonly effectiveMode?: CodingWorkbenchMode | undefined;
  readonly maxToolCalls?: number | undefined;
  readonly networkPolicy?: CodingWorkbenchAuthorityEnvelope["networkPolicy"] | undefined;
}

function registerAuthority(options: AuthorityOptions = {}): Record<string, unknown> {
  const deploymentCeiling = options.deploymentCeiling ?? "autonomous-delivery";
  const effectiveMode = options.effectiveMode ?? deploymentCeiling;
  const connectorScopes = options.connectorScopes ?? ["source-control.read", "issue-tracker.read"];
  const envelope: CodingWorkbenchAuthorityEnvelope = {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-1989",
    localUser: "local-operator",
    taskRefs: ["issue-1989"],
    workspace: {
      workspaceId: "workspace-1989",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(WORKSPACE_ROOT),
    },
    branch: {
      baseRef: "dev",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode: effectiveMode,
    deploymentCeiling,
    effectiveMode,
    runtimeSource: "keiko-sidecar",
    actionClasses: options.actionClasses ?? [
      "workspace-read",
      "workspace-write",
      "command-execution",
      "verification",
      "connector-access",
      "network-egress",
    ],
    connectorScopes,
    modelProfile: {
      profileId: "local-codex",
      source: "chatgpt-codex-subscription-profile",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: ["npm", "node"],
      deny: ["curl"],
      maxCommandTimeoutMs: 30_000,
      requirePerCommandApproval: true,
    },
    networkPolicy: options.networkPolicy ?? {
      mode: "connector-scoped-egress",
      allowLoopback: false,
      connectorScopes,
    },
    gates: ["human-approval", "verification-green", "artifact-review"],
    budget: {
      maxRuntimeMs: 120_000,
      maxToolCalls: options.maxToolCalls ?? 12,
      maxPromptTokens: 24_000,
      maxPatchBytes: 32_768,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvalProofDigest: "a".repeat(64),
  };
  const registered = editorAgentAuthorityRegistry.register(
    envelope,
    deploymentCeiling,
    new Date().toISOString(),
  );
  if (!registered.ok) throw new Error("expected registered coding-context authority");
  return { ...registered.authorityRef, workspaceRoot: WORKSPACE_ROOT };
}

function packRequest(
  overrides: Record<string, unknown> = {},
  authorityOptions: AuthorityOptions = {},
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    authority: registerAuthority(authorityOptions),
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

function packRequestWithAuthorityOverrides(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const request = packRequest();
  const authority = request.authority as Record<string, unknown>;
  return { ...request, authority: { ...authority, ...overrides } };
}

function bodyOf(result: RouteResult): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

describe("coding context pack route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TEST_NOW));
    editorAgentAuthorityRegistry.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
      ctxFor(packRequest({}, { connectorScopes: ["source-control.read"] })),
      depsFor(),
    );

    expect(result.status).toBe(200);
    const body = bodyOf(result);
    const blocked = body.blocked as readonly Record<string, unknown>[];
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ source: "jira", reason: "missing-scope" });
  });

  it("derives connector scopes from the envelope that reserved the action", async () => {
    const request = packRequest({
      refs: [
        {
          source: "github",
          objectKind: "issue",
          ownerAndRepo: "oscharko-dev/Keiko",
          objectId: "1989",
        },
      ],
    });
    const authority = request.authority as Record<string, unknown>;
    const reference = {
      runId: String(authority.runId),
      envelopeDigest: String(authority.envelopeDigest),
    };
    const preflight = editorAgentAuthorityRegistry.resolve(
      reference,
      WORKSPACE_ROOT,
      "autonomous-delivery",
      new Date().toISOString(),
    );
    if (!preflight.ok) throw new Error("expected preflight authority");
    const reservedEnvelope = {
      ...preflight.envelope,
      connectorScopes: ["issue-tracker.read" as const],
      networkPolicy: {
        ...preflight.envelope.networkPolicy,
        connectorScopes: ["issue-tracker.read" as const],
      },
    };
    const resolve = vi.spyOn(editorAgentAuthorityRegistry, "resolve").mockReturnValue(preflight);
    const reserve = vi
      .spyOn(editorAgentAuthorityRegistry, "reserveForConnector")
      .mockReturnValue({ ok: true, envelope: reservedEnvelope });

    try {
      const result = await handleCodingContextPack(ctxFor(request), depsFor());
      expect(result.status).toBe(200);
      expect(bodyOf(result).items).toEqual([]);
      expect(bodyOf(result).blocked).toEqual([
        expect.objectContaining({ source: "github", reason: "missing-scope" }),
      ]);
    } finally {
      reserve.mockRestore();
      resolve.mockRestore();
    }
  });

  it("denies connector reads when the retained envelope forbids network egress", async () => {
    const github = fakeGitHubPort();
    const readJson = vi.fn((argv: readonly string[]) => github.readJson(argv));
    const request = packRequest(
      {
        refs: [
          {
            source: "github",
            objectKind: "issue",
            ownerAndRepo: "oscharko-dev/Keiko",
            objectId: "1989",
          },
        ],
      },
      { networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] } },
    );

    const result = await handleCodingContextPack(
      ctxFor(request),
      depsFor({ codingContextGitHubPort: { readJson } }),
    );

    expect(result).toMatchObject({
      status: 403,
      body: { error: { code: "CODING_CONTEXT_AUTHORITY_DENIED" } },
    });
    expect(readJson).not.toHaveBeenCalled();
  });

  it.each(["governed-assist", "supervised-coding"] as const)(
    "denies connector reads without an approval workflow in %s mode",
    async (effectiveMode) => {
      const github = fakeGitHubPort();
      const readJson = vi.fn((argv: readonly string[]) => github.readJson(argv));
      const request = packRequest(
        {
          refs: [
            {
              source: "github",
              objectKind: "issue",
              ownerAndRepo: "oscharko-dev/Keiko",
              objectId: "1989",
            },
          ],
        },
        { deploymentCeiling: effectiveMode, effectiveMode },
      );

      const result = await handleCodingContextPack(
        ctxFor(request),
        depsFor({
          autonomousDeliveryDeploymentCeiling: effectiveMode,
          codingContextGitHubPort: { readJson },
        }),
      );

      expect(result).toMatchObject({
        status: 403,
        body: { error: { code: "CODING_CONTEXT_AUTHORITY_DENIED" } },
      });
      expect(readJson).not.toHaveBeenCalled();
    },
  );

  it("denies authority whose registered ceiling no longer matches server policy", async () => {
    const result = await handleCodingContextPack(
      ctxFor(packRequest()),
      depsFor({
        autonomousDeliveryDeploymentCeiling: "governed-assist",
        env: { GITHUB_CONNECTOR_AUTHORIZED: "true", JIRA_CONNECTOR_AUTHORIZED: "true" },
      }),
    );

    expect(result).toMatchObject({
      status: 403,
      body: { error: { code: "CODING_CONTEXT_AUTHORITY_DENIED" } },
    });
  });

  it("reserves one connector action and denies an exhausted authority before fetching", async () => {
    const github = fakeGitHubPort();
    const readJson = vi.fn((argv: readonly string[]) => github.readJson(argv));
    const request = packRequest(
      {
        refs: [
          {
            source: "github",
            objectKind: "issue",
            ownerAndRepo: "oscharko-dev/Keiko",
            objectId: "1989",
          },
        ],
      },
      { maxToolCalls: 1 },
    );
    const deps = depsFor({ codingContextGitHubPort: { readJson } });

    const admitted = await handleCodingContextPack(ctxFor(request), deps);
    const callCountAfterAdmission = readJson.mock.calls.length;
    const result = await handleCodingContextPack(ctxFor(request), deps);

    expect(admitted.status).toBe(200);
    expect(result).toMatchObject({
      status: 403,
      body: { error: { code: "CODING_CONTEXT_AUTHORITY_DENIED" } },
    });
    expect(readJson).toHaveBeenCalledTimes(callCountAfterAdmission);
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

  it("degrades unusable Jira configuration to missing credentials", async () => {
    const result = await handleCodingContextPack(
      ctxFor(packRequest()),
      depsFor({
        codingContextGitHubPort: undefined,
        codingContextJiraPort: undefined,
        preferredProjectPath: undefined,
        env: {
          GITHUB_CONNECTOR_AUTHORIZED: "true",
          JIRA_CONNECTOR_AUTHORIZED: "true",
          KEIKO_JIRA_BASE_URL: "http://invalid.example.com",
          KEIKO_JIRA_EMAIL: "operator@example.com",
          KEIKO_JIRA_API_TOKEN: "secret-token",
        },
      }),
    );

    expect(result.status).toBe(200);
    expect(bodyOf(result).blocked).toContainEqual(
      expect.objectContaining({ source: "jira", reason: "missing-credentials" }),
    );
  });

  it("composes the governed GitHub fallback for an authorized launch project", () => {
    const composed = composeCodingContextConnectors(
      depsFor({
        codingContextGitHubPort: undefined,
        preferredProjectPath: "/workspace/project",
        env: { GITHUB_CONNECTOR_AUTHORIZED: "true" },
      }),
    );

    expect(composed.connectorConfig.github_connector_authorized).toBe(true);
  });

  it("does not emit an upstream diagnostic for invalid fallback Jira configuration", async () => {
    const diagnostics: unknown[] = [];

    const result = await handleCodingContextPack(
      ctxFor(packRequest()),
      depsFor({
        codingContextJiraPort: undefined,
        diagnostics: { record: (record) => diagnostics.push(record) },
        env: {
          JIRA_CONNECTOR_AUTHORIZED: "true",
          KEIKO_JIRA_BASE_URL: "http://invalid.example.com",
          KEIKO_JIRA_EMAIL: "operator@example.com",
          KEIKO_JIRA_API_TOKEN: "secret-token",
        },
      }),
    );

    expect(result.status).toBe(200);
    expect(bodyOf(result).blocked).toContainEqual(
      expect.objectContaining({ source: "jira", reason: "missing-credentials" }),
    );
    expect(diagnostics).toEqual([]);
  });

  it("rejects malformed bodies, unknown keys, hostile refs, and bad bounds", async () => {
    const cases: readonly Record<string, unknown>[] = [
      packRequest({ extra: true }),
      packRequestWithAuthorityOverrides({ effectiveMode: "autonomous-delivery" }),
      packRequestWithAuthorityOverrides({ connectorScopes: ["issue-tracker.read"] }),
      packRequestWithAuthorityOverrides({ runId: "../escape" }),
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
      packRequest({
        refs: [
          {
            source: "github",
            objectKind: "issue",
            ownerAndRepo: "owner/repo",
            objectId: "１２",
          },
        ],
      }),
      packRequest({ maxBodyBytes: 1 }),
    ];
    for (const body of cases) {
      const result = await handleCodingContextPack(ctxFor(body), depsFor());
      expect(result.status).toBe(400);
    }
  });

  it("denies a well-formed forged run id at authority resolution", async () => {
    const result = await handleCodingContextPack(
      ctxFor(packRequestWithAuthorityOverrides({ runId: "forged-run" })),
      depsFor(),
    );

    expect(result).toMatchObject({
      status: 403,
      body: { error: { code: "CODING_CONTEXT_AUTHORITY_DENIED" } },
    });
  });

  it("rejects a forged authority before invoking any connector", async () => {
    const github = fakeGitHubPort();
    const readJson = vi.fn((argv: readonly string[]) => github.readJson(argv));
    const request = packRequest({
      refs: [
        {
          source: "github",
          objectKind: "issue",
          ownerAndRepo: "oscharko-dev/Keiko",
          objectId: "1989",
        },
      ],
    });
    const authority = request.authority as Record<string, unknown>;
    request.authority = { ...authority, envelopeDigest: "b".repeat(64) };

    const result = await handleCodingContextPack(
      ctxFor(request),
      depsFor({ codingContextGitHubPort: { readJson } }),
    );

    expect(result).toMatchObject({
      status: 403,
      body: { error: { code: "CODING_CONTEXT_AUTHORITY_DENIED" } },
    });
    expect(readJson).not.toHaveBeenCalled();
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

  it("threads the request's own correlation id into the upstream-failure response instead of minting one", async () => {
    // ADR-0173 D5 / g12: ctx.correlationId is minted at request entry (server.ts) and is already
    // in scope here — the failure record and the response body must reuse it, not a disconnected
    // randomUUID(). Before the fix the response correlationId never matched ctx.correlationId.
    const failingPort: GitHubCodeContextApiPort = {
      readJson: () => Promise.reject(new Error("secret endpoint detail must not leak")),
    };
    const ctx = { ...ctxFor(packRequest()), correlationId: "req-thread-0123456789" };
    const result = await handleCodingContextPack(
      ctx,
      depsFor({ codingContextGitHubPort: failingPort }),
    );

    expect(result.status).toBe(502);
    const error = bodyOf(result).error as Record<string, unknown>;
    expect(error.correlationId).toBe("req-thread-0123456789");
  });
});
