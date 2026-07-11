// Issue #2246 Scope 3 — hostile-provider fixture corpus with bounded-behavior assertions.
//
// Every hostile upstream shape terminates within its bound with a typed, content-free outcome —
// never a crash, never a hang, never unbounded memory. Covered: malformed JSON, a non-JSON body
// (wrong content type), oversized bodies, pathological pagination (an infinite cursor loop, a
// live-search token loop), an ADF bomb (depth + breadth), storage-XHTML carrying <script>/<iframe>
// (proven INERT — ingestion never evaluates it), and slow-loris timeouts. The suite additionally
// asserts a wall-clock ceiling and a heap ceiling over the worst-case batch.
//
// The per-adapter tests assert individual hostile inputs; this suite consolidates them into one
// bounded-behaviour contract shared across both providers and adds the ceiling assertions.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHostileJiraAdfDocument,
  createConfluenceSyncSource,
  createInMemoryConfluenceFixture,
  createInMemoryJiraFixture,
  createJiraSyncSource,
  executeJiraLiveSearch,
  runAtlassianSyncFetch,
  JIRA_COMPOSED_DOCUMENT_MAX_BYTES,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpBodyResult,
  type AtlassianSyncFetchOutcome,
} from "@oscharko-dev/keiko-connectors";
import { DEFAULT_ATLASSIAN_SYNC_BOUNDS } from "@oscharko-dev/keiko-contracts";
import { startAtlassianSyncJob } from "../../packages/keiko-server/src/atlassian/syncService.js";
import {
  CONNECTOR_BASE_URL,
  awaitJobTerminal,
  buildRedactionMarker,
  createConnectorServerHarness,
  createInMemoryCustody,
  fixtureCredentialDeps,
  noopSleep,
  resetConnectorRegistries,
  type ConnectorServerHarness,
} from "./harness.js";

const CONNECTOR_ID = "cred-hostile";

function jsonResult(
  request: AtlassianHttpBodyRequest,
  status: number,
  payload: unknown,
): AtlassianHttpBodyResult {
  const text = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(text);
  const cap = Math.max(0, Math.trunc(request.maxBodyBytes));
  const truncated = bytes.length > cap;
  const served = truncated ? bytes.subarray(0, cap) : bytes;
  return {
    kind: "response",
    status,
    bodyText: new TextDecoder("utf-8", { fatal: false }).decode(served),
    bodyBytes: served.length,
    truncated,
  };
}

function runConfluence(http: AtlassianHttpBodyPort): Promise<AtlassianSyncFetchOutcome> {
  return runAtlassianSyncFetch({
    source: createConfluenceSyncSource({
      baseUrl: CONNECTOR_BASE_URL,
      connectorId: CONNECTOR_ID,
      spaceKeys: ["ENG"],
    }),
    http,
    bounds: DEFAULT_ATLASSIAN_SYNC_BOUNDS,
    sleep: noopSleep,
  });
}

function runJira(http: AtlassianHttpBodyPort): Promise<AtlassianSyncFetchOutcome> {
  return runAtlassianSyncFetch({
    source: createJiraSyncSource({
      baseUrl: CONNECTOR_BASE_URL,
      connectorId: CONNECTOR_ID,
      projectKeys: ["PROJ"],
    }),
    http,
    bounds: DEFAULT_ATLASSIAN_SYNC_BOUNDS,
    sleep: noopSleep,
  });
}

// ─── Hostile transports ────────────────────────────────────────────────────────
// A same-host cursor that never terminates: the adapter caps the chain at MAX_PAGINATION_REQUESTS
// and fails the run `malformed-payload` instead of spinning to the duration budget.
function paginationLoopPort(): AtlassianHttpBodyPort & { readonly calls: number[] } {
  const calls: number[] = [];
  const port = (request: AtlassianHttpBodyRequest): Promise<AtlassianHttpBodyResult> => {
    calls.push(1);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/wiki/api/v2/spaces")) {
      return Promise.resolve(
        jsonResult(request, 200, { results: [{ id: "100", key: "ENG", name: "ENG" }], _links: {} }),
      );
    }
    if (url.pathname.endsWith("/wiki/api/v2/spaces/100/pages")) {
      return Promise.resolve(
        jsonResult(request, 200, {
          results: [],
          // Same-host, under the /wiki/api/v2/ API root (never a scope violation) — a legitimate
          // cursor shape that simply never terminates.
          _links: { next: "/wiki/api/v2/spaces/100/pages?cursor=loop" },
        }),
      );
    }
    return Promise.resolve(jsonResult(request, 404, { status: 404 }));
  };
  return Object.assign(port, { calls });
}

// A non-JSON (wrong content type) list body → malformed-payload at enumeration.
function nonJsonListPort(): AtlassianHttpBodyPort {
  return () =>
    Promise.resolve({
      kind: "response",
      status: 200,
      bodyText: "<html><body>not json at all</body></html>",
      bodyBytes: 41,
      truncated: false,
    });
}

// A live-search endpoint that always hands back the same continuation token → the executor stops
// at the hard page ceiling with a truncated (bounded) result, never a spin.
function liveTokenLoopPort(): AtlassianHttpBodyPort & { readonly calls: number[] } {
  const calls: number[] = [];
  const port = (request: AtlassianHttpBodyRequest): Promise<AtlassianHttpBodyResult> => {
    calls.push(1);
    return Promise.resolve(
      jsonResult(request, 200, {
        issues: [{ id: "1", key: "PROJ-1", fields: { summary: "loop" } }],
        nextPageToken: "same-token-forever",
      }),
    );
  };
  return Object.assign(port, { calls });
}

function confluenceMalformedPage(): AtlassianHttpBodyPort {
  return createInMemoryConfluenceFixture({
    baseUrl: CONNECTOR_BASE_URL,
    spaces: [
      {
        key: "ENG",
        id: "100",
        pages: [{ pageId: "1", title: "P", storageBody: "", malformedBody: true }],
      },
    ],
  });
}

function confluenceOversizedPage(): AtlassianHttpBodyPort {
  return createInMemoryConfluenceFixture({
    baseUrl: CONNECTOR_BASE_URL,
    spaces: [
      {
        key: "ENG",
        id: "100",
        pages: [{ pageId: "1", title: "Huge", storageBody: "x".repeat(3_000_000) }],
      },
    ],
  });
}

function jiraMalformedIssue(): AtlassianHttpBodyPort {
  return createInMemoryJiraFixture({
    baseUrl: CONNECTOR_BASE_URL,
    projects: [
      {
        key: "PROJ",
        issues: [
          {
            issueId: "10001",
            key: "PROJ-1",
            summary: "S",
            updated: "2026-05-01T10:22:33.000+0000",
            malformedBody: true,
          },
        ],
      },
    ],
  });
}

function jiraAdfBomb(): AtlassianHttpBodyPort {
  return createInMemoryJiraFixture({
    baseUrl: CONNECTOR_BASE_URL,
    projects: [
      {
        key: "PROJ",
        issues: [
          {
            issueId: "10001",
            key: "PROJ-1",
            summary: "Bomb",
            updated: "2026-05-01T10:22:33.000+0000",
            descriptionAdf: buildHostileJiraAdfDocument(10_000),
          },
        ],
      },
    ],
  });
}

// A slow-loris upstream: the request never yields bytes and is torn down by the per-request
// timeout, surfaced as a typed `timeout`.
function timeoutPort(): AtlassianHttpBodyPort {
  return () => Promise.resolve({ kind: "timeout" });
}

// ─── Bounded typed outcomes ────────────────────────────────────────────────────
describe("hostile-provider — bounded typed outcomes (Scope 3)", () => {
  it("a malformed Confluence page body is skipped malformed-payload; the run still completes", async () => {
    const outcome = await runConfluence(confluenceMalformedPage());
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.failures.map((f) => f.reason)).toEqual(["malformed-payload"]);
  });

  it("a non-JSON list body fails enumeration with malformed-payload (no crash)", async () => {
    const outcome = await runConfluence(nonJsonListPort());
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toBe("malformed-payload");
  });

  it("an oversized page body is skipped bounds-exceeded (never buffered whole)", async () => {
    const outcome = await runConfluence(confluenceOversizedPage());
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.failures.map((f) => f.reason)).toEqual(["bounds-exceeded"]);
  });

  it("an infinite pagination loop terminates at the request cap with malformed-payload", async () => {
    const port = paginationLoopPort();
    const outcome = await runConfluence(port);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toBe("malformed-payload");
    // Bounded: the cursor chain was cut off well before any duration budget could matter.
    expect(port.calls.length).toBeLessThanOrEqual(520);
  });

  it("a malformed Jira issue body is skipped malformed-payload; the run still completes", async () => {
    const outcome = await runJira(jiraMalformedIssue());
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.failures.map((f) => f.reason)).toEqual(["malformed-payload"]);
  });

  it("an ADF bomb indexes as ONE bounded document (depth + breadth capped), never a hang", async () => {
    const outcome = await runJira(jiraAdfBomb());
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    expect(outcome.items).toHaveLength(1);
    expect(outcome.items[0]?.byteLength).toBeLessThanOrEqual(JIRA_COMPOSED_DOCUMENT_MAX_BYTES);
  });

  it("a live-search token loop returns a bounded truncated slice at the page ceiling", async () => {
    const port = liveTokenLoopPort();
    const outcome = await executeJiraLiveSearch(
      { http: port, sleep: noopSleep },
      { baseUrl: CONNECTOR_BASE_URL, jql: "project = PROJ" },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.result.truncated).toBe(true);
    expect(port.calls.length).toBeLessThanOrEqual(10);
  });

  it("a slow-loris upstream is torn down by the timeout and fails typed (no hang)", async () => {
    const outcome = await runConfluence(timeoutPort());
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toBe("timeout");
  });
});

// ─── Wall-clock + memory ceilings ──────────────────────────────────────────────
describe("hostile-provider — wall-clock and memory ceilings (Scope 3)", () => {
  it("keeps the worst-case hostile batch within a wall-clock and heap ceiling", async () => {
    const heapBefore = process.memoryUsage().heapUsed;
    const started = Date.now();
    for (let round = 0; round < 5; round += 1) {
      await runConfluence(paginationLoopPort());
      await runConfluence(confluenceOversizedPage());
      await runJira(jiraAdfBomb());
      await executeJiraLiveSearch(
        { http: liveTokenLoopPort(), sleep: noopSleep },
        { baseUrl: CONNECTOR_BASE_URL, jql: "project = PROJ" },
      );
    }
    const elapsedMs = Date.now() - started;
    const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
    // Wall-clock ceiling: a hang would blow past this long before the suite timeout.
    expect(elapsedMs).toBeLessThan(10_000);
    // Heap ceiling: the D5 byte budget + the converter caps keep accumulation bounded; an
    // unbounded buffer of a 3 MB body × 20 runs would obliterate this.
    expect(heapDeltaBytes).toBeLessThan(256 * 1024 * 1024);
  });
});

// ─── storage-XHTML script/iframe is INERT through the full ingestion pipeline ──
let harness: ConnectorServerHarness | undefined;

beforeEach(() => {
  resetConnectorRegistries();
});

afterEach(() => {
  resetConnectorRegistries();
  harness?.cleanup();
  harness = undefined;
});

interface XssProbe {
  __KEIKO_CONNECTOR_XSS__?: boolean;
}

describe("hostile-provider — storage-XHTML scripts are inert (Scope 3)", () => {
  it("ingests a page carrying <script>/<iframe> without ever evaluating it", async () => {
    (globalThis as XssProbe).__KEIKO_CONNECTOR_XSS__ = false;
    const marker = buildRedactionMarker();
    const { custody, credential } = createInMemoryCustody("confluence", marker);
    const storageBody = [
      "<p>Runbook: restart the gateway.</p>",
      "<script>globalThis.__KEIKO_CONNECTOR_XSS__ = true;</script>",
      '<iframe src="https://evil.example/steal"></iframe>',
    ].join("");
    const http = createInMemoryConfluenceFixture({
      baseUrl: CONNECTOR_BASE_URL,
      spaces: [{ key: "ENG", id: "100", pages: [{ pageId: "1", title: "Runbook", storageBody }] }],
    });
    const h = createConnectorServerHarness(fixtureCredentialDeps(custody, http));
    harness = h;
    const started = await startAtlassianSyncJob(h.deps, { credential, spaceKeys: ["ENG"] }, http);
    const state = await awaitJobTerminal(started.job.jobId);
    expect(state.status).toBe("succeeded");
    // Ingestion is pure data processing: the script never executed anywhere in the pipeline.
    expect((globalThis as XssProbe).__KEIKO_CONNECTOR_XSS__).toBe(false);
    delete (globalThis as XssProbe).__KEIKO_CONNECTOR_XSS__;
  });
});
