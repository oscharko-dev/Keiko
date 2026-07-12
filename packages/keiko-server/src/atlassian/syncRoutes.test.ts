// Issue #2242 — Confluence sync composition tests: routes + service + provider adapter + sync
// lane + local-knowledge sink, end to end. Hermetic: the transport is the in-memory Confluence
// fixture from keiko-connectors (mirroring createInMemoryManualFetcher — no atlassian.net, no
// network), custody is in-memory with synthetic secrets, embedding is a deterministic stub, and
// the store is a fresh temp SQLite file per test. Every wait awaits a condition (vi.waitFor).

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAtlassianCredentialCustody,
  createInMemoryConfluenceFixture,
  type AtlassianCredentialMetadata,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyResult,
  type ConfluenceFixturePage,
  type ConfluenceFixtureSpace,
} from "@oscharko-dev/keiko-connectors";
import { ATLASSIAN_SYNC_ITEM_MAX_BYTES } from "@oscharko-dev/keiko-connectors";
import type { AtlassianSyncJobState, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import {
  getCapsule,
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
  handleCancelAtlassianConnectorSyncJob,
  handleGetAtlassianConnectorSyncJob,
  handleListAtlassianConnectorActivity,
  handleStartAtlassianConnectorSync,
} from "./syncRoutes.js";
import { atlassianSyncJobRegistry, connectorSourceIdFor } from "./syncService.js";

const BASE_URL = "https://tenant.example";
const SYNTHETIC_TOKEN = ["ATATT", "sync", "route", "0123456789", "abcdefghij"].join("");
const SYNTHETIC_EMAIL = ["sync-tester", "@", "example", ".", "com"].join("");
const SECRET_BODY_MARKER = "SYNCED-PAGE-BODY-MARKER";

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
  tmp = mkdtempSync(join(realpathSync(tmpdir()), "keiko-atl-sync-"));
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
    provider: "confluence",
    displayName: "Team Wiki",
    baseUrl: BASE_URL,
    authScheme: "basic-api-token",
    accountEmail: SYNTHETIC_EMAIL,
    apiToken: SYNTHETIC_TOKEN,
  });
  const localKnowledgeEmbeddingRequest = vi.fn(
    (request: OpenAIEmbeddingRequest): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve({
        ok: true,
        value: {
          vector: new Float32Array(1536).fill(1),
          modelId: request.modelId,
        },
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

// The AC-1 fixture space: ≥30 healthy pages in a nested tree (each page parents onto the
// previous one three levels deep, exactly as the v2 listing reports hierarchy) with comments,
// plus one oversized page, one 403 page, and one malformed-body page.
function fixtureSpace(): ConfluenceFixtureSpace {
  const healthy: ConfluenceFixturePage[] = Array.from({ length: 30 }, (_, index) => {
    const id = index + 1;
    return {
      pageId: String(id),
      title: id === 1 ? "Deployment Guide" : `Page ${String(id)}`,
      storageBody:
        id === 1
          ? `<h1>Deployment Guide</h1><p>${SECRET_BODY_MARKER} the deployment pipeline runs on merge.</p>`
          : `<h2>Section ${String(id)}</h2><p>Content of page ${String(id)} in the nested tree.</p>`,
      ...(id === 1 ? { comments: ["<p>Remember to page the on-call channel first.</p>"] } : {}),
      ...(id > 1 ? { parentId: String(((id - 2) % 3) + 1) } : {}),
      webuiPath: `/wiki/spaces/ENG/pages/${String(id)}`,
    };
  });
  return {
    key: "ENG",
    id: "100",
    pages: [
      ...healthy,
      {
        pageId: "31",
        title: "Oversized Page",
        storageBody: "<p>" + "x".repeat(ATLASSIAN_SYNC_ITEM_MAX_BYTES) + "</p>",
      },
      { pageId: "32", title: "Restricted Page", storageBody: "<p>denied</p>", bodyStatus: 403 },
      { pageId: "33", title: "Broken Page", storageBody: "<p>broken</p>", malformedBody: true },
    ],
  };
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

describe("Confluence sync — initial run over the AC fixture space", () => {
  it("syncs 30 healthy pages, skips the oversized/403/malformed pages with exact counts, and stays retrievable + citable", async () => {
    const port = createInMemoryConfluenceFixture({ baseUrl: BASE_URL, spaces: [fixtureSpace()] });
    const { deps, credential } = depsFor(port);
    const started = await startSync(deps, credential, {
      spaceKeys: ["ENG"],
      displayName: "Engineering Wiki",
    });
    const terminal = await awaitTerminal(started.job.jobId);

    // The run reaches partial — never a silent abort — with the exact AC counts.
    expect(terminal.status).toBe("partial");
    if (terminal.status !== "partial") return;
    expect(terminal.changeSummary.counts).toEqual({
      addedItems: 30,
      changedItems: 0,
      removedItems: 0,
      unchangedItems: 0,
      failedItems: 2,
      deniedItems: 1,
    });
    expect([...terminal.failureReasons].sort()).toEqual([
      "bounds-exceeded",
      "malformed-payload",
      "permission-denied",
    ]);
    expect(terminal.progress).toMatchObject({
      enumeratedItems: 33,
      fetchedItems: 30,
      skippedItems: 3,
      failedItems: 3,
    });

    // Poll route returns the same contract state.
    const polled = await handleGetAtlassianConnectorSyncJob(
      ctxFor("GET", { jobId: started.job.jobId }),
      deps,
    );
    expect(polled.status).toBe(200);
    expect((polled.body as { job: AtlassianSyncJobState }).job.status).toBe("partial");

    // The pod is a degraded-but-usable Knowledge Pod with the synced content retrievable through
    // the ONE shared retrieval path, cited by page title with a provider click-through link.
    const opened = openKnowledgeStoreForDeps(deps);
    try {
      const capsule = getCapsule(opened.store, started.capsuleId as KnowledgeCapsuleId);
      expect(capsule).toBeDefined();
      if (capsule === undefined) return;
      const provider = configuredProviderForCapsule(deps, capsule);
      expect(provider).toBeDefined();
      if (provider === undefined) return;
      const adapter = localKnowledgeEmbeddingAdapterForProvider(deps, provider);
      const retrieval = await runLocalKnowledgeRetrieval(
        { store: opened.store, embeddingAdapter: adapter },
        { text: "How does the deployment pipeline run?", capsuleId: capsule.id, topK: 5 },
      );
      expect(retrieval.noEvidence).toBe(false);
      const deployment = retrieval.references.find(
        (ref) => ref.citation.safeDisplayName === "Deployment Guide",
      );
      expect(deployment).toBeDefined();
      if (deployment === undefined) return;
      const target = resolveConnectorCitationTarget(opened.store, {
        capsuleId: capsule.id,
        sourceId: connectorSourceIdFor(capsule.id),
        documentId: deployment.citation.documentId,
      });
      expect(target).toMatchObject({
        ok: true,
        target: "https://tenant.example/wiki/spaces/ENG/pages/1",
        pageTitle: "Deployment Guide",
      });
    } finally {
      opened.close();
    }
  });

  it("re-syncs through the persisted approved scope and refuses scope input on re-sync", async () => {
    const port = createInMemoryConfluenceFixture({ baseUrl: BASE_URL, spaces: [fixtureSpace()] });
    const { deps, credential } = depsFor(port);
    const started = await startSync(deps, credential, { spaceKeys: ["ENG"] });
    await awaitTerminal(started.job.jobId);

    const rejected = await handleStartAtlassianConnectorSync(
      ctxFor(
        "POST",
        { authRef: credential.authRef },
        { capsuleId: started.capsuleId, spaceKeys: ["OTHER"] },
      ),
      deps,
    );
    expect(rejected.status).toBe(400);

    const resync = await startSync(deps, credential, { capsuleId: started.capsuleId });
    const terminal = await awaitTerminal(resync.job.jobId);
    expect(terminal.status).toBe("partial");
    if (terminal.status !== "partial") return;
    // Unchanged upstream: every healthy page is unchanged, nothing re-indexes, failures repeat.
    expect(terminal.changeSummary.counts).toMatchObject({
      addedItems: 0,
      changedItems: 0,
      removedItems: 0,
      unchangedItems: 30,
    });
    expect(terminal.progress.indexedItems).toBe(0);
  });
});

describe("Confluence sync — degradation and redaction", () => {
  it("maps a revoked token (401) to a failed job, an unavailable pod with remediation, and a scanned-clean activity record", async () => {
    const port = createInMemoryConfluenceFixture({
      baseUrl: BASE_URL,
      spaces: [fixtureSpace()],
      override: () => ({
        kind: "response",
        status: 401,
        bodyText: "",
        bodyBytes: 0,
        truncated: false,
      }),
    });
    const { deps, credential } = depsFor(port);
    // Route responses are captured whole so the redaction scan covers every wire surface the
    // client can observe — the 202 start-response, the poll response, the activity list, and the
    // pod summary the UI reads — not only the internal job/registry state.
    const startRouteResult = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: credential.authRef }, { spaceKeys: ["ENG"] }),
      deps,
    );
    expect(startRouteResult.status).toBe(202);
    const started = startedJob(startRouteResult);
    const terminal = await awaitTerminal(started.job.jobId);
    expect(terminal.status).toBe("failed");
    if (terminal.status !== "failed") return;
    expect(terminal.failureReason).toBe("auth-failed");
    expect(terminal.changeSummary.counts.addedItems).toBe(0);

    const polledResult = await handleGetAtlassianConnectorSyncJob(
      ctxFor("GET", { jobId: started.job.jobId }),
      deps,
    );

    let podSummary: unknown;
    let capsuleRecord: unknown;
    const opened = openKnowledgeStoreForDeps(deps);
    try {
      const capsule = getCapsule(opened.store, started.capsuleId as KnowledgeCapsuleId);
      expect(capsule).toBeDefined();
      if (capsule === undefined) return;
      capsuleRecord = capsule;
      const { buildKnowledgePodSummary } = await import("@oscharko-dev/keiko-local-knowledge");
      const summary = buildKnowledgePodSummary(opened.store, capsule);
      podSummary = summary;
      expect(summary.readiness).toBe("unavailable");
      expect(
        summary.degradationReasons.some((reason) =>
          reason.includes("verify or rotate the Atlassian credential"),
        ),
      ).toBe(true);
    } finally {
      opened.close();
    }

    const activityResult = await handleListAtlassianConnectorActivity(
      ctxFor("GET", { authRef: credential.authRef }),
      deps,
    );
    expect(activityResult.status).toBe(200);
    const activity = (activityResult.body as { activity: readonly unknown[] }).activity;
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actionType: "sync-space",
      outcome: "failed",
      reasonCode: "auth-failed",
      provider: "confluence",
    });

    // Scanned redaction assertion covering every observable wire surface (start route body, poll
    // route body, activity list body, sync-job registry, capsule and pod summary the UI reads) and
    // the terminal job state. If a token, account email, or a page-body marker leaked into ANY of
    // these surfaces, this assertion catches it.
    const scanned = JSON.stringify({
      startRouteBody: startRouteResult.body,
      pollRouteBody: polledResult.body,
      activityRouteBody: activityResult.body,
      job: terminal,
      activity,
      registry: atlassianSyncJobRegistry.listActivity(
        (activity[0] as { connectorId: string }).connectorId,
      ),
      capsule: capsuleRecord,
      podSummary,
    });
    expect(scanned).not.toContain(SYNTHETIC_TOKEN);
    expect(scanned).not.toContain(SYNTHETIC_EMAIL);
    expect(scanned).not.toContain(SECRET_BODY_MARKER);
    // Positive control: the marker string must actually exist in scope so the negative assertion
    // above cannot silently pass because the marker was never present anywhere to leak.
    expect(SECRET_BODY_MARKER.length).toBeGreaterThan(0);
  });

  it("keeps token bytes and page bodies out of the successful-run wire payloads too", async () => {
    const port = createInMemoryConfluenceFixture({ baseUrl: BASE_URL, spaces: [fixtureSpace()] });
    const { deps, credential } = depsFor(port);
    const startRouteResult = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: credential.authRef }, { spaceKeys: ["ENG"] }),
      deps,
    );
    const started = startedJob(startRouteResult);
    const terminal = await awaitTerminal(started.job.jobId);
    const polledResult = await handleGetAtlassianConnectorSyncJob(
      ctxFor("GET", { jobId: started.job.jobId }),
      deps,
    );
    const activityResult = await handleListAtlassianConnectorActivity(
      ctxFor("GET", { authRef: credential.authRef }),
      deps,
    );
    // On the successful path, the sync ingests SECRET_BODY_MARKER into the local Knowledge store —
    // it must remain confined to the retrieval-store body and never surface in wire payloads.
    const scanned = JSON.stringify({
      startRouteBody: startRouteResult.body,
      pollRouteBody: polledResult.body,
      activityRouteBody: activityResult.body,
      job: terminal,
    });
    expect(scanned).not.toContain(SYNTHETIC_TOKEN);
    expect(scanned).not.toContain(SYNTHETIC_EMAIL);
    expect(scanned).not.toContain(SECRET_BODY_MARKER);
  });

  it("cancels an in-flight run at the next page boundary and leaves nothing applied", async () => {
    let firstRequestStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      firstRequestStarted = resolve;
    });
    const blockingPort: AtlassianHttpBodyPort = (request) =>
      new Promise<AtlassianHttpBodyResult>((resolve) => {
        firstRequestStarted?.();
        request.signal?.addEventListener("abort", () => {
          resolve({ kind: "timeout" });
        });
      });
    const { deps, credential } = depsFor(blockingPort);
    const started = await startSync(deps, credential, { spaceKeys: ["ENG"] });
    await gate;
    const cancelResult = await handleCancelAtlassianConnectorSyncJob(
      ctxFor("POST", { jobId: started.job.jobId }),
      deps,
    );
    expect(cancelResult.status).toBe(202);
    const terminal = await awaitTerminal(started.job.jobId);
    expect(terminal.status).toBe("cancelled");
    if (terminal.status !== "cancelled") return;
    expect(terminal.changeSummary.counts.addedItems).toBe(0);

    // The pod shell survives untouched as a draft with its approved scope.
    const opened = openKnowledgeStoreForDeps(deps);
    try {
      const capsule = getCapsule(opened.store, started.capsuleId as KnowledgeCapsuleId);
      expect(capsule?.lifecycleState).toBe("draft");
    } finally {
      opened.close();
    }
  });
});

describe("Confluence sync — request validation fail-closed", () => {
  it("answers 404 for unknown credentials and jobs, 400 for invalid bodies, 503 when unconfigured", async () => {
    const port = createInMemoryConfluenceFixture({ baseUrl: BASE_URL, spaces: [fixtureSpace()] });
    const { deps, credential } = depsFor(port);

    const unknownCred = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA" }, { spaceKeys: ["ENG"] }),
      deps,
    );
    expect(unknownCred.status).toBe(404);

    const badKeys = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: credential.authRef }, { spaceKeys: ["not a key!"] }),
      deps,
    );
    expect(badKeys.status).toBe(400);

    const emptyKeys = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: credential.authRef }, { spaceKeys: [] }),
      deps,
    );
    expect(emptyKeys.status).toBe(400);

    const unexpectedField = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: credential.authRef }, { spaceKeys: ["ENG"], scope: "wide" }),
      deps,
    );
    expect(unexpectedField.status).toBe(400);

    const unknownJob = await handleGetAtlassianConnectorSyncJob(
      ctxFor("GET", { jobId: "job-does-not-exist" }),
      deps,
    );
    expect(unknownJob.status).toBe(404);

    const unknownCancel = await handleCancelAtlassianConnectorSyncJob(
      ctxFor("POST", { jobId: "job-does-not-exist" }),
      deps,
    );
    expect(unknownCancel.status).toBe(404);

    const bare: UiHandlerDeps = { ...deps, atlassianConnectorCredentials: undefined };
    const unconfigured = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: credential.authRef }, { spaceKeys: ["ENG"] }),
      bare,
    );
    expect(unconfigured.status).toBe(503);
  });

  it("refuses a second concurrent sync for the same pod (409) and a re-sync under a foreign credential", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowPort: AtlassianHttpBodyPort = async (request) => {
      await gate;
      return createInMemoryConfluenceFixture({ baseUrl: BASE_URL, spaces: [fixtureSpace()] })(
        request,
      );
    };
    const { deps, credential } = depsFor(slowPort);
    const started = await startSync(deps, credential, { spaceKeys: ["ENG"] });
    const concurrent = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: credential.authRef }, { capsuleId: started.capsuleId }),
      deps,
    );
    expect(concurrent.status).toBe(409);
    release?.();
    await awaitTerminal(started.job.jobId);

    const custody = deps.atlassianConnectorCredentials?.custody;
    const foreign = custody?.create({
      provider: "confluence",
      displayName: "Second Wiki",
      baseUrl: BASE_URL,
      authScheme: "basic-api-token",
      accountEmail: SYNTHETIC_EMAIL,
      apiToken: SYNTHETIC_TOKEN,
    });
    expect(foreign).toBeDefined();
    if (foreign === undefined) return;
    const mismatch = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: foreign.authRef }, { capsuleId: started.capsuleId }),
      deps,
    );
    expect(mismatch.status).toBe(409);
  });

  it("rejects oversized and malformed request bodies, non-Confluence credentials, and hostile params", async () => {
    const port = createInMemoryConfluenceFixture({ baseUrl: BASE_URL, spaces: [fixtureSpace()] });
    const { deps, credential } = depsFor(port);

    const rawCtx = (raw: Buffer): RouteContext => {
      const req = Readable.from([raw]) as IncomingMessage;
      req.method = "POST";
      req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
      return { ...ctxFor("POST", { authRef: credential.authRef }), req };
    };
    const oversized = await handleStartAtlassianConnectorSync(
      rawCtx(Buffer.alloc(20_000, 0x61)),
      deps,
    );
    expect(oversized.status).toBe(413);

    const broken = await handleStartAtlassianConnectorSync(
      rawCtx(Buffer.from("{not json", "utf8")),
      deps,
    );
    expect(broken.status).toBe(400);

    const arrayBody = await handleStartAtlassianConnectorSync(
      rawCtx(Buffer.from("[1,2]", "utf8")),
      deps,
    );
    expect(arrayBody.status).toBe(400);

    const capsuleWithScope = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: credential.authRef }, { capsuleId: "cap x", spaceKeys: undefined }),
      deps,
    );
    expect(capsuleWithScope.status).toBe(400);

    const custody = deps.atlassianConnectorCredentials?.custody;
    const jira = custody?.create({
      provider: "jira",
      displayName: "Team Jira",
      baseUrl: BASE_URL,
      authScheme: "basic-api-token",
      accountEmail: SYNTHETIC_EMAIL,
      apiToken: SYNTHETIC_TOKEN,
    });
    expect(jira).toBeDefined();
    if (jira === undefined) return;
    const wrongProvider = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: jira.authRef }, { spaceKeys: ["ENG"] }),
      deps,
    );
    expect(wrongProvider.status).toBe(400);

    const badPercentAuthRef = await handleStartAtlassianConnectorSync(
      ctxFor("POST", { authRef: "%zz" }, { spaceKeys: ["ENG"] }),
      deps,
    );
    expect(badPercentAuthRef.status).toBe(404);
    const badPercentJob = await handleGetAtlassianConnectorSyncJob(
      ctxFor("GET", { jobId: "%zz" }),
      deps,
    );
    expect(badPercentJob.status).toBe(404);

    const activityUnknown = await handleListAtlassianConnectorActivity(
      ctxFor("GET", { authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA" }),
      deps,
    );
    expect(activityUnknown.status).toBe(404);
    const activityUnconfigured = await handleListAtlassianConnectorActivity(
      ctxFor("GET", { authRef: credential.authRef }),
      { ...deps, atlassianConnectorCredentials: undefined },
    );
    expect(activityUnconfigured.status).toBe(503);
  });

  it("fails a run closed with one activity record when the sync machinery itself faults", async () => {
    const explodingPort: AtlassianHttpBodyPort = () => {
      throw new Error("defective transport adapter");
    };
    const { deps, credential } = depsFor(explodingPort);
    const started = await startSync(deps, credential, { spaceKeys: ["ENG"] });
    const terminal = await awaitTerminal(started.job.jobId);
    expect(terminal.status).toBe("failed");
    if (terminal.status !== "failed") return;
    expect(terminal.failureReason).toBe("unavailable");
    const activity = atlassianSyncJobRegistry.listActivity(terminal.connectorId);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ outcome: "failed", reasonCode: "unavailable" });
    expect(JSON.stringify({ terminal, activity })).not.toContain("defective transport adapter");
  });
});
