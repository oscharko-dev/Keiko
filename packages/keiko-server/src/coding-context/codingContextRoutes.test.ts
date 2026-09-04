import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { URL } from "node:url";
import type {
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchConnectorScope,
  CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeCodingContextConnectors, handleCodingContextPack } from "./codingContextRoutes.js";
import type { GitHubCodeContextApiPort } from "./githubCodeContextConnector.js";
import type { JiraCodeContextHttpPort } from "./jiraCodeContextConnector.js";
import type { RouteContext, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { githubIssueReaderRepositoryId } from "./githubIssueReaderAuthorization.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "../editor/agentAuthorityRegistry.js";

// Real directories: the grant identity is a digest of the realpath'd root, and a path that does
// not resolve has no identity. `/workspace/project` used to stand here and passed only while the
// reader digested the string it was given — the very split that let a symlinked checkout be granted
// under one id and looked up under another.
const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "keiko-ctx-route-root-"));
const OTHER_ROOT = mkdtempSync(join(tmpdir(), "keiko-ctx-route-other-"));

afterAll(() => {
  for (const root of [WORKSPACE_ROOT, OTHER_ROOT]) rmSync(root, { recursive: true, force: true });
});
const TEST_NOW = "2026-07-07T13:00:00.000Z";

function requestWithBody(body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  return req;
}

function ctxFor(body: unknown): RouteContext {
  return {
    correlationId: undefined,
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

const PROJECT_ROOT = WORKSPACE_ROOT;

/**
 * #3385: the GitHub reader's authorization is a server-persisted, repository-scoped store row, not
 * an environment variable. This double answers for exactly one repository root, so a test can prove
 * the grant is scoped rather than global.
 */
function authorizationStore(
  authorizedRoot: string | undefined,
): Pick<UiHandlerDeps["store"], "readGitHubIssueReaderAuthorization"> {
  const authorizedId =
    authorizedRoot === undefined ? undefined : githubIssueReaderRepositoryId(authorizedRoot);
  return {
    readGitHubIssueReaderAuthorization: (repositoryId: string) =>
      repositoryId === authorizedId ? { repositoryId, authorized: true, revision: 1 } : undefined,
  };
}

function depsFor(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    env: {
      JIRA_CONNECTOR_AUTHORIZED: "true",
    },
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
    codingContextGitHubPort: fakeGitHubPort(),
    codingContextJiraPort: fakeJiraPort(),
    preferredProjectPath: PROJECT_ROOT,
    store: authorizationStore(PROJECT_ROOT),
    // The grant covers one remote repository, and the refs these fixtures request name it.
    codingContextGitHubRemoteResolver: () => Promise.resolve("oscharko-dev/Keiko"),
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
        env: { JIRA_CONNECTOR_AUTHORIZED: "true" },
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
        env: {},
      }),
    );

    expect(result.status).toBe(200);
    const blocked = bodyOf(result).blocked as readonly Record<string, unknown>[];
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ source: "jira", reason: "missing-credentials" });
  });

  // #3385 relocated the environment-variable pin here and strengthened it: the grant is per
  // repository, so a repository with no row of its own is denied even while another repository is
  // authorized in the same process. On the retired env gate this case could not be expressed at all.
  it("blocks the GitHub reader for a repository that carries no stored authorization", async () => {
    const result = await handleCodingContextPack(
      ctxFor(packRequest()),
      depsFor({
        // Set deliberately: the retired global gate would authorize this read, so leaving it absent
        // let the case pass under BOTH implementations and proved nothing about the new one.
        env: { GITHUB_CONNECTOR_AUTHORIZED: "true" },
        store: authorizationStore(OTHER_ROOT) as UiHandlerDeps["store"],
      }),
    );

    expect(result.status).toBe(200);
    expect(bodyOf(result).blocked).toContainEqual(
      expect.objectContaining({ source: "github", reason: "missing-credentials" }),
    );
  });

  // CWE-863 (CodeRabbit #3933343129 / #3933343148 / #3933343163): the store grant says GitHub
  // reading is turned on for THIS checkout; it says nothing about which remote repository. Before
  // this route-level pin, an authorized checkout could read any owner/repo the `gh` credentials
  // reached, because nothing here compared the requested ref against the checkout's own resolved
  // remote. The grant below targets the right checkout root and `codingContextGitHubRemoteResolver`
  // (set in `depsFor`) resolves it to "oscharko-dev/Keiko", but the ref names a different repository
  // and must still be denied end-to-end through the real route, not only at the connector unit.
  it("blocks a GitHub ref naming a different repository than the checkout's own remote", async () => {
    const result = await handleCodingContextPack(
      ctxFor(
        packRequest({
          refs: [
            {
              source: "github",
              objectKind: "issue",
              ownerAndRepo: "attacker/private",
              objectId: "1",
            },
          ],
        }),
      ),
      depsFor(),
    );

    expect(result.status).toBe(200);
    const body = bodyOf(result);
    expect(body.blocked).toHaveLength(1);
    expect(body.blocked).toContainEqual(
      expect.objectContaining({ source: "github", reason: "missing-credentials" }),
    );
    expect(body.items).toHaveLength(0);
  });

  it("degrades unusable Jira configuration to missing credentials", async () => {
    const result = await handleCodingContextPack(
      ctxFor(packRequest()),
      depsFor({
        codingContextGitHubPort: undefined,
        codingContextJiraPort: undefined,
        preferredProjectPath: undefined,
        // GitHub is denied through the store, not by withholding a port: the fallback port now
        // follows the authority's repository root, so an absent launch path no longer suppresses it.
        store: authorizationStore(undefined) as UiHandlerDeps["store"],
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
  });

  it("composes the governed GitHub fallback for an authorized launch project", () => {
    const composed = composeCodingContextConnectors(
      depsFor({
        codingContextGitHubPort: undefined,
        env: {},
      }),
    );

    expect(composed.connectorConfig.github_connector_authorized).toBe(true);
  });

  it("composes the fallback port but denies the read when the repository is not authorized", () => {
    const composed = composeCodingContextConnectors(
      depsFor({
        codingContextGitHubPort: undefined,
        // Same reason as above: with the retired variable set, only the persisted grant can deny.
        env: { GITHUB_CONNECTOR_AUTHORIZED: "true" },
        store: authorizationStore(undefined) as UiHandlerDeps["store"],
      }),
    );

    expect(composed.connectorConfig.github_connector_authorized).toBe(false);
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
