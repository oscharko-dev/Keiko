// Issue #2244 — sync-start governance tests, closing the #2242 open item: the D4
// `sync-space`/`sync-project` rows hold at ROUTE level for agent-initiated starts, and a direct
// human-triggered start records `allowed` + `human-initiated` instead of a bare static
// "allowed". Hermetic: in-memory provider fixtures, temp SQLite store, injected registries reset
// around every test, no wall-clock races.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAtlassianCredentialCustody,
  createInMemoryConfluenceFixture,
  createInMemoryJiraFixture,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type AtlassianHttpPort,
  type AtlassianHttpResult,
} from "@oscharko-dev/keiko-connectors";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_SCHEMA_VERSION,
  type AtlassianConnectorPendingApproval,
  type AtlassianSyncJobState,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchConnectorScope,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import type {
  GatewayConfig,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext } from "../routes.js";
import { buildRedactor } from "../deps.js";
import { createRunRegistry } from "../runs.js";
import { createInMemoryUiStore } from "../store/index.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
} from "../editor/agentAuthorityRegistry.js";
import { atlassianActionApprovalRegistry } from "./actionApprovals.js";
import { handleStartAtlassianConnectorSync } from "./syncRoutes.js";
import { atlassianSyncJobRegistry } from "./syncService.js";
import {
  handleApproveAtlassianConnectorActionApproval,
  handleRejectAtlassianConnectorActionApproval,
} from "./writeActionRoutes.js";

const BASE_URL = "https://tenant.example";
const ROOT = "/repo";
const TERMINAL: readonly string[] = ["succeeded", "partial", "failed", "cancelled"];
const READ_SCOPES: readonly CodingWorkbenchConnectorScope[] = [
  "knowledge-base.read",
  "issue-tracker.read",
];

let tmp: string;

beforeEach(() => {
  editorAgentAuthorityRegistry.reset();
  atlassianActionApprovalRegistry.reset();
  atlassianSyncJobRegistry.reset();
});

afterEach(() => {
  editorAgentAuthorityRegistry.reset();
  atlassianActionApprovalRegistry.reset();
  atlassianSyncJobRegistry.reset();
  rmSync(tmp, { recursive: true, force: true });
});

function gatewayConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: "text-embedding-3-small",
        baseUrl: "https://gateway.example.test/v1",
        apiKey: "redacted",
        timeoutMs: 30_000,
        maxRetries: 1,
        retryBaseDelayMs: 100,
      },
    ],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

interface Harness {
  readonly deps: UiHandlerDeps;
  readonly credential: AtlassianCredentialMetadata;
  readonly counter: { count: number };
}

function harnessFor(provider: "confluence" | "jira", port: AtlassianHttpBodyPort): Harness {
  tmp = mkdtempSync(join(realpathSync(tmpdir()), "keiko-atl-policy-"));
  const vault = new Map<string, string>();
  const metadata = new Map<string, AtlassianCredentialMetadata>();
  const { custody } = createAtlassianCredentialCustody({
    vault: {
      get: (key): string | undefined => vault.get(key),
      set: (key, secret): void => {
        vault.set(key, secret);
      },
      delete: (key): void => {
        vault.delete(key);
      },
    },
    metadataStore: {
      insert: (entry): void => {
        metadata.set(entry.authRef, entry);
      },
      get: (authRef): AtlassianCredentialMetadata | undefined => metadata.get(authRef),
      list: (): readonly AtlassianCredentialMetadata[] => [...metadata.values()],
      delete: (authRef): boolean => metadata.delete(authRef),
    },
  });
  const credential = custody.create({
    provider,
    displayName: provider === "confluence" ? "Team Wiki" : "Team Tracker",
    baseUrl: BASE_URL,
    authScheme: "basic-api-token",
    accountEmail: ["policy-tester", "@", "example", ".", "com"].join(""),
    apiToken: ["ATATT", "policy", "0123456789", "abcdefghij"].join(""),
  });
  const counter = { count: 0 };
  const countingPort: AtlassianHttpBodyPort = (request) => {
    counter.count += 1;
    return port(request);
  };
  const localKnowledgeEmbeddingRequest = vi.fn(
    (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve({
        ok: true,
        value: { vector: new Float32Array(1536).fill(1), modelId: request.modelId },
      }),
  );
  const deps = {
    config: gatewayConfig(),
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    uiDbPath: join(tmp, "keiko-ui.db"),
    localKnowledgeEmbeddingRequest,
    autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
    atlassianConnectorCredentials: {
      custody,
      httpPortFactory: (): AtlassianHttpPort => (): Promise<AtlassianHttpResult> =>
        Promise.resolve({ kind: "response", status: 200 }),
      httpBodyPortFactory: () => countingPort,
    },
  } as unknown as UiHandlerDeps;
  return { deps, credential, counter };
}

function withCeiling(deps: UiHandlerDeps, mode: CodingWorkbenchMode): UiHandlerDeps {
  return { ...deps, autonomousDeliveryDeploymentCeiling: mode };
}

function envelope(
  mode: CodingWorkbenchMode,
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-2244",
    localUser: "local-operator",
    taskRefs: ["issue-2244"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(ROOT),
    },
    branch: {
      baseRef: "dev",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode: mode,
    deploymentCeiling: mode,
    effectiveMode: mode,
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes,
    modelProfile: {
      profileId: "profile-1",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 60_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval", "branch-allowlist"],
    budget: {
      maxRuntimeMs: 3_600_000,
      maxToolCalls: 50,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
    approvalProofDigest: "a".repeat(64),
  };
}

function registerEnvelope(
  mode: CodingWorkbenchMode,
  connectorScopes: readonly CodingWorkbenchConnectorScope[],
): { runId: string; envelopeDigest: string; workspaceRoot: string } {
  const registration = editorAgentAuthorityRegistry.register(
    envelope(mode, connectorScopes),
    mode,
    new Date().toISOString(),
  );
  if (!registration.ok) throw new Error("test envelope registration failed");
  return { ...registration.authorityRef, workspaceRoot: ROOT };
}

function jsonRequest(body: Record<string, unknown>): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return req;
}

function ctxFor(params: Record<string, string>, body: Record<string, unknown>): RouteContext {
  return {
    req: jsonRequest(body),
    res: {} as never,
    params,
    url: new URL("http://127.0.0.1/api/atlassian-connectors/sync-jobs"),
  };
}

async function awaitTerminal(jobId: string): Promise<AtlassianSyncJobState> {
  await vi.waitFor(
    () => {
      const job = atlassianSyncJobRegistry.get(jobId);
      expect(TERMINAL).toContain(job?.state.status ?? "missing");
    },
    { timeout: 30_000, interval: 10 },
  );
  const job = atlassianSyncJobRegistry.get(jobId);
  if (job === undefined) throw new Error("job vanished");
  return job.state;
}

function confluencePort(): AtlassianHttpBodyPort {
  return createInMemoryConfluenceFixture({
    baseUrl: BASE_URL,
    spaces: [
      {
        key: "ENG",
        id: "100",
        pages: [{ pageId: "1", title: "Guide", storageBody: "<p>synced page body</p>" }],
      },
    ],
  });
}

function jiraPort(): AtlassianHttpBodyPort {
  return createInMemoryJiraFixture({
    baseUrl: BASE_URL,
    projects: [
      {
        key: "PROJ",
        issues: [
          {
            issueId: "10001",
            key: "PROJ-1",
            summary: "Tracked work",
            updated: "2026-05-01T10:22:33.000+0000",
          },
        ],
      },
    ],
  });
}

describe("sync start — human-triggered path (ADR-0128 D5)", () => {
  it("records allowed + human-initiated on the run's activity record", async () => {
    const { deps, credential } = harnessFor("confluence", confluencePort());
    const result = await handleStartAtlassianConnectorSync(
      ctxFor({ authRef: credential.authRef }, { spaceKeys: ["ENG"] }),
      deps,
    );
    expect(result.status).toBe(202);
    const { job } = result.body as { job: AtlassianSyncJobState };
    const terminal = await awaitTerminal(job.jobId);
    expect(terminal.status).toBe("succeeded");
    const activity = atlassianSyncJobRegistry.listActivity(job.connectorId);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actionType: "sync-space",
      disposition: "allowed",
      reasonCode: "human-initiated",
      outcome: "succeeded",
    });
  });
});

describe("sync start — agent-initiated envelope path (D4 rows 1-2 at route level)", () => {
  it("parks a pending approval in Ask for approval: the job does NOT start and zero fetches happen", async () => {
    const { deps, credential, counter } = harnessFor("confluence", confluencePort());
    const authority = registerEnvelope("governed-assist", READ_SCOPES);
    const result = await handleStartAtlassianConnectorSync(
      ctxFor({ authRef: credential.authRef }, { spaceKeys: ["ENG"], authority }),
      withCeiling(deps, "governed-assist"),
    );
    expect(result.status).toBe(202);
    const body = result.body as {
      disposition: string;
      approval: AtlassianConnectorPendingApproval;
    };
    expect(body.disposition).toBe("review-required");
    expect(body.approval.actionType).toBe("sync-space");
    expect(body.approval.reviewReason).toBe("mode-approval-required");
    expect(counter.count).toBe(0);
    expect(atlassianSyncJobRegistry.listActivity(body.approval.connectorId)).toHaveLength(1);
  });

  it.each<{ mode: CodingWorkbenchMode }>([
    { mode: "supervised-coding" },
    { mode: "autonomous-delivery" },
  ])(
    "starts the confluence job under $mode and records the envelope-allowed disposition",
    async ({ mode }) => {
      const { deps, credential } = harnessFor("confluence", confluencePort());
      const authority = registerEnvelope(mode, READ_SCOPES);
      const result = await handleStartAtlassianConnectorSync(
        ctxFor({ authRef: credential.authRef }, { spaceKeys: ["ENG"], authority }),
        withCeiling(deps, mode),
      );
      expect(result.status).toBe(202);
      const { job } = result.body as { job: AtlassianSyncJobState };
      const terminal = await awaitTerminal(job.jobId);
      expect(terminal.status).toBe("succeeded");
      const activity = atlassianSyncJobRegistry.listActivity(job.connectorId);
      expect(activity[0]).toMatchObject({ disposition: "allowed", outcome: "succeeded" });
      expect((activity[0] as { reasonCode?: string }).reasonCode).toBeUndefined();
    },
  );

  it("starts the jira sync-project job inside a Full-access envelope", async () => {
    const { deps, credential } = harnessFor("jira", jiraPort());
    const authority = registerEnvelope("autonomous-delivery", READ_SCOPES);
    const result = await handleStartAtlassianConnectorSync(
      ctxFor({ authRef: credential.authRef }, { projectKeys: ["PROJ"], authority }),
      deps,
    );
    expect(result.status).toBe(202);
    const { job } = result.body as { job: AtlassianSyncJobState };
    const terminal = await awaitTerminal(job.jobId);
    expect(terminal.status).toBe("succeeded");
    expect(atlassianSyncJobRegistry.listActivity(job.connectorId)[0]).toMatchObject({
      actionType: "sync-project",
      disposition: "allowed",
    });
  });

  it("denies a sync without the read scope with connector-access-denied in every mode, zero fetches", async () => {
    for (const mode of ["governed-assist", "supervised-coding", "autonomous-delivery"] as const) {
      editorAgentAuthorityRegistry.reset();
      const { deps, credential, counter } = harnessFor("confluence", confluencePort());
      const authority = registerEnvelope(mode, []);
      const result = await handleStartAtlassianConnectorSync(
        ctxFor({ authRef: credential.authRef }, { spaceKeys: ["ENG"], authority }),
        withCeiling(deps, mode),
      );
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        disposition: "denied",
        reasonCode: "connector-access-denied",
      });
      expect(counter.count).toBe(0);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("denies a digest-mismatched envelope with authority-invalid", async () => {
    const { deps, credential, counter } = harnessFor("confluence", confluencePort());
    const authority = registerEnvelope("autonomous-delivery", READ_SCOPES);
    const result = await handleStartAtlassianConnectorSync(
      ctxFor(
        { authRef: credential.authRef },
        { spaceKeys: ["ENG"], authority: { ...authority, envelopeDigest: "f".repeat(64) } },
      ),
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      disposition: "denied",
      reasonCode: "authority-invalid",
    });
    expect(counter.count).toBe(0);
  });

  it("400s a malformed authority object instead of treating it as human-initiated", async () => {
    const { deps, credential, counter } = harnessFor("confluence", confluencePort());
    const result = await handleStartAtlassianConnectorSync(
      ctxFor({ authRef: credential.authRef }, { spaceKeys: ["ENG"], authority: { runId: "r" } }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(counter.count).toBe(0);
  });
});

describe("sync start — approved and rejected pending syncs", () => {
  async function pendingSyncApproval(harness: Harness): Promise<AtlassianConnectorPendingApproval> {
    const authority = registerEnvelope("governed-assist", READ_SCOPES);
    const result = await handleStartAtlassianConnectorSync(
      ctxFor({ authRef: harness.credential.authRef }, { spaceKeys: ["ENG"], authority }),
      withCeiling(harness.deps, "governed-assist"),
    );
    expect(result.status).toBe(202);
    return (result.body as { approval: AtlassianConnectorPendingApproval }).approval;
  }

  it("approve starts the job and the run records the review-required governance", async () => {
    const harness = harnessFor("confluence", confluencePort());
    const approval = await pendingSyncApproval(harness);
    const approved = await handleApproveAtlassianConnectorActionApproval(
      ctxFor({ approvalId: approval.approvalId }, {}),
      withCeiling(harness.deps, "governed-assist"),
    );
    expect(approved.status).toBe(202);
    const { job, disposition } = approved.body as {
      job: AtlassianSyncJobState;
      disposition: string;
    };
    expect(disposition).toBe("review-required");
    const terminal = await awaitTerminal(job.jobId);
    expect(terminal.status).toBe("succeeded");
    const activity = atlassianSyncJobRegistry.listActivity(job.connectorId);
    // Exactly two records: the pending-review attempt and the approved run.
    expect(activity.map((record) => record.outcome)).toEqual(["pending-review", "succeeded"]);
    expect(activity[1]).toMatchObject({
      disposition: "review-required",
      reasonCode: "mode-approval-required",
      actionType: "sync-space",
    });
  });

  it("reject records the cancellation and the job never starts", async () => {
    const harness = harnessFor("confluence", confluencePort());
    const approval = await pendingSyncApproval(harness);
    const rejected = await handleRejectAtlassianConnectorActionApproval(
      ctxFor({ approvalId: approval.approvalId }, {}),
      withCeiling(harness.deps, "governed-assist"),
    );
    expect(rejected.status).toBe(200);
    expect(harness.counter.count).toBe(0);
    const activity = atlassianSyncJobRegistry.listActivity(approval.connectorId);
    expect(activity.map((record) => record.outcome)).toEqual(["pending-review", "cancelled"]);
  });
});
