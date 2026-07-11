// Issue #2246 Scope 5 — scope preservation across re-syncs.
//
// Two fail-closed layers are proven together:
//   1. Provider-driven scope widening (a pagination cursor that would leave the approved base URL
//      / API root — the "moved page" / "cross-space link" smuggle) fails the RUN with
//      `scope-exceeded`, applies nothing, and never contacts the foreign target.
//   2. Caller-driven scope widening (a re-sync request that carries new space keys, new project
//      keys, or drifted JQL) is rejected at the route with 400, and the persisted approved scope
//      is byte-for-byte unchanged afterwards — a re-sync reconstructs its scope ONLY from the
//      persisted approved state (ADR-0128 D5), so drift is impossible by construction.
//
// Hermetic: in-memory fixtures, a fresh temp store per test, injected registries reset each test.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConfluenceSyncSource,
  runAtlassianSyncFetch,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import {
  DEFAULT_ATLASSIAN_SYNC_BOUNDS,
  type KnowledgeCapsuleId,
} from "@oscharko-dev/keiko-contracts";
import { readConnectorSourceMetadata } from "@oscharko-dev/keiko-local-knowledge";
import type { RouteContext } from "../../packages/keiko-server/src/routes.js";
import { openKnowledgeStoreForDeps } from "../../packages/keiko-server/src/local-knowledge-store-open.js";
import {
  connectorSourceIdFor,
  startAtlassianSyncJob,
} from "../../packages/keiko-server/src/atlassian/syncService.js";
import { handleStartAtlassianConnectorSync } from "../../packages/keiko-server/src/atlassian/syncRoutes.js";
import {
  CONNECTOR_BASE_URL,
  awaitJobTerminal,
  buildRedactionMarker,
  createConnectorServerHarness,
  createInMemoryCustody,
  fixtureCredentialDeps,
  noopSleep,
  resetConnectorRegistries,
  routeCtx,
  type ConnectorServerHarness,
} from "./harness.js";
import type { UiHandlerDeps } from "../../packages/keiko-server/src/deps.js";

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

// A Confluence transport whose page listing carries a hostile `_links.next` cursor. The request
// log lets a test prove the foreign cursor target was never contacted.
function hostileCursorPort(nextUrl: string, log: string[]): AtlassianHttpBodyPort {
  return (request) => {
    log.push(request.url);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/wiki/api/v2/spaces")) {
      return Promise.resolve(
        jsonResult(request, 200, { results: [{ id: "100", key: "ENG", name: "ENG" }], _links: {} }),
      );
    }
    if (url.pathname.endsWith("/wiki/api/v2/spaces/100/pages")) {
      return Promise.resolve(
        jsonResult(request, 200, {
          results: [{ id: "1", title: "Page", status: "current", parentId: null }],
          _links: { next: nextUrl },
        }),
      );
    }
    return Promise.resolve(jsonResult(request, 404, { status: 404 }));
  };
}

const HOSTILE_CURSORS: Readonly<Record<string, string>> = {
  "off-host": "https://evil.example/wiki/api/v2/spaces/100/pages?cursor=10",
  "protocol downgrade": "http://tenant.example/wiki/api/v2/spaces/100/pages?cursor=10",
  "off-api-root": "https://tenant.example/some/other/path?cursor=10",
};

describe("scope preservation — provider cursor widening fails closed (Scope 5)", () => {
  it.each(Object.entries(HOSTILE_CURSORS))(
    "a %s pagination cursor fails the run with scope-exceeded and applies nothing",
    async (_label, nextUrl) => {
      const log: string[] = [];
      const outcome = await runAtlassianSyncFetch({
        source: createConfluenceSyncSource({
          baseUrl: CONNECTOR_BASE_URL,
          connectorId: "cred-scope",
          spaceKeys: ["ENG"],
        }),
        http: hostileCursorPort(nextUrl, log),
        bounds: DEFAULT_ATLASSIAN_SYNC_BOUNDS,
        sleep: noopSleep,
      });
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") throw new Error("unreachable");
      expect(outcome.reason).toBe("scope-exceeded");
      expect(outcome.applicable).toBe(false);
      // The foreign cursor target was refused before any request left for it.
      expect(log.some((url) => url.includes("evil.example"))).toBe(false);
      expect(log.some((url) => url.startsWith("http://"))).toBe(false);
      expect(log.some((url) => url.includes("/some/other/path"))).toBe(false);
    },
  );
});

// ─── Route-level: caller cannot widen scope on re-sync ─────────────────────────
let harness: ConnectorServerHarness | undefined;

beforeEach(() => {
  resetConnectorRegistries();
});

afterEach(() => {
  resetConnectorRegistries();
  harness?.cleanup();
  harness = undefined;
});

interface StartedPod {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly requestedSpaceKeys: string[];
}

function confluenceScopeFixture(requestLog: string[]): AtlassianHttpBodyPort {
  const pages = [{ pageId: "1", title: "Runbook", storageBody: "<p>ok</p>" }];
  return (request) => {
    requestLog.push(request.url);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/wiki/api/v2/spaces")) {
      const keys = (url.searchParams.get("keys") ?? "").split(",").filter((k) => k.length > 0);
      const results = keys
        .filter((key) => key === "ENG")
        .map((key) => ({ id: "100", key, name: key }));
      return Promise.resolve(jsonResult(request, 200, { results, _links: {} }));
    }
    if (url.pathname.endsWith("/wiki/api/v2/spaces/100/pages")) {
      return Promise.resolve(
        jsonResult(request, 200, {
          results: pages.map((p) => ({ id: p.pageId, title: p.title, status: "current" })),
          _links: {},
        }),
      );
    }
    const pageMatch = /\/wiki\/api\/v2\/pages\/([0-9]+)$/u.exec(url.pathname);
    const page = pageMatch === null ? undefined : pages.find((p) => p.pageId === pageMatch[1]);
    if (page !== undefined && !url.pathname.endsWith("/footer-comments")) {
      return Promise.resolve(
        jsonResult(request, 200, {
          id: page.pageId,
          title: page.title,
          body: { storage: { value: page.storageBody, representation: "storage" } },
          _links: { webui: `/wiki/spaces/ENG/pages/${page.pageId}` },
        }),
      );
    }
    return Promise.resolve(jsonResult(request, 200, { results: [], _links: {} }));
  };
}

async function startConfluencePod(deps: UiHandlerDeps, authRef: string): Promise<StartedPod> {
  const port = deps.atlassianConnectorCredentials?.httpBodyPortFactory({
    schemaVersion: "1",
    authRef,
    provider: "confluence",
    displayName: "Team Wiki",
    baseUrl: CONNECTOR_BASE_URL,
    authScheme: "basic-api-token",
    createdAt: 1,
  });
  if (port === undefined) throw new Error("no connector body port");
  const started = await startAtlassianSyncJob(
    deps,
    { credential: depsCredential(deps, authRef), spaceKeys: ["ENG"] },
    port,
  );
  const state = await awaitJobTerminal(started.job.jobId);
  expect(state.status).toBe("succeeded");
  return { capsuleId: started.capsuleId, requestedSpaceKeys: ["ENG"] };
}

function depsCredential(
  deps: UiHandlerDeps,
  authRef: string,
): Parameters<typeof startAtlassianSyncJob>[1]["credential"] {
  const metadata = deps.atlassianConnectorCredentials?.custody.getMetadata(authRef);
  if (metadata === undefined) throw new Error("credential missing");
  return metadata;
}

function readScope(
  deps: UiHandlerDeps,
  capsuleId: KnowledgeCapsuleId,
): {
  readonly scopeKeys: readonly string[];
  readonly jql: string | undefined;
} {
  const opened = openKnowledgeStoreForDeps(deps, { recover: true });
  try {
    const metadata = readConnectorSourceMetadata(
      opened.store,
      capsuleId,
      connectorSourceIdFor(capsuleId),
    );
    if (metadata === undefined) throw new Error("no persisted scope");
    return { scopeKeys: metadata.scopeKeys, jql: metadata.jql };
  } finally {
    opened.close();
  }
}

describe("scope preservation — re-sync cannot widen the approved scope (Scope 5)", () => {
  it("rejects a re-sync that smuggles a new space key and leaves the approved scope unchanged", async () => {
    const marker = buildRedactionMarker();
    const { custody, credential } = createInMemoryCustody("confluence", marker);
    const requestLog: string[] = [];
    const h = createConnectorServerHarness(
      fixtureCredentialDeps(custody, confluenceScopeFixture(requestLog)),
    );
    harness = h;
    const pod = await startConfluencePod(h.deps, credential.authRef);
    expect(readScope(h.deps, pod.capsuleId).scopeKeys).toEqual(["ENG"]);

    // Smuggle a new space key alongside the capsule id — the route refuses it (400).
    const smuggled = await handleStartAtlassianConnectorSync(
      routeCtx(
        { authRef: credential.authRef },
        { capsuleId: pod.capsuleId, spaceKeys: ["ENG", "SECRET"] },
      ) as unknown as RouteContext,
      h.deps,
    );
    expect(smuggled.status).toBe(400);
    // Approved scope is byte-for-byte unchanged after the attempt.
    expect(readScope(h.deps, pod.capsuleId).scopeKeys).toEqual(["ENG"]);
  });

  it("a legitimate re-sync reconstructs scope from persisted state and never queries a foreign space", async () => {
    const marker = buildRedactionMarker();
    const { custody, credential } = createInMemoryCustody("confluence", marker);
    const requestLog: string[] = [];
    const h = createConnectorServerHarness(
      fixtureCredentialDeps(custody, confluenceScopeFixture(requestLog)),
    );
    harness = h;
    const pod = await startConfluencePod(h.deps, credential.authRef);
    requestLog.length = 0;

    const resync = await handleStartAtlassianConnectorSync(
      routeCtx(
        { authRef: credential.authRef },
        { capsuleId: pod.capsuleId },
      ) as unknown as RouteContext,
      h.deps,
    );
    expect(resync.status).toBe(202);
    const { job } = resync.body as { job: { jobId: string } };
    expect((await awaitJobTerminal(job.jobId)).status).toBe("succeeded");
    // The re-sync only ever asked the provider for the approved ENG space.
    const spaceListings = requestLog.filter((url) => url.includes("/wiki/api/v2/spaces?"));
    expect(spaceListings.length).toBeGreaterThan(0);
    expect(spaceListings.every((url) => url.includes("keys=ENG"))).toBe(true);
    expect(requestLog.some((url) => url.includes("SECRET"))).toBe(false);
  });
});
