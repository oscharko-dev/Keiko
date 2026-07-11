// Issue #2246 Scope 2 — consolidated egress fail-closed proofs.
//
// Every egress-boundary violation is refused BEFORE any network write, asserted through the
// injected fetcher's call log against the REAL gateway transport adapter (keiko-server's
// `createGatewayAtlassianHttpPort` / `…HttpBodyPort`, ADR-0128 D3), and every refusal carries a
// typed, content-free reason. Covered: non-allowlisted hosts, protocol downgrades (https→http),
// URL-embedded credentials, cross-host redirects (surfaced, never followed), pagination cursors
// pointing off-host (refused by the adapter before the transport is asked for the foreign URL),
// and proxy/CA configuration honored via an injected egress resolver consulted per request.
//
// This consolidates the port-level refusals `httpPort.test.ts` asserts individually and adds the
// adapter-cursor and proxy/CA cells the per-child tests do not cover in one place.

import { describe, expect, it } from "vitest";
import {
  AtlassianCredentialCustodyError,
  atlassianAuthorizationHeaderValue,
  createConfluenceSyncSource,
  runAtlassianSyncFetch,
  type AtlassianCredentialExecutionResolver,
  type AtlassianResolvedCredential,
} from "@oscharko-dev/keiko-connectors";
import { DEFAULT_ATLASSIAN_SYNC_BOUNDS } from "@oscharko-dev/keiko-contracts";
import type { OutboundHttpEgressConfig } from "@oscharko-dev/keiko-model-gateway/internal/http";
import {
  createGatewayAtlassianHttpBodyPort,
  createGatewayAtlassianHttpPort,
} from "../../packages/keiko-server/src/atlassian/httpPort.js";
import { buildRedactionMarker, noopSleep } from "./harness.js";

const BASE_URL = "https://tenant.example";
const AUTH_REF = `atlassian-cred:${"Cc3-_".repeat(4)}Xx`;
const MARKER = buildRedactionMarker();
const CREDENTIAL: AtlassianResolvedCredential = {
  scheme: "basic-api-token",
  accountEmail: MARKER.email,
  apiToken: MARKER.token,
};

interface Recorder {
  readonly resolver: AtlassianCredentialExecutionResolver;
  readonly resolvedRefs: string[];
}

function resolver(): Recorder {
  const resolvedRefs: string[] = [];
  return {
    resolvedRefs,
    resolver: {
      resolveForExecution: (authRef: string): AtlassianResolvedCredential => {
        resolvedRefs.push(authRef);
        return CREDENTIAL;
      },
    },
  };
}

interface OutboundCall {
  readonly url: string;
  readonly authorization: string | null;
}

function fetchUrlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

// A fetch fake that records every outbound call and answers by URL. Anything unmatched is a 404 so
// an unexpected foreign request is visible in the log rather than silently succeeding.
function routingFetch(
  responder: (url: URL) => { status: number; body: string; headers?: Record<string, string> },
): { fetchImpl: typeof fetch; calls: OutboundCall[] } {
  const calls: OutboundCall[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = fetchUrlOf(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    const answer = responder(new URL(url));
    return Promise.resolve(
      new Response(answer.body, {
        status: answer.status,
        ...(answer.headers === undefined ? {} : { headers: answer.headers }),
      }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ─── Egress-violation refusals (refused before any network write) ──────────────
const EGRESS_VIOLATIONS: Readonly<Record<string, string>> = {
  "non-allowlisted host": "https://evil.example/rest/api/3/myself",
  "protocol downgrade (https→http)": "http://tenant.example/rest/api/3/myself",
  "URL-embedded credentials": "https://user:secret@tenant.example/rest/api/3/myself",
};

describe("egress fail-closed — refused before any network write (Scope 2)", () => {
  it.each(Object.entries(EGRESS_VIOLATIONS))(
    "the body-less port refuses a %s with a typed content-free reason and zero fetches",
    async (_label, url) => {
      const rec = resolver();
      const { fetchImpl, calls } = routingFetch(() => ({ status: 200, body: "" }));
      const port = createGatewayAtlassianHttpPort({
        baseUrl: BASE_URL,
        authRef: AUTH_REF,
        credentials: rec.resolver,
        fetchImpl,
      });
      let thrown: unknown;
      await port({ method: "GET", url, timeoutMs: 100 }).catch((error: unknown) => {
        thrown = error;
      });
      expect(thrown).toBeInstanceOf(AtlassianCredentialCustodyError);
      expect((thrown as Error).message).not.toContain(MARKER.token);
      expect((thrown as Error).message).not.toContain(MARKER.email);
      // No request left the process, and the credential was never even resolved.
      expect(calls).toHaveLength(0);
      expect(rec.resolvedRefs).toHaveLength(0);
    },
  );

  it.each(Object.entries(EGRESS_VIOLATIONS))(
    "the bounded-body port refuses a %s with zero fetches",
    async (_label, url) => {
      const rec = resolver();
      const { fetchImpl, calls } = routingFetch(() => ({ status: 200, body: "{}" }));
      const port = createGatewayAtlassianHttpBodyPort({
        baseUrl: BASE_URL,
        authRef: AUTH_REF,
        credentials: rec.resolver,
        fetchImpl,
      });
      await expect(
        port({ method: "GET", url, timeoutMs: 100, maxBodyBytes: 100 }),
      ).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
      expect(calls).toHaveLength(0);
      expect(rec.resolvedRefs).toHaveLength(0);
    },
  );

  it("surfaces a cross-host redirect as its status without following it", async () => {
    const rec = resolver();
    const { fetchImpl, calls } = routingFetch(() => ({
      status: 302,
      body: "",
      headers: { location: "https://elsewhere.example/login" },
    }));
    const port = createGatewayAtlassianHttpPort({
      baseUrl: BASE_URL,
      authRef: AUTH_REF,
      credentials: rec.resolver,
      fetchImpl,
    });
    const result = await port({
      method: "GET",
      url: "https://tenant.example/rest/api/3/myself",
      timeoutMs: 30_000,
    });
    expect(result).toEqual({ kind: "response", status: 302 });
    // Exactly one request (the original); the redirect target was never contacted.
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.includes("elsewhere.example"))).toBe(false);
  });
});

// ─── Proxy/CA configuration is honored (injected egress resolver) ──────────────
describe("egress fail-closed — proxy/CA configuration honored (Scope 2)", () => {
  it("consults the injected egress resolver per outbound request and still targets the allowlisted host", async () => {
    const rec = resolver();
    const { fetchImpl, calls } = routingFetch(() => ({ status: 200, body: "" }));
    let egressCalls = 0;
    const egressConfig: OutboundHttpEgressConfig = {
      httpsProxy: "http://proxy.internal:8080",
      noProxy: ["other.example"],
    };
    const port = createGatewayAtlassianHttpPort({
      baseUrl: BASE_URL,
      authRef: AUTH_REF,
      credentials: rec.resolver,
      egress: () => {
        egressCalls += 1;
        return egressConfig;
      },
      fetchImpl,
    });
    await port({
      method: "GET",
      url: "https://tenant.example/rest/api/3/myself",
      timeoutMs: 30_000,
    });
    await port({
      method: "GET",
      url: "https://tenant.example/rest/api/3/myself",
      timeoutMs: 30_000,
    });
    // The egress (proxy/CA) config is resolved fresh per request, so a runtime update is honored.
    expect(egressCalls).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url.startsWith("https://tenant.example/"))).toBe(true);
  });
});

// ─── Pagination cursor pointing off-host (refused before the foreign request) ──
describe("egress fail-closed — off-host pagination cursor (Scope 2)", () => {
  it("refuses an off-host _links.next before the transport is asked for the foreign URL", async () => {
    const rec = resolver();
    const { fetchImpl, calls } = routingFetch((url) => {
      if (url.pathname.endsWith("/wiki/api/v2/spaces")) {
        return {
          status: 200,
          body: JSON.stringify({ results: [{ id: "100", key: "ENG", name: "ENG" }], _links: {} }),
        };
      }
      if (url.pathname.endsWith("/wiki/api/v2/spaces/100/pages")) {
        return {
          status: 200,
          body: JSON.stringify({
            results: [{ id: "1", title: "Page", status: "current" }],
            _links: { next: "https://evil.example/wiki/api/v2/spaces/100/pages?cursor=10" },
          }),
        };
      }
      return { status: 404, body: JSON.stringify({ status: 404 }) };
    });
    const http = createGatewayAtlassianHttpBodyPort({
      baseUrl: BASE_URL,
      authRef: AUTH_REF,
      credentials: rec.resolver,
      fetchImpl,
    });
    const outcome = await runAtlassianSyncFetch({
      source: createConfluenceSyncSource({
        baseUrl: BASE_URL,
        connectorId: "cred-egress",
        spaceKeys: ["ENG"],
      }),
      http,
      bounds: DEFAULT_ATLASSIAN_SYNC_BOUNDS,
      sleep: noopSleep,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toBe("scope-exceeded");
    // The transport was exercised for the allowlisted host only; the foreign cursor never left.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((call) => call.url.includes("evil.example"))).toBe(false);
    expect(calls.every((call) => call.url.startsWith("https://tenant.example/"))).toBe(true);
    // The real adapter materialised the credential at the allowlisted hop (non-vacuous transport).
    expect(calls[0]?.authorization).toBe(atlassianAuthorizationHeaderValue(CREDENTIAL));
  });
});
