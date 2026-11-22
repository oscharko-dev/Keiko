import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  createRepositoryCredentialRelay,
  REPOSITORY_RELAY_BINDING_MAX_BYTES,
  REPOSITORY_RELAY_BINDING_MAX_REQUESTS,
  REPOSITORY_RELAY_CHALLENGE_REALM,
  REPOSITORY_RELAY_MAX_REDIRECTS,
  REPOSITORY_RELAY_PATH_PREFIX,
  repositoryRelayBaseUrl,
  serveRepositoryRelayRequest,
  type RepositoryCredentialRelay,
  type RepositoryRelayBinding,
  type RepositoryRelayLimits,
  type RepositoryRelayTarget,
  type RepositoryRelayUpstream,
} from "./repositoryCredentialRelay.js";
import { pipeBinaryBody, credentialByteForms, RelayRefusal } from "./repositoryRelayResponse.js";

const RUN_ID = "run-repository";
const USER = "builder";
const PASSWORD = "repo-password-canary";
const TOKEN = "npm-token-canary-0123456789";
const basic = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

function sink(): { readonly sink: ServerLogSink; readonly records: ServerLogEvent[] } {
  const records: ServerLogEvent[] = [];
  return { sink: { write: (event) => void records.push(event) }, records };
}

function lines(records: readonly ServerLogEvent[]): readonly Readonly<Record<string, unknown>>[] {
  return records.map((record) =>
    expectActivityLogProof(
      "coding-runtime.repository-relay.emitted-line",
      formatActivityLogProofLine(record),
    ),
  );
}

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
}

interface Upstream {
  readonly base: string;
  readonly seen: Seen[];
}

type Answer = (request: IncomingMessage, response: ServerResponse) => void;

// A repository that serves only what the right Basic or Bearer credential asks for.
async function startUpstream(
  answer: Answer,
  accepted: readonly string[] = [basic(USER, PASSWORD), `Bearer ${TOKEN}`],
): Promise<Upstream> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    if (!accepted.includes(request.headers.authorization ?? "")) {
      response.writeHead(401, { "www-authenticate": "Basic realm=upstream" }).end("denied");
      return;
    }
    answer(request, response);
  });
  return { base: await listen(server), seen };
}

const fetchUpstream: RepositoryRelayUpstream = (url, request) =>
  fetch(url, {
    method: request.method,
    headers: request.headers,
    redirect: "manual",
    signal: request.signal,
  });

async function startRelay(
  relay: RepositoryCredentialRelay,
  activityLog: ServerLogSink,
  upstream: RepositoryRelayUpstream = fetchUpstream,
  limits?: RepositoryRelayLimits,
): Promise<string> {
  const server = createServer((request, response) => {
    const rest = (request.url ?? "").slice(REPOSITORY_RELAY_PATH_PREFIX.length);
    void serveRepositoryRelayRequest(
      request,
      response,
      { relayId: rest.split("/", 1)[0] ?? "" },
      { relay, upstream, activityLog, correlationId: "request-correlation", limits },
    );
  });
  return listen(server);
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
  readonly aborted: boolean;
}

// The path is sent exactly as given: a WHATWG URL would normalise the hostile forms away.
function send(
  base: string,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const { port } = new URL(base);
  return new Promise<Reply>((resolve) => {
    const chunks: Buffer[] = [];
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (response) => {
        const done = (aborted: boolean): void => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            aborted,
          });
        };
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          done(false);
        });
        response.on("error", () => {
          done(true);
        });
        response.on("aborted", () => {
          done(true);
        });
      },
    );
    request.on("error", () => {
      resolve({ status: 0, headers: {}, body: Buffer.concat(chunks), aborted: true });
    });
    request.end();
  });
}

interface Fixture {
  readonly relay: RepositoryCredentialRelay;
  readonly records: ServerLogEvent[];
  readonly origin: string;
  readonly relayId: string;
  readonly capability: string;
  readonly path: (rest: string) => string;
}

async function fixture(input: {
  readonly upstream?: Upstream;
  readonly target?: Partial<RepositoryRelayTarget>;
  readonly transport?: RepositoryRelayUpstream | undefined;
  readonly limits?: RepositoryRelayLimits | undefined;
}): Promise<Fixture> {
  const { sink: activityLog, records } = sink();
  const relay = createRepositoryCredentialRelay({ activityLog: () => activityLog });
  const binding = relay.bind({
    runId: RUN_ID,
    ecosystem: "maven",
    upstreamBaseUrl: `${input.upstream?.base ?? "https://repo.example.test"}/maven/`,
    credential: { kind: "basic", username: USER, password: PASSWORD },
    secrets: [],
    ...input.target,
  });
  if (binding === undefined) throw new Error("fixture-bind-failed");
  const origin = await startRelay(relay, activityLog, input.transport, input.limits);
  records.length = 0;
  return {
    relay,
    records,
    origin,
    ...binding,
    path: (rest) => `${REPOSITORY_RELAY_PATH_PREFIX}${binding.relayId}/${rest}`,
  };
}

const JAR = "org/example/lib/1.0/lib-1.0.jar";
const POM = "org/example/lib/1.0/lib-1.0.pom";

function mavenAuth(capability: string): Record<string, string> {
  return { authorization: basic("any-user", capability) };
}

describe("repository credential relay bindings (#4522)", () => {
  it("exposes the base URL a build tool is pointed at", () => {
    expect(repositoryRelayBaseUrl("http://127.0.0.1:1983/", "abc")).toBe(
      "http://127.0.0.1:1983/api/coding-sidecar/repository/abc/",
    );
  });

  it("binds one capability per run and repository and records the binding body-free", () => {
    const { sink: activityLog, records } = sink();
    const relay = createRepositoryCredentialRelay({ activityLog: () => activityLog });
    const first = relay.bind({
      runId: RUN_ID,
      ecosystem: "maven",
      upstreamBaseUrl: "https://repo.example.test/maven",
      credential: { kind: "basic", username: USER, password: PASSWORD },
      secrets: [],
    });
    const second = relay.bind({
      runId: RUN_ID,
      ecosystem: "npm",
      upstreamBaseUrl: "https://npm.example.test/",
      credential: { kind: "bearer", token: TOKEN },
      secrets: [],
    });
    if (first === undefined || second === undefined) throw new Error("fixture-bind-failed");
    expect(relay.authenticate(first.relayId, first.capability)?.target.baseUrl).toBe(
      "https://repo.example.test/maven/",
    );
    expect(relay.authenticate(first.relayId, second.capability)).toBeUndefined();
    expect(relay.authenticate(second.relayId, second.capability)?.target.ecosystem).toBe("npm");
    const emitted = lines(records);
    expect(emitted).toMatchObject([
      {
        op: "coding-runtime.repository-relay",
        action: "bind",
        outcome: "bound",
        ecosystem: "maven",
        credentialKind: "basic",
        correlationId: RUN_ID,
      },
      { action: "bind", outcome: "bound", ecosystem: "npm", credentialKind: "bearer" },
    ]);
    const text = JSON.stringify(emitted);
    for (const forbidden of ["repo.example.test", PASSWORD, TOKEN, first.capability, "maven/"])
      expect(text).not.toContain(forbidden);
  });

  it("refuses a target that is Keiko's own server, carries user info or is unsupported", () => {
    const { sink: activityLog, records } = sink();
    const relay = createRepositoryCredentialRelay({ activityLog: () => activityLog });
    const attempt = (
      upstreamBaseUrl: string,
      extra: Partial<RepositoryRelayTarget> = {},
    ): RepositoryRelayBinding | undefined =>
      relay.bind({
        runId: RUN_ID,
        ecosystem: "maven",
        upstreamBaseUrl,
        secrets: [],
        ownOrigin: "http://127.0.0.1:1983",
        ...extra,
      });
    expect(attempt("http://localhost:1983/maven/")).toBeUndefined();
    expect(attempt("http://127.0.0.1:1983/")).toBeUndefined();
    expect(attempt("https://user:pw@repo.example.test/")).toBeUndefined();
    expect(attempt("file:///tmp/repo")).toBeUndefined();
    expect(attempt("http://127.0.0.1:4873/")).toBeDefined();
    expect(lines(records).map((line) => line.reason ?? "bound")).toEqual([
      "url-own-origin",
      "url-own-origin",
      "url-userinfo",
      "url-unsupported",
      "bound",
    ]);
  });

  it("refuses a credential too short or unsafe to be recognised in a response", () => {
    const { sink: activityLog, records } = sink();
    const relay = createRepositoryCredentialRelay({ activityLog: () => activityLog });
    const attempt = (
      credential: RepositoryRelayTarget["credential"],
      secrets: string[] = [],
    ): RepositoryRelayBinding | undefined =>
      relay.bind({
        runId: RUN_ID,
        ecosystem: "npm",
        upstreamBaseUrl: "https://npm.example.test/",
        credential,
        secrets,
      });
    expect(attempt({ kind: "bearer", token: "short" })).toBeUndefined();
    expect(attempt({ kind: "bearer", token: "has space in it" })).toBeUndefined();
    expect(attempt({ kind: "basic", username: "a:b", password: PASSWORD })).toBeUndefined();
    expect(attempt({ kind: "basic", username: USER, password: "short" })).toBeUndefined();
    expect(attempt(undefined, ["tiny"])).toBeUndefined();
    expect(attempt(undefined)).toBeDefined();
    expect(lines(records).map((line) => line.reason ?? "bound")).toEqual([
      "secret-too-short",
      "secret-invalid",
      "secret-invalid",
      "secret-too-short",
      "secret-too-short",
      "bound",
    ]);
  });

  it("refuses a binding for an aborted run and beyond its maximum", () => {
    const { sink: activityLog, records } = sink();
    const relay = createRepositoryCredentialRelay({ activityLog: () => activityLog });
    const controller = new AbortController();
    controller.abort();
    const target = {
      runId: RUN_ID,
      ecosystem: "maven",
      upstreamBaseUrl: "https://repo.example.test/",
      secrets: [],
    } as const;
    expect(relay.bind({ ...target, signal: controller.signal })).toBeUndefined();
    for (let index = 0; index < 256; index += 1) expect(relay.bind(target)).toBeDefined();
    expect(relay.bind(target)).toBeUndefined();
    const reasons = lines(records)
      .map((line) => line.reason)
      .filter((reason) => reason !== undefined);
    expect(reasons).toEqual(["run-aborted", "bindings-exhausted"]);
  });
});

describe("a relayed Maven read (#4522)", () => {
  it("answers an unauthenticated request with a Basic challenge and never reaches the repository", async () => {
    const upstream = await startUpstream((_request, response) => response.end("never"));
    const relay = await fixture({ upstream });
    const reply = await send(relay.origin, relay.path(JAR));
    expect(reply.status).toBe(401);
    expect(reply.headers["www-authenticate"]).toBe(
      `Basic realm="${REPOSITORY_RELAY_CHALLENGE_REALM}", charset="UTF-8"`,
    );
    expect(upstream.seen).toEqual([]);
    // The challenge is the protocol, not a refusal: nothing is written for it.
    expect(relay.records).toEqual([]);
  });

  it("injects the repository credential for a run that presents its capability as the Basic password", async () => {
    const upstream = await startUpstream((_request, response) =>
      response
        .writeHead(200, {
          "content-type": "application/java-archive",
          "content-length": "5",
          etag: '"e1"',
        })
        .end("jar!!"),
    );
    const relay = await fixture({ upstream });
    const reply = await send(relay.origin, relay.path(JAR), {
      headers: mavenAuth(relay.capability),
    });
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toBe("jar!!");
    expect(reply.headers).toMatchObject({
      "content-type": "application/java-archive",
      "content-length": "5",
      etag: '"e1"',
      "cache-control": "no-store",
    });
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]?.url).toBe(`/maven/${JAR}`);
    expect(upstream.seen[0]?.headers.authorization).toBe(basic(USER, PASSWORD));
    expect(JSON.stringify(upstream.seen[0]?.headers)).not.toContain(relay.capability);
    // A relayed request is counted in the settled summary, never written as a line of its own.
    expect(relay.records).toEqual([]);
  });

  it("accepts the capability as a Bearer token too and serves HEAD", async () => {
    const upstream = await startUpstream((request, response) =>
      response
        .writeHead(200, { "content-length": "3" })
        .end(request.method === "HEAD" ? undefined : "pom"),
    );
    const relay = await fixture({ upstream });
    const reply = await send(relay.origin, relay.path(JAR), {
      method: "HEAD",
      headers: { authorization: `Bearer ${relay.capability}` },
    });
    expect(reply.status).toBe(200);
    expect(reply.headers["content-length"]).toBe("3");
    expect(reply.body).toHaveLength(0);
    expect(upstream.seen[0]?.method).toBe("HEAD");
  });

  it("forwards only the conditional and accept headers of the run", async () => {
    const upstream = await startUpstream((_request, response) => response.writeHead(304).end());
    const relay = await fixture({ upstream });
    const reply = await send(relay.origin, relay.path(POM), {
      headers: {
        ...mavenAuth(relay.capability),
        "if-none-match": '"e1"',
        cookie: "session=secret",
        "x-evil": "1",
      },
    });
    expect(reply.status).toBe(304);
    expect(upstream.seen[0]?.headers["if-none-match"]).toBe('"e1"');
    expect(upstream.seen[0]?.headers.cookie).toBeUndefined();
    expect(upstream.seen[0]?.headers["x-evil"]).toBeUndefined();
    expect(upstream.seen[0]?.headers["accept-encoding"]).toBe("identity");
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])(
    "refuses %s without reaching the repository",
    async (method) => {
      const upstream = await startUpstream((_request, response) => response.end("never"));
      const relay = await fixture({ upstream });
      const reply = await send(relay.origin, relay.path(JAR), {
        method,
        headers: mavenAuth(relay.capability),
      });
      expect(reply.status).toBe(405);
      expect(reply.headers.allow).toBe("GET, HEAD");
      expect(upstream.seen).toEqual([]);
      expect(lines(relay.records)).toMatchObject([
        { outcome: "refused", reason: "method-not-allowed", level: "warn" },
      ]);
    },
  );

  it("refuses a wrong capability, another run's capability and a browser origin", async () => {
    const upstream = await startUpstream((_request, response) => response.end("never"));
    const relay = await fixture({ upstream });
    const wrong = await send(relay.origin, relay.path(JAR), {
      headers: mavenAuth("not-the-capability"),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers["www-authenticate"]).toBeUndefined();
    const browser = await send(relay.origin, relay.path(JAR), {
      headers: { ...mavenAuth(relay.capability), origin: "http://evil.example" },
    });
    expect(browser.status).toBe(403);
    expect(upstream.seen).toEqual([]);
    expect(lines(relay.records).map((line) => line.reason)).toEqual([
      "capability-invalid",
      "origin-not-allowed",
    ]);
  });

  it("refuses a revoked capability with a plain explanation, and settles the binding once", async () => {
    const upstream = await startUpstream((_request, response) =>
      response.writeHead(200, { "content-length": "2" }).end("ok"),
    );
    const relay = await fixture({ upstream });
    await send(relay.origin, relay.path(JAR), { headers: mavenAuth(relay.capability) });
    await send(relay.origin, relay.path(`${JAR}.sha1`), { headers: mavenAuth(relay.capability) });
    relay.relay.releaseRun(RUN_ID);
    relay.relay.releaseRun(RUN_ID);
    const late = await send(relay.origin, relay.path(JAR), {
      headers: mavenAuth(relay.capability),
    });
    expect(late.status).toBe(401);
    expect(JSON.parse(late.body.toString())).toMatchObject({ error: "binding-revoked" });
    expect(upstream.seen).toHaveLength(2);
    const emitted = lines(relay.records);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      action: "release",
      outcome: "settled",
      ecosystem: "maven",
      correlationId: RUN_ID,
      requestCount: 2,
      relayedCount: 2,
      refusedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      responseBytes: 4,
    });
    expect(emitted[1]).toMatchObject({ outcome: "refused", reason: "binding-revoked" });
  });

  it.each([
    ["a/../b/x.jar", "path-invalid", 400],
    ["org/%2e%2e/x.jar", "path-invalid", 400],
    ["org%2Fexample/x.jar", "path-invalid", 400],
    ["org//x.jar", "path-invalid", 400],
    ["org/example/dir", "path-unsupported", 404],
    ["org/example/x.jar?x=1", "query-refused", 400],
    [`${"a".repeat(1100)}.jar`, "path-too-long", 414],
  ] as const)("refuses the hostile path %s as %s", async (rest, reason, status) => {
    const upstream = await startUpstream((_request, response) => response.end("never"));
    const relay = await fixture({ upstream });
    const reply = await send(relay.origin, relay.path(rest), {
      headers: mavenAuth(relay.capability),
    });
    expect(reply.status).toBe(status);
    expect(upstream.seen).toEqual([]);
    expect(lines(relay.records)).toMatchObject([{ outcome: "refused", reason }]);
  });

  it("passes an upstream 404 on without a body and counts it", async () => {
    const upstream = await startUpstream((_request, response) =>
      response.writeHead(404).end("<html>not found</html>"),
    );
    const relay = await fixture({ upstream });
    const reply = await send(relay.origin, relay.path(JAR), {
      headers: mavenAuth(relay.capability),
    });
    expect(reply.status).toBe(404);
    expect(reply.body).toHaveLength(0);
    relay.relay.releaseRun(RUN_ID);
    expect(lines(relay.records)).toMatchObject([
      { action: "release", relayedCount: 1, upstreamClientErrorCount: 1 },
    ]);
  });

  it("records a credential the repository refuses once, and answers 401 without a challenge", async () => {
    const upstream = await startUpstream(
      (_request, response) => response.end("never"),
      ["nothing-accepted"],
    );
    const relay = await fixture({ upstream });
    for (let index = 0; index < 3; index += 1) {
      const reply = await send(relay.origin, relay.path(JAR), {
        headers: mavenAuth(relay.capability),
      });
      expect(reply.status).toBe(401);
      expect(reply.headers["www-authenticate"]).toBeUndefined();
      expect(reply.body).toHaveLength(0);
    }
    expect(lines(relay.records)).toMatchObject([
      {
        outcome: "failed",
        reason: "upstream-rejected",
        upstreamStatusClass: "4xx",
        errorKind: "internal",
      },
    ]);
    relay.relay.releaseRun(RUN_ID);
    expect(lines(relay.records).at(-1)).toMatchObject({
      relayedCount: 3,
      upstreamClientErrorCount: 3,
    });
  });

  it("answers 502 and records a failure when the repository cannot be reached", async () => {
    const relay = await fixture({
      transport: () => Promise.reject(new TypeError("connect refused")),
    });
    const reply = await send(relay.origin, relay.path(JAR), {
      headers: mavenAuth(relay.capability),
    });
    expect(reply.status).toBe(502);
    expect(lines(relay.records)).toMatchObject([
      {
        outcome: "failed",
        reason: "upstream-failed",
        errorKind: "internal",
      },
    ]);
    expect(Array.isArray(lines(relay.records)[0]?.frames)).toBe(true);
  });

  it("refuses a compressed upstream answer it cannot scan", async () => {
    const upstream = await startUpstream((_request, response) =>
      response.writeHead(200, { "content-encoding": "gzip" }).end(Buffer.from([31, 139, 8, 0])),
    );
    const relay = await fixture({ upstream });
    const reply = await send(relay.origin, relay.path(JAR), {
      headers: mavenAuth(relay.capability),
    });
    expect(reply.status).toBe(502);
    expect(lines(relay.records)).toMatchObject([{ reason: "content-encoding-refused" }]);
  });

  it("counts a request the run abandoned without recording a line", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-length": "100000" });
      // More than the relay holds back of the tail, so the run receives a first part. The answer
      // is never completed: the run walks away first.
      response.write("x".repeat(5000));
    });
    const relay = await fixture({ upstream });
    const { port } = new URL(relay.origin);
    await new Promise<void>((resolve) => {
      const request = httpRequest(
        { host: "127.0.0.1", port, path: relay.path(JAR), headers: mavenAuth(relay.capability) },
        (response) => {
          response.once("data", () => {
            request.destroy();
            resolve();
          });
        },
      );
      request.on("error", () => undefined);
      request.end();
    });
    const stats = relay.relay.authenticate(relay.relayId, relay.capability)?.target.stats;
    await vi.waitFor(() => {
      expect(stats?.cancelled).toBe(1);
    });
    relay.relay.releaseRun(RUN_ID);
    const settled = lines(relay.records);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      action: "release",
      requestCount: 1,
      cancelledCount: 1,
      relayedCount: 0,
    });
  });
});

describe("the relay's budgets (#4522)", () => {
  it("refuses a request beyond the binding's request count", async () => {
    const upstream = await startUpstream((_request, response) => response.end("never"));
    const relay = await fixture({ upstream });
    const admission = relay.relay.authenticate(relay.relayId, relay.capability);
    if (admission === undefined) throw new Error("fixture-admission-failed");
    admission.target.stats.requests = REPOSITORY_RELAY_BINDING_MAX_REQUESTS;
    const reply = await send(relay.origin, relay.path(JAR), {
      headers: mavenAuth(relay.capability),
    });
    expect(reply.status).toBe(429);
    expect(upstream.seen).toEqual([]);
    expect(lines(relay.records)).toMatchObject([
      { outcome: "refused", reason: "budget-exhausted" },
    ]);
  });

  it("refuses a text answer that would exceed the binding's total bytes", async () => {
    const upstream = await startUpstream((_request, response) =>
      response.writeHead(200).end("<project/>"),
    );
    const relay = await fixture({ upstream });
    const admission = relay.relay.authenticate(relay.relayId, relay.capability);
    if (admission === undefined) throw new Error("fixture-admission-failed");
    admission.target.stats.responseBytes = REPOSITORY_RELAY_BINDING_MAX_BYTES - 3;
    const reply = await send(relay.origin, relay.path(POM), {
      headers: mavenAuth(relay.capability),
    });
    expect(reply.status).toBe(429);
    expect(reply.body).toHaveLength(0);
    expect(lines(relay.records)).toMatchObject([
      { outcome: "refused", reason: "budget-exhausted" },
    ]);
  });

  it("cuts a binary answer that exceeds the response cap and refuses an oversized text one", async () => {
    const upstream = await startUpstream((_request, response) =>
      response.writeHead(200).end("x".repeat(5000)),
    );
    const relay = await fixture({
      upstream,
      limits: { responseMaxBytes: 1000, textMaxBytes: 1000 },
    });
    const binary = await send(relay.origin, relay.path(JAR), {
      headers: mavenAuth(relay.capability),
    });
    expect(binary.body.length).toBeLessThan(5000);
    expect(binary.aborted || binary.body.length === 0).toBe(true);
    const text = await send(relay.origin, relay.path(POM), {
      headers: mavenAuth(relay.capability),
    });
    expect(text.status).toBe(502);
    expect(lines(relay.records).map((line) => line.reason)).toEqual([
      "response-too-large",
      "response-too-large",
    ]);
  });
});

describe("the relay's redirects (#4522)", () => {
  // A hop is a function so that each request to the fixture gets its own, unread Response.
  const redirect =
    (location: string): (() => Response) =>
    (): Response =>
      new Response(null, { status: 302, headers: { location } });
  const noLocation = (): Response => new Response(null, { status: 302 });
  const ok = (): Response => new Response("body", { status: 200 });

  async function through(
    hops: readonly (() => Response)[],
    target: Partial<RepositoryRelayTarget> = {},
  ): Promise<{
    readonly reply: Reply;
    readonly calls: { url: string; authorization?: string }[];
    readonly relay: Fixture;
  }> {
    const calls: { url: string; authorization?: string }[] = [];
    const transport: RepositoryRelayUpstream = (url, request) => {
      const call: { url: string; authorization?: string } = { url };
      if (request.headers.authorization !== undefined)
        call.authorization = request.headers.authorization;
      calls.push(call);
      const hop = hops[calls.length - 1];
      return hop === undefined
        ? Promise.reject(new TypeError("unexpected-hop"))
        : Promise.resolve(hop());
    };
    const relay = await fixture({ transport, target });
    const reply = await send(relay.origin, relay.path(POM), {
      headers: mavenAuth(relay.capability),
    });
    return { reply, calls, relay };
  }

  it("keeps the credential on a same-origin redirect", async () => {
    const { reply, calls } = await through([redirect("/maven/moved/x.pom"), ok]);
    expect(reply.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      `https://repo.example.test/maven/${POM}`,
      "https://repo.example.test/maven/moved/x.pom",
    ]);
    expect(calls.map((call) => call.authorization)).toEqual([
      basic(USER, PASSWORD),
      basic(USER, PASSWORD),
    ]);
  });

  it("follows a cross-origin redirect to https without the credential", async () => {
    const { reply, calls } = await through([redirect("https://cdn.example.test/blob/x.pom"), ok]);
    expect(reply.status).toBe(200);
    expect(calls[1]).toEqual({ url: "https://cdn.example.test/blob/x.pom" });
    expect(calls[0]?.authorization).toBeDefined();
  });

  it.each([
    ["a cross-origin http target", "http://cdn.example.test/x.pom"],
    ["a non-http scheme", "ftp://cdn.example.test/x.pom"],
    ["a target with user info", "https://user:pw@cdn.example.test/x.pom"],
    ["Keiko's own server", "http://127.0.0.1:1983/api/health"],
    ["Keiko's own server by its other loopback name", "http://localhost:1983/api/health"],
  ])("refuses a redirect to %s", async (_name, location) => {
    const { reply, calls, relay } = await through([redirect(location)], {
      ownOrigin: "http://127.0.0.1:1983",
    });
    expect(reply.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(lines(relay.records)).toMatchObject([
      { outcome: "refused", reason: "redirect-refused" },
    ]);
  });

  it("refuses a redirect without a Location and a chain of more than three redirects", async () => {
    const missing = await through([noLocation]);
    expect(missing.reply.status).toBe(502);
    const hops = Array.from({ length: REPOSITORY_RELAY_MAX_REDIRECTS + 1 }, () =>
      redirect("/maven/again.pom"),
    );
    const chain = await through([...hops, ok]);
    expect(chain.reply.status).toBe(502);
    expect(chain.calls).toHaveLength(REPOSITORY_RELAY_MAX_REDIRECTS + 1);
    relayRecords(chain.relay);
  });

  function relayRecords(relay: Fixture): void {
    expect(lines(relay.records)).toMatchObject([{ reason: "redirect-refused" }]);
  }

  it("sends the credential again only to the configured origin, never to a cross-origin hop", async () => {
    const { calls } = await through([
      redirect("https://cdn.example.test/a.pom"),
      redirect("https://repo.example.test/maven/back.pom"),
      ok,
    ]);
    expect(calls.map((call) => call.authorization === undefined)).toEqual([false, true, false]);
  });
});

describe("a relayed npm read (#4522)", () => {
  async function npmFixture(
    answer: Answer,
    transport?: RepositoryRelayUpstream,
  ): Promise<{ readonly fx: Fixture; readonly upstream: Upstream }> {
    const upstream = await startUpstream(answer);
    const fx = await fixture({
      upstream,
      target: {
        ecosystem: "npm",
        upstreamBaseUrl: `${upstream.base}/npm/`,
        credential: { kind: "bearer", token: TOKEN },
      },
      transport,
    });
    return { fx, upstream };
  }
  const bearer = (capability: string): Record<string, string> => ({
    authorization: `Bearer ${capability}`,
  });

  it("rewrites the tarball URLs under the upstream base onto the relay and leaves others alone", async () => {
    const { fx, upstream } = await npmFixture((_request, response) => {
      const tarball = (name: string): string => `${upstream.base}/npm/${name}/-/${name}-1.0.0.tgz`;
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          name: "left-pad",
          versions: {
            "1.0.0": { dist: { tarball: tarball("left-pad") } },
            "1.0.1": { dist: { tarball: "https://elsewhere.example.test/left-pad-1.0.1.tgz" } },
            "1.0.2": { dist: {} },
          },
        }),
      );
    });
    const reply = await send(fx.origin, fx.path("left-pad"), { headers: bearer(fx.capability) });
    expect(reply.status).toBe(200);
    const packument = JSON.parse(reply.body.toString()) as {
      versions: Record<string, { dist: { tarball?: string } }>;
    };
    expect(packument.versions["1.0.0"]?.dist.tarball).toBe(
      `${fx.origin}${REPOSITORY_RELAY_PATH_PREFIX}${fx.relayId}/left-pad/-/left-pad-1.0.0.tgz`,
    );
    expect(packument.versions["1.0.1"]?.dist.tarball).toBe(
      "https://elsewhere.example.test/left-pad-1.0.1.tgz",
    );
    expect(reply.headers["content-length"]).toBe(String(reply.body.length));
    expect(upstream.seen[0]?.url).toBe("/npm/left-pad");
    expect(upstream.seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("requests a scoped packument with its encoded slash and streams a tarball", async () => {
    const { fx, upstream } = await npmFixture((request, response) => {
      if (request.url?.endsWith(".tgz") === true)
        response.writeHead(200, { "content-length": "4" }).end("tgz!");
      else response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const packument = await send(fx.origin, fx.path("@scope/name"), {
      headers: bearer(fx.capability),
    });
    expect(packument.status).toBe(200);
    const tarball = await send(fx.origin, fx.path("@scope/name/-/name-1.0.0.tgz"), {
      headers: bearer(fx.capability),
    });
    expect(tarball.body.toString()).toBe("tgz!");
    expect(upstream.seen.map((seen) => seen.url)).toEqual([
      "/npm/@scope%2Fname",
      "/npm/@scope/name/-/name-1.0.0.tgz",
    ]);
  });

  it("refuses an invalid packument and other npm endpoints", async () => {
    const { fx, upstream } = await npmFixture((_request, response) =>
      response.writeHead(200).end("not json"),
    );
    const invalid = await send(fx.origin, fx.path("left-pad"), { headers: bearer(fx.capability) });
    expect(invalid.status).toBe(502);
    const search = await send(fx.origin, fx.path("-/v1/search"), {
      headers: bearer(fx.capability),
    });
    expect(search.status).toBe(404);
    expect(upstream.seen).toHaveLength(1);
    expect(lines(fx.records).map((line) => line.reason)).toEqual([
      "packument-invalid",
      "path-unsupported",
    ]);
  });
});

describe("credential echo (#4522)", () => {
  async function echoing(
    body: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<{ readonly fx: Fixture; readonly upstream: Upstream }> {
    const upstream = await startUpstream(body);
    return { fx: await fixture({ upstream }), upstream };
  }

  it.each([
    ["the raw password", PASSWORD],
    ["the Basic token", Buffer.from(`${USER}:${PASSWORD}`).toString("base64")],
    ["the password in base64", Buffer.from(PASSWORD).toString("base64")],
    ["the password as JSON unicode escapes", PASSWORD.replaceAll("-", "\\u002d")],
    ["the password percent-encoded", PASSWORD.replaceAll("-", "%2d")],
  ])("refuses a POM that holds %s, and the run receives no byte of it", async (_name, leaked) => {
    const { fx } = await echoing((_request, response) =>
      response
        .writeHead(200, { "content-type": "application/xml" })
        .end(`<project><note>${leaked}</note></project>`),
    );
    const reply = await send(fx.origin, fx.path(POM), { headers: mavenAuth(fx.capability) });
    expect(reply.status).toBe(502);
    expect(reply.body).toHaveLength(0);
    expect(lines(fx.records)).toMatchObject([
      { outcome: "failed", reason: "credential-in-response", level: "warn", errorKind: "internal" },
    ]);
  });

  it("refuses a binary answer that holds the credential and releases nothing that spells it", async () => {
    const { fx } = await echoing((_request, response) => {
      response.writeHead(200, { "content-type": "application/java-archive" });
      response.write(
        Buffer.concat([Buffer.alloc(70_000, 65), Buffer.from(PASSWORD.slice(0, 9))]),
        () => {
          response.end(Buffer.concat([Buffer.from(PASSWORD.slice(9)), Buffer.alloc(10, 66)]));
        },
      );
    });
    const reply = await send(fx.origin, fx.path(JAR), { headers: mavenAuth(fx.capability) });
    expect(reply.aborted).toBe(true);
    const received = reply.body.toString("latin1");
    expect(received).not.toContain(PASSWORD);
    expect(received).not.toContain(PASSWORD.slice(0, 6));
    expect(lines(fx.records)).toMatchObject([
      { outcome: "failed", reason: "credential-in-response" },
    ]);
  });

  it("refuses a response header that holds the credential", async () => {
    const { fx } = await echoing((_request, response) =>
      response.writeHead(200, { etag: `"${PASSWORD}"`, "content-length": "2" }).end("ok"),
    );
    const reply = await send(fx.origin, fx.path(JAR), { headers: mavenAuth(fx.capability) });
    expect(reply.status).toBe(502);
    expect(lines(fx.records)).toMatchObject([{ reason: "credential-in-response-header" }]);
  });

  it("holds back the tail of every chunk until the next one proves it is no credential", async () => {
    const secret = Buffer.from(PASSWORD);
    const written: Buffer[] = [];
    const response = {
      write: (chunk: Uint8Array): boolean => {
        written.push(Buffer.from(chunk));
        return true;
      },
    } as unknown as ServerResponse;
    const chunks = [Buffer.from("aaaa"), secret.subarray(0, 7), secret.subarray(7)];
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    );
    const budget = { responseMaxBytes: 1000, charge: (): void => undefined };
    await expect(
      pipeBinaryBody(upstream, response, credentialByteForms([PASSWORD]), budget),
    ).rejects.toMatchObject({ reason: "credential-in-response" });
    expect(Buffer.concat(written).toString("latin1")).not.toContain(PASSWORD.slice(0, 5));
    expect(new RelayRefusal(502, "credential-in-response").status).toBe(502);
  });

  it("streams an artifact that holds no credential unchanged, however it is chunked", async () => {
    const artifact = Buffer.from(Array.from({ length: 200_000 }, (_, index) => index % 251));
    const written: Buffer[] = [];
    const response = {
      write: (chunk: Uint8Array): boolean => {
        written.push(Buffer.from(chunk));
        return true;
      },
    } as unknown as ServerResponse;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          for (let offset = 0; offset < artifact.length; offset += 7919)
            controller.enqueue(artifact.subarray(offset, offset + 7919));
          controller.close();
        },
      }),
    );
    const total = await pipeBinaryBody(upstream, response, credentialByteForms([PASSWORD]), {
      responseMaxBytes: artifact.length,
      charge: (): void => undefined,
    });
    expect(total).toBe(artifact.length);
    expect(Buffer.concat(written).equals(artifact)).toBe(true);
  });
});

describe("the activity lines (#4522)", () => {
  it("never carry a URL, host, path, user name or credential", async () => {
    const upstream = await startUpstream((_request, response) => response.writeHead(404).end());
    const relay = await fixture({ upstream });
    await send(relay.origin, relay.path("org/%2e%2e/x.jar"), {
      headers: mavenAuth(relay.capability),
    });
    await send(relay.origin, relay.path(JAR), { headers: mavenAuth(relay.capability) });
    await send(relay.origin, relay.path(JAR), {
      method: "PUT",
      headers: mavenAuth(relay.capability),
    });
    relay.relay.releaseRun(RUN_ID);
    const text = JSON.stringify(lines(relay.records));
    for (const forbidden of [
      PASSWORD,
      USER,
      relay.capability,
      "127.0.0.1",
      "org/",
      "lib-1.0",
      "maven/",
    ])
      expect(text, forbidden).not.toContain(forbidden);
    expect(lines(relay.records).every((line) => line.correlationId === RUN_ID)).toBe(true);
  });

  it("use the request's own correlation for a request no run accounts for", async () => {
    const { sink: activityLog, records } = sink();
    const relay = createRepositoryCredentialRelay({ activityLog: () => activityLog });
    const origin = await startRelay(relay, activityLog);
    const reply = await send(
      origin,
      `${REPOSITORY_RELAY_PATH_PREFIX}AAAAAAAAAAAAAAAAAAAAAA/${JAR}`,
      {
        headers: { authorization: "Bearer nothing" },
      },
    );
    expect(reply.status).toBe(401);
    expect(lines(records)).toMatchObject([
      { reason: "capability-invalid", correlationId: "request-correlation" },
    ]);
  });
});
