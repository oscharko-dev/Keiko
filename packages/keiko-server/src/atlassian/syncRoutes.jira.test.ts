// Issue #2243 — Jira sync composition tests: routes + service + Jira adapter + shared sync lane +
// local-knowledge sink, end to end. Hermetic: the transport is the in-memory Jira fixture from
// keiko-connectors (no atlassian.net, no network), custody is in-memory with synthetic secrets,
// embedding is a deterministic stub, and the store is a fresh temp SQLite file per test. Every
// wait awaits a condition (vi.waitFor). Proves the acceptance criteria at the composed level:
// the ≥50-issue fixture project with exact counts, hostile-ADF bounding, `KEY: summary` citations
// with structured metadata, incremental re-sync with call-count evidence, moved-out-of-JQL
// removal, the #2242 degradation vocabulary, and JQL opacity in every wire payload.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHostileJiraAdfDocument,
  createAtlassianCredentialCustody,
  createInMemoryJiraFixture,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type JiraFixtureIssue,
} from "@oscharko-dev/keiko-connectors";
import type { AtlassianSyncJobState, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import {
  buildKnowledgePodSummary,
  getCapsule,
  readConnectorSourceMetadata,
  resolveConnectorCitationTarget,
  runLocalKnowledgeRetrieval,
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  GatewayConfig,
  OpenAIEmbeddingOutcome,
  OpenAIEmbeddingRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext, RouteResult } from "../routes.js";
import { buildRedactor } from "../deps.js";
import { createRunRegistry } from "../runs.js";
import { createInMemoryUiStore } from "../store/index.js";
import { openKnowledgeStoreForDeps } from "../local-knowledge-store-open.js";
import {
  configuredProviderForCapsule,
  localKnowledgeEmbeddingAdapterForProvider,
} from "../local-knowledge-handlers.js";
import {
  handleListAtlassianConnectorActivity,
  handleStartAtlassianConnectorSync,
} from "./syncRoutes.js";
import { atlassianSyncJobRegistry, connectorSourceIdFor } from "./syncService.js";

const BASE_URL = "https://tenant.example";
const SYNTHETIC_TOKEN = ["ATATT", "jira", "route", "0123456789", "abcdefghij"].join("");
const SYNTHETIC_EMAIL = ["jira-tester", "@", "example", ".", "com"].join("");
const SECRET_BODY_MARKER = "SYNCED-ISSUE-BODY-MARKER";
const SECRET_JQL = 'labels = "confidential-initiative-x" AND text ~ "secret roadmap"';

const TERMINAL: readonly string[] = ["succeeded", "partial", "failed", "cancelled"];

let tmp: string;

afterEach(() => {
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

function depsFor(httpBodyPort: AtlassianHttpBodyPort): {
  readonly deps: UiHandlerDeps;
  readonly credential: AtlassianCredentialMetadata;
} {
  tmp = mkdtempSync(join(realpathSync(tmpdir()), "keiko-atl-jira-"));
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
    provider: "jira",
    displayName: "Platform Jira",
    baseUrl: BASE_URL,
    authScheme: "basic-api-token",
    accountEmail: SYNTHETIC_EMAIL,
    apiToken: SYNTHETIC_TOKEN,
  });
  const localKnowledgeEmbeddingRequest = vi.fn(
    (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve({
        ok: true,
        value: { vector: new Float32Array(1536).fill(1), modelId: request.modelId },
      }),
  );
  const deps: UiHandlerDeps = {
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
    atlassianConnectorCredentials: {
      custody,
      httpPortFactory: () => () => Promise.resolve({ kind: "response", status: 200 }),
      httpBodyPortFactory: () => httpBodyPort,
    },
  };
  return { deps, credential };
}

function jsonRequest(body: Record<string, unknown> | undefined, method: string): IncomingMessage {
  const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = Readable.from(bytes) as IncomingMessage;
  req.method = method;
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return req;
}

function ctxFor(
  method: string,
  params: Record<string, string>,
  body?: Record<string, unknown>,
): RouteContext {
  return {
    req: jsonRequest(body, method),
    res: {} as never,
    params,
    url: new URL("http://127.0.0.1/api/atlassian-connectors/sync-jobs"),
  };
}

function adf(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const UNCHANGED_UPDATED = "2026-05-01T10:00:00.000+0000";
const RICH_ISSUE_UPDATED = "2026-05-01T12:00:00.000+0000";
const RICH_ISSUE_UPDATED_RUN2 = "2026-05-03T08:00:00.000+0000";

// The AC-1 fixture project: 50 healthy issues (the rich one carries nested-list/table/code/
// mention ADF, comments, and the full metadata field set), one 10k-node hostile-ADF issue, one
// 403 issue, and one malformed-payload issue.
function richDescription(marker: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: `${marker} login token expires early.` }],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Reproduce with SSO" }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "Safari only" }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Env" }] }],
              },
              {
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Result" }] }],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "staging" }] }],
              },
              {
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "fails" }] }],
              },
            ],
          },
        ],
      },
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "session.refresh();" }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Assigned to " },
          { type: "mention", attrs: { id: "5", text: "@Alice" } },
        ],
      },
    ],
  };
}

function richIssue(marker: string, updated: string): JiraFixtureIssue {
  return {
    issueId: "10002",
    key: "PLAT-2",
    summary: "Fix login flow",
    updated,
    descriptionAdf: richDescription(marker),
    comments: [
      {
        author: "Alice Example",
        created: "2026-05-01T10:22:33.000+0000",
        bodyAdf: adf("The on-call engineer must page the identity channel before rollout."),
      },
      { author: "Bob Reporter", created: "2026-05-02T08:00:00.000+0000", bodyAdf: adf("Agreed.") },
    ],
    extraFields: {
      status: { name: "In Progress" },
      issuetype: { name: "Bug" },
      assignee: { displayName: "Alice Example" },
      labels: ["auth", "backend"],
      priority: { name: "High" },
      timetracking: { originalEstimate: "1w", remainingEstimate: "2d" },
      parent: { key: "PLAT-1" },
      subtasks: [{ key: "PLAT-3" }],
      issuelinks: [{ type: { outward: "blocks" }, outwardIssue: { key: "PLAT-9" } }],
    },
  };
}

function plainIssue(id: number): JiraFixtureIssue {
  // Issue 7 carries a lexically distinctive body so the minimal-metadata citation probe retrieves
  // deterministically under the constant-vector embedding stub.
  const body =
    id === 7
      ? "The quarterly billing export stalls at midnight until the ledger unlocks."
      : `Plain description of platform issue ${String(id)}.`;
  return {
    issueId: String(10_000 + id),
    key: `PLAT-${String(id)}`,
    summary: `Issue ${String(id)}`,
    updated: UNCHANGED_UPDATED,
    descriptionAdf: adf(body),
  };
}

function fixtureIssues(marker: string): readonly JiraFixtureIssue[] {
  const healthy = Array.from({ length: 50 }, (_, index) => {
    const id = index + 1;
    return id === 2 ? richIssue(marker, RICH_ISSUE_UPDATED) : plainIssue(id);
  });
  return [
    ...healthy,
    {
      issueId: "10900",
      key: "PLAT-900",
      summary: "Hostile document",
      updated: UNCHANGED_UPDATED,
      descriptionAdf: buildHostileJiraAdfDocument(10_000),
    },
    {
      issueId: "10901",
      key: "PLAT-901",
      summary: "Restricted issue",
      updated: UNCHANGED_UPDATED,
      bodyStatus: 403,
    },
    {
      issueId: "10902",
      key: "PLAT-902",
      summary: "Broken issue",
      updated: UNCHANGED_UPDATED,
      malformedBody: true,
    },
  ];
}

function issueGetCount(requests: readonly AtlassianHttpBodyRequest[]): number {
  return requests.filter(
    (request) => request.url.includes("/rest/api/3/issue/") && !request.url.includes("/comment"),
  ).length;
}

function startedJob(result: RouteResult): { job: AtlassianSyncJobState; capsuleId: string } {
  expect(result.status).toBe(202);
  return result.body as { job: AtlassianSyncJobState; capsuleId: string };
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

async function startSync(
  deps: UiHandlerDeps,
  credential: AtlassianCredentialMetadata,
  body: Record<string, unknown>,
): Promise<{ job: AtlassianSyncJobState; capsuleId: string }> {
  const result = await handleStartAtlassianConnectorSync(
    ctxFor("POST", { authRef: credential.authRef }, body),
    deps,
  );
  return startedJob(result);
}

interface OpenedJiraPod {
  readonly store: ReturnType<typeof openKnowledgeStoreForDeps>["store"];
  readonly capsule: NonNullable<ReturnType<typeof getCapsule>>;
  readonly adapter: ReturnType<typeof localKnowledgeEmbeddingAdapterForProvider>;
}

function openJiraPod(deps: UiHandlerDeps, capsuleId: string): OpenedJiraPod & { close(): void } {
  const opened = openKnowledgeStoreForDeps(deps);
  const capsule = getCapsule(opened.store, capsuleId as KnowledgeCapsuleId);
  if (capsule === undefined) throw new Error("capsule missing");
  const provider = configuredProviderForCapsule(deps, capsule);
  if (provider === undefined) throw new Error("embedding provider missing");
  const adapter = localKnowledgeEmbeddingAdapterForProvider(deps, provider);
  return {
    store: opened.store,
    capsule,
    adapter,
    close: (): void => {
      opened.close();
    },
  };
}

// Retrieves with the pod's adapter and returns the document id cited under `title`.
async function citedDocumentId(pod: OpenedJiraPod, query: string, title: string): Promise<string> {
  const retrieval = await runLocalKnowledgeRetrieval(
    { store: pod.store, embeddingAdapter: pod.adapter },
    { text: query, capsuleId: pod.capsule.id, topK: 5 },
  );
  const reference = retrieval.references.find((ref) => ref.citation.safeDisplayName === title);
  if (reference === undefined) throw new Error(`no citation titled ${title} for: ${query}`);
  return String(reference.citation.documentId);
}

function resolveCitation(
  pod: OpenedJiraPod,
  documentId: string,
): ReturnType<typeof resolveConnectorCitationTarget> {
  return resolveConnectorCitationTarget(pod.store, {
    capsuleId: pod.capsule.id,
    sourceId: connectorSourceIdFor(pod.capsule.id),
    documentId: documentId as Parameters<typeof resolveConnectorCitationTarget>[1]["documentId"],
  });
}

function expectPlainIssueCitation(pod: OpenedJiraPod, documentId: string): void {
  const target = resolveCitation(pod, documentId);
  expect(target.ok).toBe(true);
  if (!target.ok) return;
  expect(target.citationMetadata).toMatchObject({ issueKey: "PLAT-7" });
  expect(target.citationMetadata?.parentKey).toBeUndefined();
  expect(target.citationMetadata?.remainingEstimate).toBeUndefined();
}

async function expectJqlOpacity(
  deps: UiHandlerDeps,
  credential: AtlassianCredentialMetadata,
  pod: OpenedJiraPod,
  terminal: AtlassianSyncJobState,
): Promise<void> {
  const activity = await handleListAtlassianConnectorActivity(
    ctxFor("GET", { authRef: credential.authRef }),
    deps,
  );
  const summary = buildKnowledgePodSummary(pod.store, pod.capsule);
  const scanned = JSON.stringify({ job: terminal, activity: activity.body, summary });
  expect(scanned).not.toContain("confidential-initiative-x");
  expect(scanned).not.toContain(SECRET_JQL);
  expect(scanned).not.toContain(SYNTHETIC_TOKEN);
  expect(scanned).not.toContain(SYNTHETIC_EMAIL);
  expect(scanned).not.toContain(SECRET_BODY_MARKER);
  expect(JSON.stringify(activity.body)).toContain('"actionType":"sync-project"');
}

describe("Jira sync — initial run over the AC fixture project", () => {
  it("syncs ≥50 issues with exact counts, bounds the hostile document, and cites KEY: summary with structured metadata", async () => {
    const requests: AtlassianHttpBodyRequest[] = [];
    const port = createInMemoryJiraFixture({
      baseUrl: BASE_URL,
      projects: [{ key: "PLAT", issues: fixtureIssues(SECRET_BODY_MARKER) }],
      onRequest: (request) => {
        requests.push(request);
      },
    });
    const { deps, credential } = depsFor(port);
    const started = await startSync(deps, credential, {
      projectKeys: ["PLAT"],
      jql: SECRET_JQL,
      displayName: "Platform Issues",
    });
    const terminal = await awaitTerminal(started.job.jobId);

    // Partial — never a silent abort — with the exact AC counts: 51 indexed (50 healthy + the
    // bounded hostile document), one denied (403), one failed (malformed payload).
    expect(terminal.status).toBe("partial");
    if (terminal.status !== "partial") return;
    expect(terminal.changeSummary.counts).toEqual({
      addedItems: 51,
      changedItems: 0,
      removedItems: 0,
      unchangedItems: 0,
      failedItems: 1,
      deniedItems: 1,
    });
    expect([...terminal.failureReasons].sort()).toEqual(["malformed-payload", "permission-denied"]);
    expect(terminal.progress).toMatchObject({
      enumeratedItems: 53,
      fetchedItems: 51,
      skippedItems: 2,
      failedItems: 2,
    });
    // The composed JQL rode the search request (egress), narrowed via AND.
    const search = requests.find((request) => request.url.includes("/search/jql"));
    const jqlParam = new URL(search?.url ?? "").searchParams.get("jql");
    expect(jqlParam).toBe(`project IN (PLAT) AND (${SECRET_JQL})`);

    const pod = openJiraPod(deps, started.capsuleId);
    try {
      // Grounded ask over the pod cites `KEY: summary` — for the description AND for a comment.
      const loginDocumentId = await citedDocumentId(
        pod,
        "Why does the login token expire early?",
        "PLAT-2: Fix login flow",
      );
      await citedDocumentId(
        pod,
        "Who must page the identity channel before rollout?",
        "PLAT-2: Fix login flow",
      );

      // Citation click-through: browse URL + validated structured metadata (status/type/labels,
      // remaining estimate, parent/subtask/link keys).
      expect(resolveCitation(pod, loginDocumentId)).toMatchObject({
        ok: true,
        target: "https://tenant.example/browse/PLAT-2",
        pageTitle: "PLAT-2: Fix login flow",
        itemKey: "jira:cred-" + credential.authRef.slice("atlassian-cred:".length) + ":10002",
        citationMetadata: {
          issueKey: "PLAT-2",
          status: "In Progress",
          issueType: "Bug",
          assignee: "Alice Example",
          labels: ["auth", "backend"],
          priority: "High",
          originalEstimate: "1w",
          remainingEstimate: "2d",
          parentKey: "PLAT-1",
          subtaskKeys: ["PLAT-3"],
          linkedIssues: [{ linkType: "blocks", issueKey: "PLAT-9" }],
        },
      });

      // An issue WITHOUT the optional fields resolves with minimal metadata.
      const plainDocumentId = await citedDocumentId(
        pod,
        "Why does the quarterly billing export stall at midnight?",
        "PLAT-7: Issue 7",
      );
      expectPlainIssueCitation(pod, plainDocumentId);

      // The approved scope persisted the opaque JQL verbatim for re-sync reconstruction.
      const metadata = readConnectorSourceMetadata(
        pod.store,
        pod.capsule.id,
        connectorSourceIdFor(pod.capsule.id),
      );
      expect(metadata?.jql).toBe(SECRET_JQL);
      expect(metadata?.providerWatermark).toBe(RICH_ISSUE_UPDATED);

      // JQL opacity: never verbatim in job state, activity, or the pod summary projection.
      await expectJqlOpacity(deps, credential, pod, terminal);
    } finally {
      pod.close();
    }
  });
});

describe("Jira sync — incremental re-sync", () => {
  it("re-fetches only updated/new issues (call-count assertion), removes deleted and moved-out-of-JQL issues, and reports exact counts", async () => {
    const run1 = createInMemoryJiraFixture({
      baseUrl: BASE_URL,
      projects: [{ key: "PLAT", issues: fixtureIssues(SECRET_BODY_MARKER) }],
    });
    const { deps, credential } = depsFor(run1);
    const started = await startSync(deps, credential, { projectKeys: ["PLAT"], jql: SECRET_JQL });
    const initial = await awaitTerminal(started.job.jobId);
    expect(initial.status).toBe("partial");

    // Upstream between runs: the rich issue updated (newer provider timestamp + new content),
    // issue 49 moved out of the approved JQL, issue 50 deleted — both simply leave the search
    // result set; everything else is byte-identical with unchanged timestamps.
    const run2Issues = fixtureIssues(SECRET_BODY_MARKER)
      .filter((issue) => issue.key !== "PLAT-49" && issue.key !== "PLAT-50")
      .map((issue) =>
        issue.key === "PLAT-2"
          ? {
              ...richIssue(SECRET_BODY_MARKER, RICH_ISSUE_UPDATED_RUN2),
              descriptionAdf: adf("Root cause identified: refresh token clock skew."),
            }
          : issue,
      );
    const run2Requests: AtlassianHttpBodyRequest[] = [];
    const run2Port = createInMemoryJiraFixture({
      baseUrl: BASE_URL,
      projects: [{ key: "PLAT", issues: run2Issues }],
      onRequest: (request) => {
        run2Requests.push(request);
      },
    });
    const swapped = deps.atlassianConnectorCredentials;
    if (swapped === undefined) throw new Error("connector deps missing");
    const resyncDeps: UiHandlerDeps = {
      ...deps,
      atlassianConnectorCredentials: { ...swapped, httpBodyPortFactory: () => run2Port },
    };
    const resync = await startSync(resyncDeps, credential, { capsuleId: started.capsuleId });
    const terminal = await awaitTerminal(resync.job.jobId);

    expect(terminal.status).toBe("partial");
    if (terminal.status !== "partial") return;
    expect(terminal.changeSummary.counts).toEqual({
      addedItems: 0,
      changedItems: 1,
      removedItems: 2,
      unchangedItems: 48,
      failedItems: 1,
      deniedItems: 1,
    });
    // Call-count evidence: only the updated issue plus the two never-baselined failures
    // re-fetched — 3 issue GETs, not 51. The lane's progress counters cover the narrowed
    // processing set (3); the full 51-item scope surfaces through the change summary's
    // unchanged/removed counts above.
    expect(issueGetCount(run2Requests)).toBe(3);
    expect(terminal.progress).toMatchObject({
      enumeratedItems: 3,
      fetchedItems: 1,
      skippedItems: 2,
    });
    expect(terminal.progress.indexedItems).toBe(1);

    const pod = openJiraPod(resyncDeps, started.capsuleId);
    try {
      // Removed issues left the index; carried issues remain retrievable.
      const removed = await runLocalKnowledgeRetrieval(
        { store: pod.store, embeddingAdapter: pod.adapter },
        { text: "Plain description of platform issue 49", capsuleId: pod.capsule.id, topK: 10 },
      );
      expect(
        removed.references.every((ref) => ref.citation.safeDisplayName !== "PLAT-49: Issue 49"),
      ).toBe(true);
      await citedDocumentId(
        pod,
        "Why does the quarterly billing export stall at midnight?",
        "PLAT-7: Issue 7",
      );
      // The watermark advanced to the re-fetched issue's newer provider timestamp.
      const metadata = readConnectorSourceMetadata(
        pod.store,
        pod.capsule.id,
        connectorSourceIdFor(pod.capsule.id),
      );
      expect(metadata?.providerWatermark).toBe(RICH_ISSUE_UPDATED_RUN2);
    } finally {
      pod.close();
    }
  });
});

describe("Jira sync — degradation and validation", () => {
  it("maps a revoked token (401) on enumeration to failed/auth-failed with a sync-project activity record", async () => {
    const port = createInMemoryJiraFixture({
      baseUrl: BASE_URL,
      projects: [{ key: "PLAT", issues: [plainIssue(1)] }],
      override: () => ({
        kind: "response",
        status: 401,
        bodyText: "",
        bodyBytes: 0,
        truncated: false,
      }),
    });
    const { deps, credential } = depsFor(port);
    const started = await startSync(deps, credential, { projectKeys: ["PLAT"] });
    const terminal = await awaitTerminal(started.job.jobId);
    expect(terminal.status).toBe("failed");
    if (terminal.status !== "failed") return;
    expect(terminal.failureReason).toBe("auth-failed");
    const activity = atlassianSyncJobRegistry.listActivity(terminal.connectorId);
    expect(activity[0]).toMatchObject({
      actionType: "sync-project",
      provider: "jira",
      outcome: "failed",
      reasonCode: "auth-failed",
    });
  });

  it("fails closed on provider-mismatched scope fields, oversized JQL, and scope input on re-sync", async () => {
    const port = createInMemoryJiraFixture({
      baseUrl: BASE_URL,
      projects: [{ key: "PLAT", issues: [plainIssue(1)] }],
    });
    const { deps, credential } = depsFor(port);

    const spaceKeysOnJira = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: credential.authRef }, { spaceKeys: ["ENG"] }),
      deps,
    );
    expect(spaceKeysOnJira.status).toBe(400);

    const badProjectKeys = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: credential.authRef }, { projectKeys: ["lowercase"] }),
      deps,
    );
    expect(badProjectKeys.status).toBe(400);

    const emptyProjectKeys = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: credential.authRef }, { projectKeys: [] }),
      deps,
    );
    expect(emptyProjectKeys.status).toBe(400);

    const oversizedJql = await handleStartAtlassianConnectorSync(
      ctxFor(
        "POST",
        { authRef: credential.authRef },
        { projectKeys: ["PLAT"], jql: "x".repeat(2_049) },
      ),
      deps,
    );
    expect(oversizedJql.status).toBe(400);

    const started = await startSync(deps, credential, { projectKeys: ["PLAT"] });
    await awaitTerminal(started.job.jobId);
    const resyncWithScope = await handleStartAtlassianConnectorSync(
      ctxFor(
        "POST",
        { authRef: credential.authRef },
        { capsuleId: started.capsuleId, jql: "labels = widened" },
      ),
      deps,
    );
    expect(resyncWithScope.status).toBe(400);
  });
});
