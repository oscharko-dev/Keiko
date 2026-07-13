import { describe, expect, it } from "vitest";
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
