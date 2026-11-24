import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
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
  type RepositoryRelayServeOptions,
  type RepositoryRelayTarget,
  type RepositoryRelayUpstream,
} from "./repositoryCredentialRelay.js";
import { OutboundHttpEgressError } from "@oscharko-dev/keiko-model-gateway/internal/http";
import { RelayAdmissionGate } from "./repositoryRelayLimiter.js";
import { pipeBinaryBody, credentialByteForms, RelayRefusal } from "./repositoryRelayResponse.js";

const RUN_ID = "run-repository";
// Keiko's own origin as a bound target carries it; no fixture server listens on this port.
const OWN_ORIGIN = "http://127.0.0.1:1983";
// A host name resolves to a public address unless a test says otherwise; no test resolves DNS.
const PUBLIC_RESOLVER = (): Promise<readonly string[]> => Promise.resolve(["93.184.216.34"]);
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
  extra: Partial<RepositoryRelayServeOptions> = {},
): Promise<string> {
  const server = createServer((request, response) => {
    const rest = (request.url ?? "").slice(REPOSITORY_RELAY_PATH_PREFIX.length);
    void serveRepositoryRelayRequest(
      request,
      response,
      { relayId: rest.split("/", 1)[0] ?? "" },
      {
        relay,
        upstream,
        activityLog,
        correlationId: "request-correlation",
        limits,
        resolveHost: PUBLIC_RESOLVER,
        ...extra,
      },
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
  readonly serve?: Partial<RepositoryRelayServeOptions> | undefined;
}): Promise<Fixture> {
  const { sink: activityLog, records } = sink();
  const relay = createRepositoryCredentialRelay({ activityLog: () => activityLog });
  const binding = relay.bind({
    runId: RUN_ID,
    ecosystem: "maven",
    upstreamBaseUrl: `${input.upstream?.base ?? "https://repo.example.test"}/maven/`,
    credential: { kind: "basic", username: USER, password: PASSWORD },
    secrets: [],
    ownOrigin: OWN_ORIGIN,
    ...input.target,
  });
  if (binding === undefined) throw new Error("fixture-bind-failed");
  const origin = await startRelay(relay, activityLog, input.transport, input.limits, input.serve);
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

  it("builds a base URL from an origin with a very long run of trailing slashes in linear time", () => {
    // A trailing-slash pattern that backtracks takes quadratic time here and would outlive the test.
    const origin = `http://127.0.0.1:1983${"/".repeat(300_000)}x${"/".repeat(300_000)}`;
    expect(repositoryRelayBaseUrl(origin, "abc")).toBe(
      `http://127.0.0.1:1983${"/".repeat(300_000)}x/api/coding-sidecar/repository/abc/`,
    );
    expect(repositoryRelayBaseUrl(`http://127.0.0.1:1983${"/".repeat(300_000)}`, "abc")).toBe(
      "http://127.0.0.1:1983/api/coding-sidecar/repository/abc/",
    );
  });

  it("revokes one binding on request and records its settled summary once", () => {
    const { sink: activityLog, records } = sink();
    const relay = createRepositoryCredentialRelay({ activityLog: () => activityLog });
    const binding = relay.bind({
      runId: RUN_ID,
      ecosystem: "maven",
      upstreamBaseUrl: "https://repo.example.test/maven",
      credential: { kind: "basic", username: USER, password: PASSWORD },
      secrets: [],
      ownOrigin: OWN_ORIGIN,
    });
    if (binding === undefined) throw new Error("fixture-bind-failed");
    relay.revoke(binding.relayId);
    relay.revoke(binding.relayId);
    expect(relay.authenticate(binding.relayId, binding.capability)).toBeUndefined();
    expect(relay.wasRevoked(binding.relayId, binding.capability)).toBe(true);
    expect(lines(records).filter((line) => line.action === "release")).toHaveLength(1);
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
      ownOrigin: OWN_ORIGIN,
    });
    const second = relay.bind({
      runId: RUN_ID,
      ecosystem: "npm",
      upstreamBaseUrl: "https://npm.example.test/",
      credential: { kind: "bearer", token: TOKEN },
      secrets: [],
      ownOrigin: OWN_ORIGIN,
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
        ownOrigin: OWN_ORIGIN,
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
      ownOrigin: OWN_ORIGIN,
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
    rewritePackumentTarballs?: boolean,
  ): Promise<{ readonly fx: Fixture; readonly upstream: Upstream }> {
    const upstream = await startUpstream(answer);
    const fx = await fixture({
      upstream,
      target: {
        ecosystem: "npm",
        upstreamBaseUrl: `${upstream.base}/npm/`,
        credential: { kind: "bearer", token: TOKEN },
        ...(rewritePackumentTarballs === undefined ? {} : { rewritePackumentTarballs }),
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
    // The run's configuration names the bound origin, so its tarballs move there too.
    expect(packument.versions["1.0.0"]?.dist.tarball).toBe(
      `${OWN_ORIGIN}${REPOSITORY_RELAY_PATH_PREFIX}${fx.relayId}/left-pad/-/left-pad-1.0.0.tgz`,
    );
    expect(packument.versions["1.0.1"]?.dist.tarball).toBe(
      "https://elsewhere.example.test/left-pad-1.0.1.tgz",
    );
    expect(reply.headers["content-length"]).toBe(String(reply.body.length));
    expect(upstream.seen[0]?.url).toBe("/npm/left-pad");
    expect(upstream.seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  // #4491: a run whose npm moves the tarballs onto the relay itself (`replace-registry-host`) gets
  // the packument as the registry wrote it, so a lockfile it writes pins the person's registry and
  // never the relay's address, which lasts one run. npm then sends the tarball under the base path.
  it("leaves a packument's tarball URLs on the registry when the run's npm moves them", async () => {
    const packument = (base: string): string =>
      JSON.stringify({
        name: "left-pad",
        versions: { "1.0.0": { dist: { tarball: `${base}/npm/left-pad/-/left-pad-1.0.0.tgz` } } },
      });
    const { fx, upstream } = await npmFixture(
      (request, response) => {
        if (request.url?.endsWith(".tgz") === true) response.writeHead(200).end("tgz!");
        else
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(packument(upstream.base));
      },
      undefined,
      false,
    );
    const reply = await send(fx.origin, fx.path("left-pad"), { headers: bearer(fx.capability) });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body.toString())).toEqual(JSON.parse(packument(upstream.base)));
    const tarball = await send(fx.origin, fx.path("npm/left-pad/-/left-pad-1.0.0.tgz"), {
      headers: bearer(fx.capability),
    });
    expect(tarball.status).toBe(200);
    expect(tarball.body.toString()).toBe("tgz!");
    expect(upstream.seen.map((seen) => seen.url)).toEqual([
      "/npm/left-pad",
      "/npm/left-pad/-/left-pad-1.0.0.tgz",
    ]);
  });

  // A bound base without its trailing slash names the same registry: the base path a lockfile's
  // tarball arrives under is read from the normalised base, so it still matches at a segment.
  it("admits a lockfile's tarball under a base bound without its trailing slash", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200).end("tgz!");
    });
    const fx = await fixture({
      upstream,
      target: {
        ecosystem: "npm",
        upstreamBaseUrl: `${upstream.base}/npm`,
        credential: { kind: "bearer", token: TOKEN },
        rewritePackumentTarballs: false,
      },
    });
    const tarball = await send(fx.origin, fx.path("npm/left-pad/-/left-pad-1.0.0.tgz"), {
      headers: bearer(fx.capability),
    });
    expect(tarball.status).toBe(200);
    expect(upstream.seen.map((seen) => seen.url)).toEqual(["/npm/left-pad/-/left-pad-1.0.0.tgz"]);
  });

  // #4530 real-model lab: the dev runner proxies the run's request to the BFF and rewrites Host to
  // the BFF's port. A tarball URL built from that header named an origin npm sends no capability
  // to, so the install fetched every packument and never a tarball.
  it("moves tarballs onto the bound origin even when a proxy rewrote the request's Host", async () => {
    const { fx, upstream } = await npmFixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          name: "left-pad",
          versions: {
            "1.0.0": { dist: { tarball: `${upstream.base}/npm/left-pad/-/left-pad-1.0.0.tgz` } },
          },
        }),
      );
    });
    const reply = await send(fx.origin, fx.path("left-pad"), {
      headers: { ...bearer(fx.capability), host: "127.0.0.1:19841" },
    });
    expect(reply.status).toBe(200);
    const packument = JSON.parse(reply.body.toString()) as {
      versions: Record<string, { dist: { tarball?: string } }>;
    };
    expect(packument.versions["1.0.0"]?.dist.tarball).toBe(
      `${OWN_ORIGIN}${REPOSITORY_RELAY_PATH_PREFIX}${fx.relayId}/left-pad/-/left-pad-1.0.0.tgz`,
    );
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

// ─── #4522 audit repairs ───────────────────────────────────────────────────────────────────────

describe("the own origin of a binding (#4522)", () => {
  function attempt(ownOrigin: unknown): {
    readonly binding: RepositoryRelayBinding | undefined;
    readonly reasons: readonly unknown[];
  } {
    const { sink: activityLog, records } = sink();
    const relay = createRepositoryCredentialRelay({ activityLog: () => activityLog });
    const binding = relay.bind({
      runId: RUN_ID,
      ecosystem: "maven",
      upstreamBaseUrl: "https://repo.example.test/",
      secrets: [],
      ownOrigin,
    } as unknown as RepositoryRelayTarget);
    return { binding, reasons: lines(records).map((line) => line.reason) };
  }

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["not a URL", "not a url"],
    ["a non-loopback host", "http://repo.example.test:1983"],
    ["https", "https://127.0.0.1:1983"],
    ["without an explicit port", "http://127.0.0.1"],
    ["a private address", "http://10.0.0.5:1983"],
  ])("refuses a binding whose own origin is %s, as the closed reason", (_name, ownOrigin) => {
    const { binding, reasons } = attempt(ownOrigin);
    expect(binding).toBeUndefined();
    expect(reasons).toEqual(["own-origin-invalid"]);
  });

  it.each(["http://127.0.0.1:1983", "http://localhost:50123", "http://[::1]:1983"])(
    "binds with the loopback origin %s",
    (ownOrigin) => {
      expect(attempt(ownOrigin).binding).toBeDefined();
    },
  );
});

describe("a redirect's network (#4522)", () => {
  const redirect =
    (location: string): (() => Response) =>
    (): Response =>
      new Response(null, { status: 302, headers: { location } });
  const ok = (): Response => new Response("body", { status: 200 });

  interface Call {
    readonly url: string;
    readonly allowPrivateNetwork: boolean;
    readonly allowLoopback: boolean;
  }

  async function through(input: {
    readonly hops: readonly (() => Response)[];
    readonly upstreamBaseUrl?: string;
    readonly resolveHost?: RepositoryRelayServeOptions["resolveHost"];
    readonly failHopWith?: Error;
  }): Promise<{ readonly reply: Reply; readonly calls: Call[]; readonly relay: Fixture }> {
    const calls: Call[] = [];
    const transport: RepositoryRelayUpstream = (url, request) => {
      calls.push({
        url,
        allowPrivateNetwork: request.allowPrivateNetwork,
        allowLoopback: request.allowLoopback,
      });
      const hop = input.hops[calls.length - 1];
      if (input.failHopWith !== undefined && calls.length > 1)
        return Promise.reject(input.failHopWith);
      return hop === undefined
        ? Promise.reject(new TypeError("unexpected"))
        : Promise.resolve(hop());
    };
    const relay = await fixture({
      transport,
      target: input.upstreamBaseUrl === undefined ? {} : { upstreamBaseUrl: input.upstreamBaseUrl },
      serve: { resolveHost: input.resolveHost ?? PUBLIC_RESOLVER },
    });
    const reply = await send(relay.origin, relay.path(POM), {
      headers: mavenAuth(relay.capability),
    });
    return { reply, calls, relay };
  }

  const PRIVATE_RESOLVER = (): Promise<readonly string[]> => Promise.resolve(["10.1.2.3"]);

  it.each([
    ["a private address", "https://10.0.0.5/x.pom"],
    ["another private range", "https://192.168.1.5/x.pom"],
    ["a loopback address of another port", "https://127.0.0.1:8443/x.pom"],
    ["an IPv6 loopback address", "https://[::1]/x.pom"],
    ["localhost", "https://localhost:8443/x.pom"],
    ["the metadata address", "https://169.254.169.254/latest/meta-data"],
    ["a link-local address", "https://169.254.10.10/x.pom"],
  ])("refuses a public upstream's redirect to %s", async (_name, location) => {
    const { reply, calls, relay } = await through({ hops: [redirect(location)] });
    expect(reply.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect(lines(relay.records)).toMatchObject([
      { outcome: "refused", reason: "redirect-network-refused" },
    ]);
  });

  it("follows a public upstream's redirect to a public address, with a public-only network", async () => {
    const { reply, calls } = await through({ hops: [redirect("https://203.0.113.7/x.pom"), ok] });
    expect(reply.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ allowPrivateNetwork: true, allowLoopback: true });
    expect(calls[1]).toEqual({
      url: "https://203.0.113.7/x.pom",
      allowPrivateNetwork: false,
      allowLoopback: false,
    });
  });

  it("lets a private-network upstream redirect to internal storage, never to loopback", async () => {
    const internal = await through({
      hops: [redirect("https://10.9.9.9/blob/x.pom"), ok],
      resolveHost: PRIVATE_RESOLVER,
    });
    expect(internal.reply.status).toBe(200);
    expect(internal.calls[1]).toMatchObject({ allowPrivateNetwork: true, allowLoopback: false });
    const loopback = await through({
      hops: [redirect("https://127.0.0.1:9443/x.pom")],
      resolveHost: PRIVATE_RESOLVER,
    });
    expect(loopback.reply.status).toBe(502);
    expect(lines(loopback.relay.records)).toMatchObject([{ reason: "redirect-network-refused" }]);
    const metadata = await through({
      hops: [redirect("https://169.254.169.254/x")],
      resolveHost: PRIVATE_RESOLVER,
    });
    expect(lines(metadata.relay.records)).toMatchObject([{ reason: "redirect-network-refused" }]);
  });

  it("lets a loopback upstream redirect to another loopback port and to private storage, not to Keiko", async () => {
    const upstreamBaseUrl = "http://127.0.0.1:4873/maven/";
    const loopback = await through({
      hops: [redirect("https://127.0.0.1:9443/x.pom"), ok],
      upstreamBaseUrl,
    });
    expect(loopback.reply.status).toBe(200);
    expect(loopback.calls[1]).toMatchObject({ allowPrivateNetwork: true, allowLoopback: true });
    const internal = await through({
      hops: [redirect("https://10.0.0.5/x.pom"), ok],
      upstreamBaseUrl,
    });
    expect(internal.reply.status).toBe(200);
    const own = await through({
      hops: [redirect("https://127.0.0.1:1983/api/health")],
      upstreamBaseUrl,
    });
    expect(own.reply.status).toBe(502);
    expect(lines(own.relay.records)).toMatchObject([{ reason: "redirect-refused" }]);
  });

  it("keeps the first hop and a same-origin redirect on the configured network", async () => {
    const { calls } = await through({
      hops: [redirect("/maven/moved/x.pom"), ok],
      resolveHost: () => Promise.reject(new Error("never asked")),
    });
    expect(calls.map((call) => [call.allowPrivateNetwork, call.allowLoopback])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it("answers a host name's hop with the egress policy's refusal as the closed reason", async () => {
    const policy = new OutboundHttpEgressError("PROXY_BLOCKED_BY_POLICY", "blocked");
    const { reply, relay } = await through({
      hops: [redirect("https://storage.example.test/x.pom")],
      failHopWith: policy,
    });
    expect(reply.status).toBe(502);
    expect(lines(relay.records)).toMatchObject([
      { outcome: "refused", reason: "redirect-network-refused" },
    ]);
  });

  it("does not map the egress policy's refusal of the first hop to a redirect reason", async () => {
    const transport: RepositoryRelayUpstream = () =>
      Promise.reject(new OutboundHttpEgressError("PROXY_BLOCKED_BY_POLICY", "blocked"));
    const relay = await fixture({ transport });
    const reply = await send(relay.origin, relay.path(POM), {
      headers: mavenAuth(relay.capability),
    });
    expect(reply.status).toBe(502);
    expect(lines(relay.records)).toMatchObject([{ outcome: "failed", reason: "upstream-failed" }]);
  });

  it("decides the configured network once, and forgets a failed resolution", async () => {
    const resolveHost = vi.fn(PRIVATE_RESOLVER);
    const first = await through({
      hops: [redirect("https://10.9.9.9/a.pom"), redirect("https://10.9.9.8/b.pom"), ok],
      resolveHost,
    });
    expect(first.reply.status).toBe(200);
    expect(resolveHost).toHaveBeenCalledTimes(1);

    const failing = vi
      .fn<NonNullable<RepositoryRelayServeOptions["resolveHost"]>>()
      .mockRejectedValueOnce(new Error("dns down"))
      .mockResolvedValue(["10.1.2.3"]);
    const second = await through({
      hops: [redirect("https://10.9.9.9/a.pom")],
      resolveHost: failing,
    });
    expect(second.reply.status).toBe(502);
    expect(lines(second.relay.records)).toMatchObject([{ outcome: "failed" }]);
    const stats = second.relay.relay.authenticate(second.relay.relayId, second.relay.capability)
      ?.target.stats;
    expect(stats?.upstreamNetwork).toBeUndefined();
  });
});

describe("the relay's concurrency, memory and timing bounds (#4522)", () => {
  interface Held {
    readonly upstream: Upstream;
    readonly held: ServerResponse[];
  }

  // A repository that holds every answer until the test ends it.
  async function holdingUpstream(): Promise<Held> {
    const held: ServerResponse[] = [];
    const upstream = await startUpstream((_request, response) => {
      held.push(response);
    });
    return { upstream, held };
  }

  const gateOf = (
    overrides: Partial<ConstructorParameters<typeof RelayAdmissionGate>[0]> = {},
  ): RelayAdmissionGate =>
    new RelayAdmissionGate({
      perBinding: 16,
      process: 32,
      maxWaiters: 256,
      waitMs: 30_000,
      textBudgetBytes: 512 * 1024 * 1024,
      ...overrides,
    });

  function get(relay: Fixture, path = JAR): Promise<Reply> {
    return send(relay.origin, relay.path(path), { headers: mavenAuth(relay.capability) });
  }

  it("holds a request beyond the binding's cap in the queue and serves it when a slot frees", async () => {
    const { upstream, held } = await holdingUpstream();
    const gate = gateOf({ perBinding: 2 });
    const relay = await fixture({ upstream, serve: { gate } });
    const replies = [get(relay), get(relay), get(relay)];
    await vi.waitFor(() => {
      expect(upstream.seen).toHaveLength(2);
      expect(gate.snapshot()).toMatchObject({ inFlight: 2, waiting: 1 });
    });
    held[0]?.end("first");
    await vi.waitFor(() => {
      expect(upstream.seen).toHaveLength(3);
    });
    held[1]?.end("second");
    held[2]?.end("third");
    expect((await Promise.all(replies)).map((reply) => reply.status)).toEqual([200, 200, 200]);
    expect(gate.snapshot()).toEqual({ inFlight: 0, waiting: 0, textBytes: 0 });
  });

  it("answers 503 with Retry-After when the queue is full, and records only the first refusal", async () => {
    const { upstream, held } = await holdingUpstream();
    const gate = gateOf({ perBinding: 1, maxWaiters: 0 });
    const relay = await fixture({ upstream, serve: { gate } });
    const first = get(relay);
    await vi.waitFor(() => {
      expect(upstream.seen).toHaveLength(1);
    });
    const busy = [await get(relay), await get(relay)];
    expect(busy.map((reply) => reply.status)).toEqual([503, 503]);
    expect(busy.map((reply) => reply.headers["retry-after"])).toEqual(["1", "1"]);
    expect(upstream.seen).toHaveLength(1);
    held[0]?.end("done");
    expect((await first).status).toBe(200);
    expect(lines(relay.records)).toMatchObject([
      { action: "request", outcome: "refused", reason: "relay-busy" },
    ]);
    relay.relay.releaseRun(RUN_ID);
    expect(lines(relay.records).at(-1)).toMatchObject({
      action: "release",
      requestCount: 3,
      relayedCount: 1,
      refusedCount: 2,
    });
  });

  it("refuses a waiter whose wait ran out", async () => {
    const { upstream, held } = await holdingUpstream();
    const gate = gateOf({ perBinding: 1, waitMs: 40 });
    const relay = await fixture({ upstream, serve: { gate } });
    const first = get(relay);
    await vi.waitFor(() => {
      expect(upstream.seen).toHaveLength(1);
    });
    const waiter = await get(relay);
    expect(waiter.status).toBe(503);
    expect(gate.snapshot().waiting).toBe(0);
    held[0]?.end("done");
    await first;
  });

  it("drops a waiter whose client disconnected and frees its place", async () => {
    const { upstream, held } = await holdingUpstream();
    const gate = gateOf({ perBinding: 1 });
    const relay = await fixture({ upstream, serve: { gate } });
    const first = get(relay);
    await vi.waitFor(() => {
      expect(upstream.seen).toHaveLength(1);
    });
    const { port } = new URL(relay.origin);
    const waiting = httpRequest({
      host: "127.0.0.1",
      port,
      path: relay.path(JAR),
      headers: mavenAuth(relay.capability),
    });
    waiting.on("error", () => undefined);
    waiting.end();
    await vi.waitFor(() => {
      expect(gate.snapshot().waiting).toBe(1);
    });
    waiting.destroy();
    await vi.waitFor(() => {
      expect(gate.snapshot().waiting).toBe(0);
    });
    held[0]?.end("done");
    await first;
    expect(gate.snapshot()).toEqual({ inFlight: 0, waiting: 0, textBytes: 0 });
  });

  it("does not let another binding wait behind a binding at its cap", async () => {
    const { upstream, held } = await holdingUpstream();
    const gate = gateOf({ perBinding: 1 });
    const one = await fixture({ upstream, serve: { gate } });
    const two = await fixture({ upstream, serve: { gate } });
    const first = get(one);
    const second = get(two);
    await vi.waitFor(() => {
      expect(upstream.seen).toHaveLength(2);
    });
    held[0]?.end("a");
    held[1]?.end("b");
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
  });

  it("holds the declared length of a text answer against the budget and refuses one over it", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.end("p".repeat(2000));
    });
    const gate = gateOf({ textBudgetBytes: 1500 });
    const relay = await fixture({ upstream, serve: { gate } });
    const refused = await get(relay, POM);
    expect(refused.status).toBe(503);
    expect(refused.headers["retry-after"]).toBe("1");
    expect(lines(relay.records)).toMatchObject([{ reason: "relay-busy" }]);
    expect(gate.snapshot().textBytes).toBe(0);
  });

  it("grows the reservation of an answer without a declared length, and returns it afterwards", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200);
      response.write("p".repeat(1000));
      response.end("q".repeat(1000));
    });
    const gate = gateOf({ textBudgetBytes: 1500 });
    const relay = await fixture({ upstream, serve: { gate } });
    expect((await get(relay, POM)).status).toBe(503);
    expect(gate.snapshot().textBytes).toBe(0);
    const small = await startUpstream((_request, response) => {
      response.end("p".repeat(1000));
    });
    const other = await fixture({ upstream: small, serve: { gate } });
    expect((await get(other, POM)).body).toHaveLength(1000);
    expect(gate.snapshot()).toEqual({ inFlight: 0, waiting: 0, textBytes: 0 });
  });

  it("refuses a text answer that declares more than the text bound without reading it", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.end("p".repeat(500));
    });
    const relay = await fixture({
      upstream,
      limits: { textMaxBytes: 100 },
      serve: { gate: gateOf() },
    });
    expect((await get(relay, POM)).status).toBe(502);
    expect(lines(relay.records)).toMatchObject([{ reason: "response-too-large" }]);
  });

  it("cuts an upstream that never answers at the idle limit, and one that outlives the ceiling", async () => {
    const upstream = await startUpstream(() => undefined);
    const idle = await fixture({
      upstream,
      limits: { upstreamIdleMs: 60, upstreamTotalMs: 60_000 },
      serve: { gate: gateOf() },
    });
    expect((await get(idle, POM)).status).toBe(504);
    expect(lines(idle.records)).toMatchObject([{ outcome: "failed", reason: "upstream-timeout" }]);
    const total = await fixture({
      upstream,
      limits: { upstreamIdleMs: 60_000, upstreamTotalMs: 60 },
      serve: { gate: gateOf() },
    });
    expect((await get(total, POM)).status).toBe(504);
    expect(lines(total.records)).toMatchObject([{ outcome: "failed", reason: "upstream-timeout" }]);
  });

  it("cuts an upstream that went quiet after its headers", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
    });
    const gate = gateOf();
    const relay = await fixture({
      upstream,
      limits: { upstreamIdleMs: 60 },
      serve: { gate },
    });
    expect((await get(relay, POM)).status).toBe(504);
    expect(gate.snapshot()).toEqual({ inFlight: 0, waiting: 0, textBytes: 0 });
  });
});

describe("a client that stops reading (#4522)", () => {
  // A response whose socket buffer is full: `write` reports back-pressure until it drains.
  function fullResponse(): ServerResponse & EventEmitter {
    const emitter = new EventEmitter();
    return Object.assign(emitter, { write: (): boolean => false }) as unknown as ServerResponse &
      EventEmitter;
  }

  function body(): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(Buffer.alloc(5000, 1));
          controller.close();
        },
      }),
    );
  }

  const budget = { responseMaxBytes: 1_000_000, charge: (): void => undefined, stallMs: 30_000 };

  it("cuts a client that drains nothing for the stall limit", async () => {
    vi.useFakeTimers();
    try {
      const outcome = expect(
        pipeBinaryBody(body(), fullResponse(), credentialByteForms([PASSWORD]), budget),
      ).rejects.toMatchObject({ reason: "client-stalled", status: 408 });
      await vi.advanceTimersByTimeAsync(30_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes on when the client drains within the limit", async () => {
    vi.useFakeTimers();
    try {
      const response = fullResponse();
      const piped = pipeBinaryBody(body(), response, credentialByteForms([PASSWORD]), budget);
      await vi.advanceTimersByTimeAsync(29_000);
      // Draining, then the write of the held-back tail stalls again and drains too.
      response.emit("drain");
      await vi.advanceTimersByTimeAsync(1_000);
      response.emit("drain");
      await expect(piped).resolves.toBe(5000);
    } finally {
      vi.useRealTimers();
    }
  });
});
