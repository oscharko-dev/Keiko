import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodeMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: nodeMocks.lookup }));
vi.mock("node:https", () => ({ request: nodeMocks.request }));

import { FEEDBACK_ISSUE_BODY_MAX_BYTES_V1 } from "./feedback-publication-projection.js";
import {
  GITHUB_MAX_SEARCH_RESULTS,
  GITHUB_MAX_RESPONSE_BYTES,
  GITHUB_SEARCH_PAGE_SIZE,
  FixedOriginGithubTransport,
  GithubTransportError,
  type GithubTransportDependencies,
  type GithubHttpResponse,
  githubSearchIssuesPath,
  isAllowedGithubAddress,
} from "./github-app-transport.js";

const marker = `<!-- keiko-feedback-reconciliation-v1:${"a".repeat(43)} -->`;

type ResponseHeaders = Record<string, string | string[] | undefined>;
interface PinnedRequestOptions {
  readonly method: string;
  readonly headers: Record<string, string | number>;
  readonly lookup: (
    hostname: string,
    options: unknown,
    callback: (error: Error | null, address: string, family: 4 | 6) => void,
  ) => void;
  readonly servername: string;
  readonly rejectUnauthorized: boolean;
}
type ResponseCallback = (response: MockResponse) => void;

class MockResponse extends EventEmitter {
  readonly destroy = vi.fn((error?: Error): this => {
    if (error !== undefined) this.emit("error", error);
    return this;
  });

  constructor(
    readonly statusCode: number,
    readonly headers: ResponseHeaders = {},
  ) {
    super();
  }
}

class MockRequest extends EventEmitter {
  body: unknown;
  readonly destroy = vi.fn((error?: Error): this => {
    this.emit("error", error);
    return this;
  });
  readonly end = vi.fn((body?: Uint8Array): void => {
    this.body = body;
    this.emit("finish");
  });
}

function publicDnsResult(address = "8.8.8.8"): { readonly address: string; readonly family: 4 }[] {
  return [{ address, family: 4 }];
}

function mockHttpsResponse(
  response: MockResponse,
  callback: ResponseCallback,
  emit: (response: MockResponse) => void,
): MockRequest {
  const call = new MockRequest();
  call.end.mockImplementation((body?: Uint8Array): void => {
    call.body = body;
    call.emit("finish");
    callback(response);
    emit(response);
  });
  return call;
}

beforeEach(() => {
  nodeMocks.lookup.mockReset();
  nodeMocks.request.mockReset();
  nodeMocks.lookup.mockResolvedValue(publicDnsResult());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fixed-origin GitHub transport address policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "224.0.0.1",
    "240.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ])("rejects private, reserved, loopback, link-local, or multicast address %s", (address) => {
    expect(isAllowedGithubAddress(address)).toBe(false);
  });

  it("accepts ordinary public addresses and rejects malformed input", () => {
    expect(isAllowedGithubAddress("8.8.8.8")).toBe(true);
    expect(isAllowedGithubAddress("2606:4700:4700::1111")).toBe(true);
    expect(isAllowedGithubAddress("not-an-address")).toBe(false);
  });

  it("fits one maximum-size quote, newline, and control-escaped body in the response cap", () => {
    const escapePattern = '"\n\u0001';
    const escapedBody = escapePattern
      .repeat(Math.ceil(FEEDBACK_ISSUE_BODY_MAX_BYTES_V1 / Buffer.byteLength(escapePattern)))
      .slice(0, FEEDBACK_ISSUE_BODY_MAX_BYTES_V1);
    const page = Array.from({ length: GITHUB_SEARCH_PAGE_SIZE }, (_, index) => ({
      number: index + 1,
      body: escapedBody,
      title: "t".repeat(256),
      labels: [{ name: "user-finding" }, { name: "source:keiko" }],
      node_id: `node-${String(index)}`,
      repository_url: "https://api.github.com/repos/oscharko-dev/keiko",
      html_url: `https://github.com/oscharko-dev/keiko/issues/${String(index + 1)}`,
    }));
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(GITHUB_MAX_RESPONSE_BYTES);
    expect(GITHUB_SEARCH_PAGE_SIZE).toBe(1);
    expect(GITHUB_MAX_SEARCH_RESULTS).toBe(2);
  });

  it("strictly encodes the exact repository-scoped marker search", () => {
    expect(githubSearchIssuesPath("oscharko-dev", "keiko", marker, 1)).toBe(
      `/search/issues?q=${encodeURIComponent(`repo:oscharko-dev/keiko "${marker}" in:body`)}&per_page=1&page=1`,
    );
    expect(() => githubSearchIssuesPath("owner query", "keiko", marker, 1)).toThrow();
    expect(() => githubSearchIssuesPath("oscharko-dev", "keiko", marker, 3)).toThrow();
  });

  it("does no DNS or request work for an already-aborted operation", async () => {
    let dnsCalls = 0;
    let requestCalls = 0;
    const transport = new FixedOriginGithubTransport(10_000, {
      resolveAddress: (): Promise<{ readonly address: string; readonly family: 4 }> => {
        dnsCalls += 1;
        return Promise.resolve({ address: "8.8.8.8", family: 4 });
      },
      executePinnedRequest: (): Promise<GithubHttpResponse> => {
        requestCalls += 1;
        return Promise.resolve({
          status: 200,
          contentType: "application/json",
          body: Buffer.from("{}"),
          requestCommitted: false,
        });
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport.execute({ kind: "inspect-app", jwt: "jwt" }, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(GithubTransportError);
    expect({ dnsCalls, requestCalls }).toEqual({ dnsCalls: 0, requestCalls: 0 });
  });

  it("uses one lookup and starts no request when aborted during DNS", async () => {
    let releaseDns: ((value: { readonly address: string; readonly family: 4 }) => void) | undefined;
    const pendingDns = new Promise<{ readonly address: string; readonly family: 4 }>((resolve) => {
      releaseDns = resolve;
    });
    let dnsCalls = 0;
    let requestCalls = 0;
    const transport = new FixedOriginGithubTransport(10_000, {
      resolveAddress: (): Promise<{ readonly address: string; readonly family: 4 }> => {
        dnsCalls += 1;
        return pendingDns;
      },
      executePinnedRequest: (): Promise<GithubHttpResponse> => {
        requestCalls += 1;
        return Promise.reject(new GithubTransportError(false));
      },
    });
    const controller = new AbortController();
    const result = transport.execute(
      { kind: "inspect-app", jwt: "jwt" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(GithubTransportError);
    releaseDns?.({ address: "8.8.8.8", family: 4 });
    expect({ dnsCalls, requestCalls }).toEqual({ dnsCalls: 1, requestCalls: 0 });
  });

  it("projects every GitHub operation onto the fixed GitHub API origin", async () => {
    const projections: unknown[] = [];
    const dependencies: GithubTransportDependencies = {
      resolveAddress: (): Promise<{ readonly address: string; readonly family: 4 }> =>
        Promise.resolve({ address: "8.8.8.8", family: 4 }),
      executePinnedRequest: (
        projection,
        _address,
        _timeout,
        _signal,
      ): Promise<GithubHttpResponse> => {
        projections.push(projection);
        return Promise.resolve({
          status: 200,
          contentType: "application/json",
          body: Buffer.from("{}"),
          requestCommitted: false,
        });
      },
    };
    const transport = new FixedOriginGithubTransport(10_000, dependencies);

    await Promise.all([
      transport.execute({ kind: "inspect-app", jwt: "app-jwt" }),
      transport.execute({ kind: "inspect-installation", installationId: "42", jwt: "app-jwt" }),
      transport.execute({
        kind: "inspect-repository-installation",
        repositoryId: "43",
        jwt: "app-jwt",
      }),
      transport.execute({
        kind: "mint-token",
        installationId: "42",
        repositoryId: "43",
        jwt: "app-jwt",
      }),
      transport.execute({
        kind: "find-marker",
        owner: "oscharko-dev",
        repository: "keiko",
        marker,
        page: 2,
        token: "installation-token",
      }),
      transport.execute({
        kind: "create-issue",
        repositoryId: "43",
        title: "Governed title",
        body: "Governed body",
        labels: ["user-finding"],
        token: "installation-token",
      }),
    ]);

    expect(projections).toEqual([
      { path: "/app", method: "GET", authorization: "Bearer app-jwt" },
      {
        path: "/app/installations/42",
        method: "GET",
        authorization: "Bearer app-jwt",
      },
      {
        path: "/repositories/43/installation",
        method: "GET",
        authorization: "Bearer app-jwt",
      },
      {
        path: "/app/installations/42/access_tokens",
        method: "POST",
        authorization: "Bearer app-jwt",
        body: Buffer.from('{"repository_ids":[43],"permissions":{"issues":"write"}}'),
      },
      {
        path: githubSearchIssuesPath("oscharko-dev", "keiko", marker, 2),
        method: "GET",
        authorization: "Bearer installation-token",
      },
      {
        path: "/repositories/43/issues",
        method: "POST",
        authorization: "Bearer installation-token",
        body: Buffer.from(
          JSON.stringify({
            title: "Governed title",
            body: "Governed body",
            labels: ["user-finding"],
          }),
        ),
      },
    ]);
  });

  it("fails closed before DNS for invalid operation identifiers and deadlines", async () => {
    let dnsCalls = 0;
    const transport = new FixedOriginGithubTransport(10_000, {
      resolveAddress: (): Promise<{ readonly address: string; readonly family: 4 }> => {
        dnsCalls += 1;
        return Promise.resolve({ address: "8.8.8.8", family: 4 });
      },
    });

    await expect(
      transport.execute({ kind: "inspect-installation", installationId: "042", jwt: "jwt" }),
    ).rejects.toEqual(expect.objectContaining({ requestCommitted: false }));
    await expect(
      transport.execute({ kind: "inspect-app", jwt: "jwt" }, { timeoutMs: 0 }),
    ).rejects.toEqual(expect.objectContaining({ requestCommitted: false }));
    await expect(
      transport.execute({
        kind: "find-marker",
        owner: "bad owner",
        repository: "keiko",
        marker,
        page: 3,
        token: "token",
      }),
    ).rejects.toBeInstanceOf(GithubTransportError);
    expect(dnsCalls).toBe(0);
  });

  it("does not start a pinned request after DNS consumes the full deadline", async () => {
    let clock = 0;
    let requests = 0;
    const transport = new FixedOriginGithubTransport(10, {
      monotonicNow: (): number => {
        clock += 10;
        return clock;
      },
      resolveAddress: (): Promise<{ readonly address: string; readonly family: 4 }> =>
        Promise.resolve({ address: "8.8.8.8", family: 4 }),
      executePinnedRequest: (): Promise<GithubHttpResponse> => {
        requests += 1;
        return Promise.reject(new GithubTransportError(false));
      },
    });

    await expect(transport.execute({ kind: "inspect-app", jwt: "jwt" })).rejects.toEqual(
      expect.objectContaining({ requestCommitted: false }),
    );
    expect(requests).toBe(0);
  });
});

describe("fixed-origin GitHub transport default network boundary", () => {
  it("pins a successful request to the approved DNS address and projects safe response headers", async () => {
    const response = new MockResponse(201, {
      "content-type": "application/json; charset=utf-8",
      "retry-after": "60",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": "not-a-number",
    });
    let lookupResult: { hostname: string; address: string; family: number } | undefined;
    const call = new MockRequest();
    nodeMocks.request.mockImplementation(
      (url: string, options: PinnedRequestOptions, callback: ResponseCallback): MockRequest => {
        expect(url).toBe("https://api.github.com/app");
        options.lookup("api.github.com", {}, (error, address, family) => {
          expect(error).toBeNull();
          lookupResult = { hostname: "api.github.com", address, family };
        });
        call.end.mockImplementation((): void => {
          call.emit("finish");
          callback(response);
          response.emit("data", Buffer.from('{"ok":true}'));
          response.emit("end");
        });
        return call;
      },
    );

    const result = await new FixedOriginGithubTransport().execute({
      kind: "inspect-app",
      jwt: "jwt",
    });

    expect(nodeMocks.lookup).toHaveBeenCalledWith("api.github.com", { all: true, verbatim: true });
    expect(nodeMocks.request).toHaveBeenCalledTimes(1);
    expect(nodeMocks.request.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer jwt",
        "user-agent": "keiko-feedback-intake",
        "x-github-api-version": "2022-11-28",
      },
      servername: "api.github.com",
      rejectUnauthorized: true,
    });
    expect(lookupResult).toEqual({ hostname: "api.github.com", address: "8.8.8.8", family: 4 });
    expect(result).toMatchObject({
      status: 201,
      contentType: "application/json; charset=utf-8",
      requestCommitted: true,
      retryAfter: "60",
      rateLimitRemaining: "4999",
    });
    expect(Buffer.from(result.body)).toEqual(Buffer.from('{"ok":true}'));
  });

  it("writes a bounded JSON issue body only with its matching content headers", async () => {
    const response = new MockResponse(200);
    nodeMocks.request.mockImplementation(
      (_url: string, _options: PinnedRequestOptions, callback: ResponseCallback): MockRequest => {
        return mockHttpsResponse(response, callback, (value) => {
          value.emit("end");
        });
      },
    );

    await new FixedOriginGithubTransport().execute({
      kind: "create-issue",
      repositoryId: "43",
      title: "Governed title",
      body: "Governed body",
      labels: ["user-finding"],
      token: "installation-token",
    });

    const options = nodeMocks.request.mock.calls[0]?.[1] as PinnedRequestOptions;
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer installation-token",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(
          '{"title":"Governed title","body":"Governed body","labels":["user-finding"]}',
        ),
      },
    });
    const call = nodeMocks.request.mock.results[0]?.value as MockRequest;
    expect(call.end).toHaveBeenCalledWith(
      Buffer.from('{"title":"Governed title","body":"Governed body","labels":["user-finding"]}'),
    );
  });

  it("fails closed when DNS rejects, returns no address, or returns an unapproved address", async () => {
    const transport = new FixedOriginGithubTransport();
    nodeMocks.lookup.mockRejectedValueOnce(new Error("resolver unavailable"));
    await expect(transport.execute({ kind: "inspect-app", jwt: "jwt" })).rejects.toEqual(
      expect.objectContaining({ requestCommitted: false }),
    );

    nodeMocks.lookup.mockResolvedValueOnce([]);
    await expect(transport.execute({ kind: "inspect-app", jwt: "jwt" })).rejects.toEqual(
      expect.objectContaining({ requestCommitted: false }),
    );

    nodeMocks.lookup.mockResolvedValueOnce(publicDnsResult("127.0.0.1"));
    await expect(transport.execute({ kind: "inspect-app", jwt: "jwt" })).rejects.toEqual(
      expect.objectContaining({ requestCommitted: false }),
    );
    expect(nodeMocks.request).not.toHaveBeenCalled();
  });

  it.each([
    ["a Location header", 200, { location: "https://github.com/redirect" }],
    ["a redirect status", 302, {}],
  ])("rejects a response with %s", async (_reason, statusCode, headers) => {
    const response = new MockResponse(statusCode, headers);
    nodeMocks.request.mockImplementation(
      (_url: string, _options: PinnedRequestOptions, callback: ResponseCallback): MockRequest => {
        return mockHttpsResponse(response, callback, (value) => {
          value.emit("end");
        });
      },
    );

    await expect(
      new FixedOriginGithubTransport().execute({ kind: "inspect-app", jwt: "jwt" }),
    ).rejects.toEqual(expect.objectContaining({ requestCommitted: true }));
  });

  it("fails closed when the response exceeds its byte limit or emits an error", async () => {
    const oversized = new MockResponse(200);
    nodeMocks.request.mockImplementation(
      (_url: string, _options: PinnedRequestOptions, callback: ResponseCallback): MockRequest => {
        return mockHttpsResponse(oversized, callback, (value) => {
          value.emit("data", Buffer.alloc(GITHUB_MAX_RESPONSE_BYTES + 1));
        });
      },
    );
    await expect(
      new FixedOriginGithubTransport().execute({ kind: "inspect-app", jwt: "jwt" }),
    ).rejects.toEqual(expect.objectContaining({ requestCommitted: true }));
    expect(oversized.destroy).toHaveBeenCalledOnce();

    const errored = new MockResponse(200);
    nodeMocks.request.mockImplementation(
      (_url: string, _options: PinnedRequestOptions, callback: ResponseCallback): MockRequest => {
        return mockHttpsResponse(errored, callback, (value) => {
          value.emit("error", new Error("socket read failure"));
        });
      },
    );
    await expect(
      new FixedOriginGithubTransport().execute({ kind: "inspect-app", jwt: "jwt" }),
    ).rejects.toEqual(expect.objectContaining({ requestCommitted: true }));
  });

  it("reports request errors and aborts without following through to a response", async () => {
    const requestFailure = new MockRequest();
    requestFailure.end.mockImplementation((): void => {
      requestFailure.emit("error", new Error("connection refused"));
    });
    nodeMocks.request.mockImplementation((): MockRequest => requestFailure);
    await expect(
      new FixedOriginGithubTransport().execute({ kind: "inspect-app", jwt: "jwt" }),
    ).rejects.toEqual(expect.objectContaining({ requestCommitted: false }));

    const abortable = new MockRequest();
    nodeMocks.request.mockImplementation((): MockRequest => abortable);
    const controller = new AbortController();
    const pending = new FixedOriginGithubTransport().execute(
      { kind: "inspect-app", jwt: "jwt" },
      { signal: controller.signal },
    );
    await vi.waitFor(() => {
      expect(nodeMocks.request).toHaveBeenCalledTimes(2);
    });
    controller.abort();
    await expect(pending).rejects.toEqual(expect.objectContaining({ requestCommitted: true }));
    expect(abortable.destroy).toHaveBeenCalledOnce();
  });

  it("enforces the pinned-request deadline with a deterministic clock", async () => {
    vi.useFakeTimers();
    const stalled = new MockRequest();
    nodeMocks.request.mockImplementation((): MockRequest => stalled);
    const pending = new FixedOriginGithubTransport().execute(
      { kind: "inspect-app", jwt: "jwt" },
      { timeoutMs: 25 },
    );

    const rejection = expect(pending).rejects.toEqual(
      expect.objectContaining({ requestCommitted: true }),
    );
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(stalled.destroy).toHaveBeenCalledOnce();
  });
});
