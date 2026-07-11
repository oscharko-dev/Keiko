// Issue #2241 — gatewayFetch-backed AtlassianHttpPort adapter tests. Hermetic: an injected
// fetchImpl fake replaces the platform fetch, so no request leaves the process. Asserts the
// ADR-0128 D2/D3 posture directly: the Authorization header is materialised only at the outbound
// hop, only the connector's configured host is contacted, redirects are surfaced (never
// followed), and every transport failure classifies into the closed, content-free result union.

import { describe, expect, it } from "vitest";
import {
  AtlassianCredentialCustodyError,
  atlassianAuthorizationHeaderValue,
  type AtlassianCredentialExecutionResolver,
  type AtlassianResolvedCredential,
} from "@oscharko-dev/keiko-connectors";
import { createGatewayAtlassianHttpBodyPort, createGatewayAtlassianHttpPort } from "./httpPort.js";

const SYNTHETIC_TOKEN = ["ATATT", "port", "test", "0123456789", "abcdefghij"].join("");
const SYNTHETIC_EMAIL = ["port-tester", "@", "example", ".", "com"].join("");
const AUTH_REF = `atlassian-cred:${"Cc3-_".repeat(4)}Xx`;

const CREDENTIAL: AtlassianResolvedCredential = {
  scheme: "basic-api-token",
  accountEmail: SYNTHETIC_EMAIL,
  apiToken: SYNTHETIC_TOKEN,
};

function resolver(): AtlassianCredentialExecutionResolver & { readonly resolvedRefs: string[] } {
  const resolvedRefs: string[] = [];
  return {
    resolvedRefs,
    resolveForExecution: (authRef: string): AtlassianResolvedCredential => {
      resolvedRefs.push(authRef);
      return CREDENTIAL;
    },
  };
}

interface RecordedFetch {
  readonly url: string;
  readonly authorization: string | null;
}

function fetchUrlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function fetchFake(
  status: number,
  headers: Record<string, string> = {},
): { readonly fetchImpl: typeof fetch; readonly calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: fetchUrlOf(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Promise.resolve(new Response(null, { status, headers }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function port(
  fetchImpl: typeof fetch,
  credentials: AtlassianCredentialExecutionResolver,
): ReturnType<typeof createGatewayAtlassianHttpPort> {
  return createGatewayAtlassianHttpPort({
    baseUrl: "https://acme.example",
    authRef: AUTH_REF,
    credentials,
    fetchImpl,
  });
}

describe("createGatewayAtlassianHttpPort", () => {
  it("materialises Basic auth from the execution resolver only at the outbound hop", async () => {
    const credentials = resolver();
    const { fetchImpl, calls } = fetchFake(200);
    const result = await port(
      fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/rest/api/3/myself",
      timeoutMs: 30_000,
    });
    expect(result).toEqual({ kind: "response", status: 200 });
    expect(credentials.resolvedRefs).toEqual([AUTH_REF]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://acme.example/rest/api/3/myself");
    expect(calls[0]?.authorization).toBe(atlassianAuthorizationHeaderValue(CREDENTIAL));
    // The result union physically cannot carry the credential.
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_TOKEN);
  });

  it("refuses a request URL off the connector's configured host before any fetch", async () => {
    const credentials = resolver();
    const { fetchImpl, calls } = fetchFake(200);
    const boundPort = port(fetchImpl, credentials);
    await expect(
      boundPort({ method: "GET", url: "https://evil.example/rest/api/3/myself", timeoutMs: 100 }),
    ).rejects.toThrow(AtlassianCredentialCustodyError);
    await expect(
      boundPort({ method: "GET", url: "http://acme.example/rest/api/3/myself", timeoutMs: 100 }),
    ).rejects.toThrow(AtlassianCredentialCustodyError);
    await expect(
      boundPort({ method: "GET", url: "https://u:p@acme.example/x", timeoutMs: 100 }),
    ).rejects.toThrow(AtlassianCredentialCustodyError);
    expect(calls).toHaveLength(0);
    expect(credentials.resolvedRefs).toHaveLength(0);
  });

  it("rejects an unsafe base URL at construction time", () => {
    expect(() =>
      createGatewayAtlassianHttpPort({
        baseUrl: "http://acme.example",
        authRef: AUTH_REF,
        credentials: resolver(),
      }),
    ).toThrow(AtlassianCredentialCustodyError);
  });

  it("surfaces a redirect as its status without following it (fail closed, D3)", async () => {
    const credentials = resolver();
    const { fetchImpl, calls } = fetchFake(302, { location: "https://elsewhere.example/login" });
    const result = await port(
      fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/wiki/rest/api/user/current",
      timeoutMs: 30_000,
    });
    expect(result).toEqual({ kind: "response", status: 302 });
    expect(calls).toHaveLength(1);
  });

  it("classifies an aborted request as timeout", async () => {
    const credentials = resolver();
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation timed out.", "TimeoutError"));
        });
      })) as typeof fetch;
    const result = await port(
      fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/rest/api/3/myself",
      timeoutMs: 5,
    });
    expect(result).toEqual({ kind: "timeout" });
  });

  it("classifies a network refusal as network-error without leaking the cause", async () => {
    const credentials = resolver();
    const fetchImpl = ((): Promise<Response> =>
      Promise.reject(
        new TypeError(`fetch failed: token ${SYNTHETIC_TOKEN} must not surface`),
      )) as typeof fetch;
    const result = await port(
      fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/rest/api/3/myself",
      timeoutMs: 100,
    });
    expect(result).toEqual({ kind: "network-error" });
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_TOKEN);
  });

  it("clamps a hostile timeout budget instead of honoring it", async () => {
    const credentials = resolver();
    const { fetchImpl } = fetchFake(200);
    const result = await port(
      fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/rest/api/3/myself",
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    expect(result).toEqual({ kind: "response", status: 200 });
  });
});

// ─── Bounded-body ingestion channel (Issue #2242, ADR-0128 D3/D5) ─────────────
function bodyFetchFake(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): { readonly fetchImpl: typeof fetch; readonly calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: fetchUrlOf(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Promise.resolve(new Response(body, { status, headers }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function bodyPort(
  fetchImpl: typeof fetch,
  credentials: AtlassianCredentialExecutionResolver,
): ReturnType<typeof createGatewayAtlassianHttpBodyPort> {
  return createGatewayAtlassianHttpBodyPort({
    baseUrl: "https://acme.example",
    authRef: AUTH_REF,
    credentials,
    fetchImpl,
  });
}

describe("createGatewayAtlassianHttpBodyPort", () => {
  it("reads the body up to the cap, decodes UTF-8, and reports exact byte counts", async () => {
    const credentials = resolver();
    const { fetchImpl, calls } = bodyFetchFake(200, '{"results":[]}');
    const result = await bodyPort(
      fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/wiki/api/v2/spaces",
      timeoutMs: 60_000,
      maxBodyBytes: 1_000,
    });
    expect(result).toEqual({
      kind: "response",
      status: 200,
      bodyText: '{"results":[]}',
      bodyBytes: 14,
      truncated: false,
    });
    expect(calls[0]?.authorization).toBe(atlassianAuthorizationHeaderValue(CREDENTIAL));
  });

  it("stops reading at the cap (truncated, never buffered past it) — boundary exact", async () => {
    const credentials = resolver();
    const exactly = await bodyPort(
      bodyFetchFake(200, "abcdefgh").fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/wiki/api/v2/pages/1",
      timeoutMs: 60_000,
      maxBodyBytes: 8,
    });
    // A body exactly at the cap reads fully but reports truncated (the reader cannot know the
    // stream ended without asking for more) — the caller treats it as capped, fail closed.
    expect(exactly).toMatchObject({ bodyBytes: 8, bodyText: "abcdefgh" });
    const over = await bodyPort(
      bodyFetchFake(200, "abcdefgh-overflow").fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/wiki/api/v2/pages/1",
      timeoutMs: 60_000,
      maxBodyBytes: 8,
    });
    expect(over).toMatchObject({ truncated: true, bodyBytes: 8, bodyText: "abcdefgh" });
  });

  it("parses Retry-After delay-seconds and HTTP-dates into bounded milliseconds", async () => {
    const credentials = resolver();
    const seconds = await bodyPort(
      bodyFetchFake(429, "", { "retry-after": "3" }).fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/wiki/api/v2/spaces",
      timeoutMs: 60_000,
      maxBodyBytes: 100,
    });
    expect(seconds).toMatchObject({ status: 429, retryAfterMs: 3_000 });
    const invalid = await bodyPort(
      bodyFetchFake(429, "", { "retry-after": "not-a-delay" }).fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/wiki/api/v2/spaces",
      timeoutMs: 60_000,
      maxBodyBytes: 100,
    });
    expect("retryAfterMs" in invalid).toBe(false);
    const past = await bodyPort(
      bodyFetchFake(429, "", { "retry-after": "Tue, 01 Jan 1980 00:00:00 GMT" }).fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/wiki/api/v2/spaces",
      timeoutMs: 60_000,
      maxBodyBytes: 100,
    });
    // An HTTP-date in the past clamps to zero rather than going negative.
    expect(past).toMatchObject({ retryAfterMs: 0 });
  });

  it("re-checks the single-host allowlist before any fetch, exactly like the body-less channel", async () => {
    const credentials = resolver();
    const { fetchImpl, calls } = bodyFetchFake(200, "{}");
    await expect(
      bodyPort(
        fetchImpl,
        credentials,
      )({
        method: "GET",
        url: "https://evil.example/wiki/api/v2/spaces",
        timeoutMs: 100,
        maxBodyBytes: 100,
      }),
    ).rejects.toThrow(AtlassianCredentialCustodyError);
    expect(calls).toHaveLength(0);
    expect(credentials.resolvedRefs).toHaveLength(0);
  });

  it("classifies thrown transport failures without leaking the cause text", async () => {
    const credentials = resolver();
    const fetchImpl = ((): Promise<Response> =>
      Promise.reject(new TypeError(`fetch failed: token ${SYNTHETIC_TOKEN}`))) as typeof fetch;
    const result = await bodyPort(
      fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/wiki/api/v2/spaces",
      timeoutMs: 100,
      maxBodyBytes: 100,
    });
    expect(result).toEqual({ kind: "network-error" });
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_TOKEN);
  });

  it("honors an external abort signal as a timeout classification", async () => {
    const credentials = resolver();
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      void input;
      return Promise.reject(
        Object.assign(new Error("aborted"), {
          name: init?.signal?.aborted === true ? "AbortError" : "TypeError",
        }),
      );
    }) as typeof fetch;
    const result = await bodyPort(
      fetchImpl,
      credentials,
    )({
      method: "GET",
      url: "https://acme.example/wiki/api/v2/spaces",
      timeoutMs: 60_000,
      maxBodyBytes: 100,
      signal: controller.signal,
    });
    expect(result).toEqual({ kind: "timeout" });
  });
});

// ─── Issue #2244: write channel (POST/PUT + bounded JSON request bodies) ────────

interface RecordedWriteFetch {
  readonly url: string;
  readonly method: string | undefined;
  readonly contentType: string | null;
  readonly body: string | undefined;
}

function writeFetchFake(
  status: number,
  body: string,
): { readonly fetchImpl: typeof fetch; readonly calls: RecordedWriteFetch[] } {
  const calls: RecordedWriteFetch[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: fetchUrlOf(input),
      method: init?.method,
      contentType: new Headers(init?.headers).get("content-type"),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("createGatewayAtlassianHttpBodyPort — write channel (Issue #2244)", () => {
  it("forwards a POST JSON body with the content-type header and reads the bounded response", async () => {
    const credentials = resolver();
    const { fetchImpl, calls } = writeFetchFake(201, '{"id":"10001","key":"PROJ-9"}');
    const result = await bodyPort(
      fetchImpl,
      credentials,
    )({
      method: "POST",
      url: "https://acme.example/rest/api/3/issue",
      timeoutMs: 30_000,
      maxBodyBytes: 1_000,
      bodyJson: '{"fields":{"summary":"S"}}',
    });
    expect(result).toMatchObject({ kind: "response", status: 201 });
    expect(calls[0]).toEqual({
      url: "https://acme.example/rest/api/3/issue",
      method: "POST",
      contentType: "application/json",
      body: '{"fields":{"summary":"S"}}',
    });
  });

  it("issues PUT without a content-type when no body is supplied", async () => {
    const credentials = resolver();
    const { fetchImpl, calls } = writeFetchFake(204, "");
    await bodyPort(
      fetchImpl,
      credentials,
    )({
      method: "PUT",
      url: "https://acme.example/rest/api/3/issue/PROJ-9",
      timeoutMs: 30_000,
      maxBodyBytes: 1_000,
    });
    expect(calls[0]).toMatchObject({ method: "PUT", contentType: null, body: undefined });
  });

  it("fails closed on a GET carrying a request body", async () => {
    const credentials = resolver();
    const { fetchImpl, calls } = writeFetchFake(200, "{}");
    await expect(
      bodyPort(
        fetchImpl,
        credentials,
      )({
        method: "GET",
        url: "https://acme.example/rest/api/3/issue",
        timeoutMs: 30_000,
        maxBodyBytes: 1_000,
        bodyJson: "{}",
      }),
    ).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(calls).toHaveLength(0);
  });

  it("fails closed on an oversized request body before any outbound call", async () => {
    const credentials = resolver();
    const { fetchImpl, calls } = writeFetchFake(200, "{}");
    await expect(
      bodyPort(
        fetchImpl,
        credentials,
      )({
        method: "POST",
        url: "https://acme.example/rest/api/3/issue",
        timeoutMs: 30_000,
        maxBodyBytes: 1_000,
        bodyJson: "x".repeat(1_000_001),
      }),
    ).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(calls).toHaveLength(0);
  });

  it("keeps the single-host allowlist on writes: an off-host POST never leaves the process", async () => {
    const credentials = resolver();
    const { fetchImpl, calls } = writeFetchFake(200, "{}");
    await expect(
      bodyPort(
        fetchImpl,
        credentials,
      )({
        method: "POST",
        url: "https://evil.example/rest/api/3/issue",
        timeoutMs: 30_000,
        maxBodyBytes: 1_000,
        bodyJson: "{}",
      }),
    ).rejects.toBeInstanceOf(AtlassianCredentialCustodyError);
    expect(calls).toHaveLength(0);
  });
});
