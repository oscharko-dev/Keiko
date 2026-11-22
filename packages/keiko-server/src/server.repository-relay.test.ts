import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { buildCspHeader } from "./csp.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import {
  createRepositoryCredentialRelay,
  repositoryRelayBaseUrl,
  type RepositoryCredentialRelay,
  type RepositoryRelayUpstream,
} from "./repository-relay/repositoryCredentialRelay.js";
import { createUiServer, UI_HOST } from "./server.js";

// #4522: the repository relay reached through the real server -- router, host check, CSRF gate and
// request log -- rather than through a bare listener.
const USER = "builder";
const PASSWORD = "repo-password-canary";
const basic = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;

const servers: Server[] = [];
let staticRoot = "";

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-repository-relay-static-"));
  await writeFile(join(staticRoot, "index.html"), "<html></html>", "utf8");
});

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
  await rm(staticRoot, { recursive: true, force: true });
});

async function listen(server: Server, port = 0): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  return (server.address() as AddressInfo).port;
}

function handlerDeps(
  relay: RepositoryCredentialRelay,
  upstream: RepositoryRelayUpstream,
): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    repositoryRelay: { relay, upstream },
  };
}

interface Started {
  readonly port: number;
  readonly requestLines: ServerLogEvent[];
  readonly relayLines: ServerLogEvent[];
  readonly relay: RepositoryCredentialRelay;
  readonly upstreamSeen: { method: string; url: string; authorization: string | undefined }[];
  readonly nextRequestLine: () => Promise<void>;
}

async function start(): Promise<Started> {
  const upstreamSeen: Started["upstreamSeen"] = [];
  const repository = createServer((request, response) => {
    upstreamSeen.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
    });
    if (request.headers.authorization !== basic(USER, PASSWORD)) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-length": "7" }).end("jar-bin");
  });
  const repositoryPort = await listen(repository);
  const requestLines: ServerLogEvent[] = [];
  const relayLines: ServerLogEvent[] = [];
  let waiter: (() => void) | undefined;
  const activityLog: ServerLogSink = {
    write: (event) => {
      requestLines.push(event);
      waiter?.();
    },
  };
  const relay = createRepositoryCredentialRelay({
    activityLog: () => ({
      write: (event): void => {
        relayLines.push(event);
      },
    }),
  });
  const upstream: RepositoryRelayUpstream = (url, init): Promise<Response> =>
    fetch(url, {
      method: init.method,
      headers: init.headers,
      redirect: "manual",
      signal: init.signal,
    });
  // The server first binds an ephemeral port, then is rebuilt with it, so its host check knows it.
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  servers.pop();
  const server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: handlerDeps(relay, upstream),
    activityLog,
  });
  await listen(server, port);
  const binding = relay.bind({
    runId: "run-e2e",
    ecosystem: "maven",
    upstreamBaseUrl: `http://${UI_HOST}:${String(repositoryPort)}/maven/`,
    credential: { kind: "basic", username: USER, password: PASSWORD },
    secrets: [],
    ownOrigin: `http://${UI_HOST}:${String(port)}`,
  });
  if (binding === undefined) throw new Error("fixture-bind-failed");
  relayLines.length = 0;
  bound = binding;
  return {
    port,
    requestLines,
    relayLines,
    relay,
    upstreamSeen,
    nextRequestLine: () =>
      new Promise<void>((resolve) => {
        waiter = resolve;
      }),
  };
}

let bound: { readonly relayId: string; readonly capability: string } | undefined;

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: UI_HOST, port, path, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function relayPath(rest: string): string {
  return `${repositoryRelayBaseUrl("", bound?.relayId ?? "")}${rest}`;
}

describe("the repository relay through the real server", () => {
  it("challenges, then serves the file with the repository credential, as Maven does", async () => {
    const started = await start();
    const path = relayPath("org/example/lib/1.0/lib-1.0.jar");
    const challenge = await get(started.port, path);
    expect(challenge.status).toBe(401);
    expect(challenge.headers["www-authenticate"]).toMatch(/^Basic realm="keiko-repository-relay"/u);
    const served = await get(started.port, path, {
      authorization: basic("any-user", bound?.capability ?? ""),
    });
    expect(served.status).toBe(200);
    expect(served.body).toBe("jar-bin");
    expect(started.upstreamSeen).toEqual([
      {
        method: "GET",
        url: "/maven/org/example/lib/1.0/lib-1.0.jar",
        authorization: basic(USER, PASSWORD),
      },
    ]);
  });

  it("serves HEAD and answers 405 to every write method without a CSRF verdict first", async () => {
    const started = await start();
    const path = relayPath("org/example/lib/1.0/lib-1.0.pom");
    const headers = { authorization: basic("any-user", bound?.capability ?? "") };
    expect((await get(started.port, path, headers, "HEAD")).status).toBe(200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await get(started.port, path, headers, method)).status, method).toBe(405);
    expect(started.upstreamSeen.map((seen) => seen.method)).toEqual(["HEAD"]);
  });

  it("refuses a hostile path as sent, although the router normalises a dot segment", async () => {
    const started = await start();
    const headers = { authorization: basic("any-user", bound?.capability ?? "") };
    const reply = await get(started.port, relayPath("org/../x/lib.jar"), headers);
    expect(reply.status).toBe(400);
    expect(started.upstreamSeen).toEqual([]);
  });

  it("refuses a target that is the server's own origin when the binding names it", async () => {
    const started = await start();
    const own = started.relay.bind({
      runId: "run-e2e",
      ecosystem: "maven",
      upstreamBaseUrl: `http://localhost:${String(started.port)}/`,
      secrets: [],
      ownOrigin: `http://${UI_HOST}:${String(started.port)}`,
    });
    expect(own).toBeUndefined();
  });

  it("logs the route template and never the repository path or a credential", async () => {
    const started = await start();
    const done = started.nextRequestLine();
    await get(started.port, relayPath("org/example/secret-artifact/1.0/x.jar"), {
      authorization: basic("any-user", bound?.capability ?? ""),
    });
    await done;
    const text = JSON.stringify(started.requestLines);
    expect(text).toContain("/api/coding-sidecar/repository/:relayId/*path");
    for (const forbidden of ["secret-artifact", bound?.capability ?? "", PASSWORD])
      expect(text).not.toContain(forbidden);
  });
});
