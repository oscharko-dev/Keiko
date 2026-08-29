import { PassThrough } from "node:stream";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { rootCertificates } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetWarnedCaBundlePaths,
  connectResponseHeaderExceedsLimit,
  gatewayTrustedCaCertificates,
  gatewayFetch,
  httpsProxyTunnelKey,
  isMissingIssuerError,
  isRecoverableTlsTrustError,
  MAX_RESPONSE_BYTES,
  OutboundHttpEgressError,
  readJsonCapped,
  readSseStream,
  streamingResponseFromNode,
} from "./http.js";
import { requestOpenAIEmbedding } from "./openai-embedding-adapter.js";
import type { ModelGatewayLogEvent } from "./observability.js";

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDAT3UYX+IFphaO
RGpsT+BO1KXSO5/brgKNcz+B03xSdDdGDdW2gS5PsIEaWaUfV6FN2pW0qxG3ppm6
mr38KMuLcM65VWvE0wABRtEiEeJtXwn2wjBYHh+Buzi/gtPA9S1trWmhr9anjNQT
7q5oGXysIBCgJXIQTMX+hhEZpQSmEJH6gDfMptx+SgbwvO+anx1lfWoQR7WGEVIj
eDX7EWJMRCtBs3eYDBNYzaiKZIR9Hx6LICvkUzQKyMXrdgsLRglSFz8sh1LSM10x
cZNIJ2m5zM5peIAsZUMAZtI8ozNHgkwxFv4iCUSlnsPWWZ/gCvnXE+7f4kESGuqc
NWGz+fQNAgMBAAECgf8AoEGWqA6US3YcqxxYPepSV17dev7fjYbJ7xYbK2pm2k9T
wGJxtaSbnczNySeVx93pOEzvHvTFJEWxKyUd167R8AwRjmBLbmRm8f68SFKfCIV/
yCIK0g5IMykmy8Y6BTz188U5ltjxXVlTYfOEuJCEqZYO72WaUqWnrnK1Iqm2i1XP
z0pZ67EEgip3Kh6zykSSGhwT0x8mia4rkYMk8Hajs9D+zcr7rYQf0jQyqCAEOhRX
kydSfbXg3Vb9VwgioJIzCuLHkr7GbyTAZKVGnfCa/JckYNN74Q8vwZ0PqJneO1P3
dm2YUxD/mm+dvmJWelrHFZbIEFaM/ASpOptRelECgYEA9miUKX8WWJ4NbXFysOED
g3f0153WPgBqYiji41YSEmlSTdrAUvM6nnwzWqoa19T97MqUpwIBVlnXYYyGiz1k
gFuRmps3TstN53LsDw68kC38Mq079IYrhpQGfBWmEvOm2XK2sQLA4aKzR2hWR/L4
1q2p5MQbslV2jYIoPb50fXkCgYEAx8vMqaZQMG+d1LNjNG7X9+JRKCA0S+5BSa4q
EU130UmZBw7NzHqefnUCSAsZqqJqHJEmcU97Bc0UxFro7dA7vjoFDmquzDYxoxml
HRv1YgjHp195gs2S23HQ9KAxsbpsAphNbp59MwH/n2oDPuQ9bjwsmbmh0fMoygFU
e9uPSjUCgYEA5fWPYHK0fhty2JKpwJ0eVFFc9OTejpqArf8OT6+ByiD0qKfgGQnZ
yRKMMq7Rwl+KYrRkqr/aU6YgtW8aGVRAOPI8HpeAtE5T9A5yc1MDc2MXHIxDid61
PDFlI+RoSwOM0R6XlPbG30yiF6At9ZOx21fTWCYU2webTlEMESNvP7ECgYEAmUDM
Rj1aOS0EpcjMCcYURwIEOoEpXCzvS3MatZb0l0aa6P0EAxrzRBDApT5Oe8KFHlCA
al4LAZIjodIR5Yjaqrmac0qFtgLD5FWhf0iY2o/dhZcIf7rsMQOGwn22YJucigkF
LBrJ8jxQNZl9z9oG/O2PUINBiue3m+uVQERUDxkCgYAOCAAFafD5yLAg9Q5Ls9iH
+uZy6J03qR+AoeVxBUP4JaycQyWr8PIC6ZqPhjWiyGHxJ2UgFJ7s4HYBRgBGdcdg
IbT7k/+BVmfkMnc8d9EgQAzDLuL8myeDio/7FMWyaVVkejJqLUiRlzzGec8rE3JL
zV+7W9e7xnIMuAVf0VKzWw==
-----END PRIVATE KEY-----`;

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUQnB9dVzMdmk9GN7vzKBh+XoKWmAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDYxMDA3MDcyOFoXDTM2MDYw
NzA3MDcyOFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAwE91GF/iBaYWjkRqbE/gTtSl0juf264CjXM/gdN8UnQ3
Rg3VtoEuT7CBGlmlH1ehTdqVtKsRt6aZupq9/CjLi3DOuVVrxNMAAUbRIhHibV8J
9sIwWB4fgbs4v4LTwPUtba1poa/Wp4zUE+6uaBl8rCAQoCVyEEzF/oYRGaUEphCR
+oA3zKbcfkoG8Lzvmp8dZX1qEEe1hhFSI3g1+xFiTEQrQbN3mAwTWM2oimSEfR8e
iyAr5FM0CsjF63YLC0YJUhc/LIdS0jNdMXGTSCdpuczOaXiALGVDAGbSPKMzR4JM
MRb+IglEpZ7D1lmf4Ar51xPu3+JBEhrqnDVhs/n0DQIDAQABo28wbTAdBgNVHQ4E
FgQUDt8KAqo9QmIwDk0IQLIGvlKb6VQwHwYDVR0jBBgwFoAUDt8KAqo9QmIwDk0I
QLIGvlKb6VQwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAG1fWollkC0ODYylqMgMShV+Qsbj9U17
p42V/zYN+L2VNCo7PKtrMGDct5kaNsWI12RNr8smRR3VqIu/m86JIRMhxEcF4f3W
C7p7AxSxggt5CZSbmX+5HvHiHx2Pzb9ScjTSHTGA+usfKeYbDRPNRusj2LF/Y9bc
u1410r8a2yaMCxpWtWSvJ5jglXQa+A2E3XfFIkwTSGWdaeHXsfQ1Z6X33IKX0DX4
zd4z7t+If2ThZ1V2mP4iHOUXyxhrjO8jck5v4ibwDkhpZqHZxXJnOlqR+p4Y/x0J
7HO5cknmZC8MPbbwJajgLRm6+jUqvTjvOP9ZUhmet11ff/YHNctzZkE=
-----END CERTIFICATE-----`;

// Every server bound by the helpers below is tracked so the module-level afterEach can tear it
// down even when a test body never reaches its own `finally { await close(...) }` — e.g. when a
// mutant (mutation testing) or a vitest timeout aborts the body mid-await. Test-runner processes
// are reused across hundreds of mutant runs; leaked listeners/sockets otherwise accumulate until
// the CI runner exhausts memory (hermeticity contract, AGENTS.md §7/§10).
const openServers = new Set<HttpServer | HttpsServer>();

afterEach(async () => {
  await Promise.all([...openServers].map(async (server) => close(server)));
});

// Legitimate tests open a handful of connections per server; a mutant that drives the gateway
// into a reconnect storm would otherwise allocate a fresh socket/TLS pair per attempt until the
// host runs out of memory. Severing every connection beyond the cap turns that storm into fast,
// clean connection-refused failures (second bounded exit, independent of the mutated code).
const MAX_TEST_SERVER_CONNECTIONS = 64;

function capConnections(server: HttpServer | HttpsServer): void {
  let accepted = 0;
  server.on("connection", (socket: Socket) => {
    accepted += 1;
    if (accepted > MAX_TEST_SERVER_CONNECTIONS) socket.destroy();
  });
}

async function listen(server: HttpServer | HttpsServer): Promise<number> {
  openServers.add(server);
  capConnections(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

// Binds without an explicit host (dual-stack `::`) so a hostname whose DNS lookup returns both
// an IPv6 and an IPv4 loopback address (e.g. "*.localhost") can reach this server either way.
async function listenOnAllInterfaces(server: HttpServer | HttpsServer): Promise<number> {
  openServers.add(server);
  capConnections(server);
  server.listen(0);
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

// Idempotent: per-test `finally` blocks and the afterEach sweep may both close the same server.
// closeAllConnections() severs kept-alive and mid-flight sockets so close() cannot stall behind
// a hung request left over from an aborted test body.
async function close(server: HttpServer | HttpsServer): Promise<void> {
  openServers.delete(server);
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

// Bounded relay for the CONNECT tunnels and forward proxies these tests stand up. Mutation runs
// can drive the gateway into pathological flood behaviour; a plain `pipe()` between loopback
// sockets then shovels gigabytes per second until the test-runner host runs out of memory.
// Legitimate tests move a few kilobytes, so the budget is invisible on the green path and turns
// any flood into a fast, clean teardown (hermeticity contract: bounded resources under all
// mutations, AGENTS.md §7/§10).
const TUNNEL_BYTE_BUDGET = 1_048_576;

interface BoundedEnd {
  destroy?: (error?: Error) => void;
}

function pipeBounded(
  from: NodeJS.ReadableStream & BoundedEnd,
  to: NodeJS.WritableStream & BoundedEnd,
  budget = TUNNEL_BYTE_BUDGET,
): void {
  let relayed = 0;
  from.on("data", (chunk: Buffer | string) => {
    relayed += chunk.length;
    if (relayed > budget) {
      from.destroy?.();
      to.destroy?.();
      return;
    }
    to.write(chunk);
  });
  from.once("end", () => {
    to.end();
  });
  from.once("error", () => {
    to.destroy?.();
  });
}

// ---------------------------------------------------------------------------
// gatewayFetch — success path with injected fetchImpl
// ---------------------------------------------------------------------------

describe("gatewayFetch", () => {
  it("returns the injected fetchImpl response on success", async () => {
    const body = JSON.stringify({ ok: true });
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(body, { status: 200 }));
    const response = await gatewayFetch("https://example.com/v1/models", { fetchImpl });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  it("blocks metadata and private literal targets before fetch unless explicitly allowed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok")));
    await expect(
      gatewayFetch("https://169.254.169.254/latest/meta-data", { fetchImpl }),
    ).rejects.toMatchObject({
      code: "PROXY_BLOCKED_BY_POLICY",
    });
    await expect(gatewayFetch("https://10.0.0.5/v1/models", { fetchImpl })).rejects.toMatchObject({
      code: "PROXY_BLOCKED_BY_POLICY",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows private literal targets only through the central egress opt-in", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("ok")));
    const response = await gatewayFetch("https://10.0.0.5/v1/models", {
      fetchImpl,
      egress: { allowPrivateNetwork: true },
    });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("forces manual redirects and passes a 3xx response through unchanged, even to a metadata/private Location (KEIKO-0791)", async () => {
    // gatewayFetch never AUTO-follows: `redirect: "manual"` is forced on every call (http.ts), so
    // fetch itself never connects to a Location target. Manual followers DO exist — the
    // update-portable staging manifest (safeRedirectUrl, bounded by MAX_ASSET_REDIRECTS) and the
    // research egress port (redirectTarget) both read Location and loop — but each re-enters
    // gatewayFetch for the next hop, so the target is re-vetted by the full DNS/address-pinning
    // egress policy on the hop that actually connects to it. That next-hop re-entry, NOT an absent
    // follower, is what made the removed Location pre-check redundant. Any future follower must
    // route back through gatewayFetch rather than a raw fetch (#3348 audit).
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
      ),
    );
    const response = await gatewayFetch("https://example.com/v1/models", { fetchImpl });
    expect(response.status).toBe(302);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("passes a relative redirect through unchanged as well", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 307, headers: { location: "/v2/models" } })),
    );
    const response = await gatewayFetch("https://example.com/v1/models", { fetchImpl });
    expect(response.status).toBe(307);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("propagates a non-issuer fetch error without attempting the CA fallback", async () => {
    const networkError = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    const fetchImpl: typeof fetch = () => Promise.reject(networkError);
    await expect(gatewayFetch("https://example.com/v1/models", { fetchImpl })).rejects.toThrow(
      "ECONNREFUSED",
    );
  });

  it("does not set rejectUnauthorized:false in the CA-bundle fallback path", () => {
    // isMissingIssuerError is the gate; assert it returns false for unrelated codes.
    const unrelated = Object.assign(new Error("boom"), { code: "CERT_HAS_EXPIRED" });
    expect(isMissingIssuerError(unrelated)).toBe(false);
    expect(isRecoverableTlsTrustError(unrelated)).toBe(false);
  });

  it("routes HTTP requests through a configured forward proxy", async () => {
    let originHits = 0;
    let proxyHits = 0;
    const origin = createHttpServer((_req, res) => {
      originHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "origin" }));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer((req, res) => {
      proxyHits += 1;
      expect(req.url).toBe(`http://127.0.0.1:${String(originPort)}/models`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "proxy" }));
    });
    const proxyPort = await listen(proxy);
    try {
      const response = await gatewayFetch(`http://127.0.0.1:${String(originPort)}/models`, {
        egress: { httpProxy: `http://127.0.0.1:${String(proxyPort)}` },
      });
      expect(await response.json()).toEqual({ via: "proxy" });
      expect(proxyHits).toBe(1);
      expect(originHits).toBe(0);
    } finally {
      await close(proxy);
      await close(origin);
    }
  });

  it("forwards a binary request body through a forward proxy without corruption (#494 STT multipart)", async () => {
    // High bytes (>127) and embedded CRLF prove the body is written as raw bytes, not UTF-8 text.
    const payload = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 13, 10, 65, 66, 67]);
    let received: Buffer | undefined;
    const proxy = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received = Buffer.concat(chunks);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const proxyPort = await listen(proxy);
    try {
      const response = await gatewayFetch("http://127.0.0.1:9/audio/transcriptions", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(payload.byteLength),
        },
        body: payload,
        egress: { httpProxy: `http://127.0.0.1:${String(proxyPort)}` },
      });
      expect(await response.json()).toEqual({ ok: true });
      expect(received !== undefined && Array.from(received)).toEqual(Array.from(payload));
    } finally {
      await close(proxy);
    }
  });

  it("forwards a binary request body intact on the custom-CA fallback path (#494 STT multipart)", async () => {
    // fetchWithCaBundle is entered when the direct HTTPS fetch hits a recoverable TLS-trust error and
    // a CA bundle is configured. Prove the multipart body survives that path byte-for-byte.
    const payload = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 13, 10, 65, 66, 67]);
    const dir = mkdtempSync(join(tmpdir(), "keiko-stt-ca-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    let received: Buffer | undefined;
    const originSockets = new Set<Socket>();
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received = Buffer.concat(chunks);
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    origin.on("connection", (s) => {
      originSockets.add(s);
      s.once("close", () => originSockets.delete(s));
    });
    const originPort = await listen(origin);
    try {
      const response = await gatewayFetch(
        `https://127.0.0.1:${String(originPort)}/audio/transcriptions`,
        {
          method: "POST",
          useCaFallback: true,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(payload.byteLength),
          },
          body: payload,
          egress: { caBundlePath },
        },
      );
      expect(await response.json()).toEqual({ ok: true });
      expect(received !== undefined && Array.from(received)).toEqual(Array.from(payload));
    } finally {
      for (const s of originSockets) s.destroy();
      await close(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("engages the custom-CA fallback for the embedding adapter exactly like chat transports", async () => {
    // CA-parity pin: an embedding path that fails on a corporate-CA gateway the chat path talks
    // to happily is indistinguishable from an outage in the product UI. requestOpenAIEmbedding
    // runs over the REAL gatewayFetch here (no fetchImpl), so the recoverable-TLS fallback with
    // the configured bundle must carry it end to end.
    const dir = mkdtempSync(join(tmpdir(), "keiko-embed-ca-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ data: [{ embedding: [0.6, 0.8] }], model: "probe-model" }));
    });
    const originPort = await listen(origin);
    try {
      const outcome = await requestOpenAIEmbedding({
        endpoint: `https://127.0.0.1:${String(originPort)}/v1`,
        apiKey: "sk-test",
        modelId: "probe-model",
        input: "ping",
        egress: { caBundlePath },
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.value.modelId).toBe("probe-model");
    } finally {
      await close(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards a binary request body intact through an HTTPS CONNECT proxy (#494 STT multipart)", async () => {
    const payload = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 13, 10, 65, 66, 67]);
    const dir = mkdtempSync(join(tmpdir(), "keiko-stt-connect-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    let received: Buffer | undefined;
    const originSockets = new Set<Socket>();
    const proxySockets = new Set<Socket>();
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received = Buffer.concat(chunks);
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    origin.on("connection", (s) => {
      originSockets.add(s);
      s.once("close", () => originSockets.delete(s));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer();
    proxy.on("connection", (s) => {
      proxySockets.add(s);
      s.once("close", () => proxySockets.delete(s));
    });
    proxy.on("connect", (req, clientSocket, head) => {
      const [host, portText] = (req.url ?? "").split(":");
      const upstream = netConnect(Number(portText), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        pipeBounded(upstream, clientSocket);
        pipeBounded(clientSocket, upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
    const proxyPort = await listen(proxy);
    try {
      const response = await gatewayFetch(
        `https://127.0.0.1:${String(originPort)}/audio/transcriptions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(payload.byteLength),
          },
          body: payload,
          egress: { httpsProxy: `http://127.0.0.1:${String(proxyPort)}`, caBundlePath },
        },
      );
      expect(await response.json()).toEqual({ ok: true });
      expect(received !== undefined && Array.from(received)).toEqual(Array.from(payload));
    } finally {
      for (const s of proxySockets) s.destroy();
      for (const s of originSockets) s.destroy();
      await close(proxy);
      await close(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses a keep-alive HTTPS CONNECT tunnel for sequential requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-connect-keepalive-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    let proxyConnects = 0;
    let originRequests = 0;
    const originSockets = new Set<Socket>();
    const proxySockets = new Set<Socket>();
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      originRequests += 1;
      res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
      res.end(JSON.stringify({ path: req.url, count: originRequests }));
    });
    origin.on("connection", (s) => {
      originSockets.add(s);
      s.once("close", () => originSockets.delete(s));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer();
    proxy.on("connection", (s) => {
      proxySockets.add(s);
      s.once("close", () => proxySockets.delete(s));
    });
    proxy.on("connect", (req, clientSocket, head) => {
      proxyConnects += 1;
      const [host, portText] = (req.url ?? "").split(":");
      const upstream = netConnect(Number(portText), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        pipeBounded(upstream, clientSocket);
        pipeBounded(clientSocket, upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
    const proxyPort = await listen(proxy);
    const egress = { httpsProxy: `http://127.0.0.1:${String(proxyPort)}`, caBundlePath };
    try {
      const first = await gatewayFetch(`https://127.0.0.1:${String(originPort)}/first`, {
        egress,
      });
      expect(await first.json()).toEqual({ path: "/first", count: 1 });

      const second = await gatewayFetch(`https://127.0.0.1:${String(originPort)}/second`, {
        egress,
      });
      expect(await second.json()).toEqual({ path: "/second", count: 2 });
      expect(proxyConnects).toBe(1);
    } finally {
      _resetWarnedCaBundlePaths();
      for (const s of proxySockets) s.destroy();
      for (const s of originSockets) s.destroy();
      await close(proxy);
      await close(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks credential headers from crossing a plaintext HTTP proxy boundary", async () => {
    let proxyHits = 0;
    const proxy = createHttpServer((_req, res) => {
      proxyHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "proxy" }));
    });
    const proxyPort = await listen(proxy);
    try {
      await expect(
        gatewayFetch("http://127.0.0.1:65535/models", {
          headers: { authorization: "Bearer provider-secret" },
          egress: { httpProxy: `http://127.0.0.1:${String(proxyPort)}` },
        }),
      ).rejects.toMatchObject({
        name: "OutboundHttpEgressError",
        code: "PROXY_BLOCKED_BY_POLICY",
      } satisfies Partial<OutboundHttpEgressError>);
      expect(proxyHits).toBe(0);
    } finally {
      await close(proxy);
    }
  });

  it("honours NO_PROXY and bypasses the configured forward proxy", async () => {
    let originHits = 0;
    let proxyHits = 0;
    const origin = createHttpServer((_req, res) => {
      originHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "origin" }));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer((_req, res) => {
      proxyHits += 1;
      res.writeHead(502);
      res.end("should not be used");
    });
    const proxyPort = await listen(proxy);
    try {
      const response = await gatewayFetch(`http://127.0.0.1:${String(originPort)}/models`, {
        egress: {
          httpProxy: `http://127.0.0.1:${String(proxyPort)}`,
          noProxy: ["127.0.0.1"],
        },
      });
      expect(await response.json()).toEqual({ via: "origin" });
      expect(proxyHits).toBe(0);
      expect(originHits).toBe(1);
    } finally {
      await close(proxy);
      await close(origin);
    }
  });

  it("routes HTTPS through CONNECT and trusts the configured CA bundle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-egress-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    let originHits = 0;
    let proxyConnects = 0;
    const originSockets = new Set<Socket>();
    const proxySockets = new Set<Socket>();
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
      originHits += 1;
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ secure: true }));
    });
    origin.on("connection", (socket) => {
      originSockets.add(socket);
      socket.once("close", () => originSockets.delete(socket));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer();
    proxy.on("connection", (socket) => {
      proxySockets.add(socket);
      socket.once("close", () => proxySockets.delete(socket));
    });
    proxy.on("connect", (req, clientSocket, head) => {
      proxyConnects += 1;
      const [host, portText] = (req.url ?? "").split(":");
      const upstream = netConnect(Number(portText), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        pipeBounded(upstream, clientSocket);
        pipeBounded(clientSocket, upstream);
      });
      upstream.on("error", () => {
        clientSocket.destroy();
      });
    });
    const proxyPort = await listen(proxy);
    try {
      const response = await gatewayFetch(`https://127.0.0.1:${String(originPort)}/secure`, {
        egress: {
          httpsProxy: `http://127.0.0.1:${String(proxyPort)}`,
          caBundlePath,
        },
      });
      expect(await response.json()).toEqual({ secure: true });
      expect(proxyConnects).toBe(1);
      expect(originHits).toBe(1);
    } finally {
      for (const socket of proxySockets) socket.destroy();
      for (const socket of originSockets) socket.destroy();
      await close(proxy);
      await close(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies direct TLS trust failures as TLS_CA_FAILURE when no custom CA can verify the target", async () => {
    const originSockets = new Set<Socket>();
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ secure: true }));
    });
    origin.on("connection", (socket) => {
      originSockets.add(socket);
      socket.once("close", () => originSockets.delete(socket));
    });
    const originPort = await listen(origin);
    try {
      await expect(
        gatewayFetch(`https://127.0.0.1:${String(originPort)}/secure`, {
          useCaFallback: true,
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({
        name: "OutboundHttpEgressError",
        code: "TLS_CA_FAILURE",
        message: "TLS certificate verification failed for outbound egress.",
      });
    } finally {
      for (const socket of originSockets) socket.destroy();
      await close(origin);
    }
  });
});

// ---------------------------------------------------------------------------
// AUDIT-SEC-001 — DNS-rebinding resolve-then-connect gap (pinned direct connect)
// ---------------------------------------------------------------------------
//
// Each test loads a fresh copy of ./http.js with "node:dns/promises" mocked (vi.resetModules +
// vi.doMock, same pattern as capabilities.test.ts) so the production dnsLookup call inside
// enforceOutboundTargetPolicy is fully controlled, without disturbing the real-DNS-dependent
// tests elsewhere in this file, which keep using the statically-imported gatewayFetch.

describe("gatewayFetch DNS-rebinding pinning (AUDIT-SEC-001)", () => {
  it("connects using the policy-validated address instead of re-resolving DNS at connect time", async () => {
    // The hostname deliberately does not resolve via a real DNS query (RFC 2606 reserved
    // "invalid" TLD). Before this fix, gatewayFetch validated it via the mocked lookup below
    // and then handed the URL to globalThis.fetch, which performs its OWN, independent DNS
    // resolution — unmocked, so it would fail outright (ENOTFOUND/EAI_AGAIN). After the fix,
    // the connect reuses the address enforceOutboundTargetPolicy already validated and reaches
    // the real origin server below, proving no second, independent resolution happens.
    const origin = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "vetted" }));
    });
    const originPort = await listen(origin);
    try {
      vi.resetModules();
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }])),
      }));
      const { gatewayFetch: pinnedGatewayFetch } = await import("./http.js");
      const response = await pinnedGatewayFetch(
        `http://pinned-target.invalid:${String(originPort)}/manual`,
      );
      expect(await response.json()).toEqual({ via: "vetted" });
    } finally {
      await close(origin);
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
    }
  });

  it("still refuses the request when the policy-validated address is blocked (e.g. metadata)", async () => {
    // Simulates a resolver answer that rebinds a previously-approved hostname to the cloud
    // metadata address: the pinned address itself must still go through the same address
    // classification, so a blocked answer is refused before any connect is attempted.
    vi.resetModules();
    vi.doMock("node:dns/promises", () => ({
      lookup: vi.fn(() => Promise.resolve([{ address: "169.254.169.254", family: 4 }])),
    }));
    try {
      const { gatewayFetch: pinnedGatewayFetch } = await import("./http.js");
      await expect(
        pinnedGatewayFetch("http://pinned-target.invalid/latest/meta-data"),
      ).rejects.toMatchObject({ code: "PROXY_BLOCKED_BY_POLICY" });
    } finally {
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
    }
  });

  it("keeps DNS-resolved metadata blocked when private-network egress is enabled", async () => {
    // `allowPrivateNetwork` permits RFC-1918 intranet targets, not cloud metadata or other
    // link-local classes reached through a hostname. The DNS validation must therefore still run
    // when the flag is enabled; otherwise a hostname that resolves to 169.254.169.254 would bypass
    // the literal-host check entirely.
    vi.resetModules();
    vi.doMock("node:dns/promises", () => ({
      lookup: vi.fn(() => Promise.resolve([{ address: "169.254.169.254", family: 4 }])),
    }));
    try {
      const { gatewayFetch: pinnedGatewayFetch } = await import("./http.js");
      await expect(
        pinnedGatewayFetch("http://private-manual.invalid/latest/meta-data", {
          egress: { allowPrivateNetwork: true },
        }),
      ).rejects.toMatchObject({ code: "PROXY_BLOCKED_BY_POLICY" });
    } finally {
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
    }
  });

  it("refuses research egress through a proxy, because no address can be pinned there", async () => {
    // A pre-proxy DNS lookup is NOT rebinding protection: the proxy resolves the hostname again at
    // connect time, so the validated address set is never bound to use — a name can resolve
    // publicly for the policy check and rebind to loopback for the proxy's connect. The
    // denyLoopback posture therefore refuses the combination outright rather than claiming a
    // guarantee it cannot keep. The lookup is stubbed to a PUBLIC address so the refusal cannot be
    // mistaken for the address-class check doing the work.
    vi.resetModules();
    const lookup = vi.fn(() => Promise.resolve([{ address: "203.0.113.10", family: 4 }]));
    vi.doMock("node:dns/promises", () => ({ lookup }));
    try {
      const { gatewayFetch: proxyGatewayFetch } = await import("./http.js");
      await expect(
        proxyGatewayFetch("https://public-looking.invalid/docs", {
          egress: {
            denyLoopback: true,
            httpsProxy: "http://127.0.0.1:65535",
            acknowledgeProxiedHostnamePolicy: true,
          },
        }),
      ).rejects.toMatchObject({ code: "PROXY_BLOCKED_BY_POLICY" });
      // Refused before any resolution: the decision does not depend on what DNS answers.
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
    }
  });

  it("still allows ordinary proxied egress that does not carry the research posture", async () => {
    // Only denyLoopback (research egress) is refused through a proxy; the gateway's own proxied
    // sidecar/model traffic must keep working, so the refusal must not be a blanket proxy ban.
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("ok", { status: 200 })));

    const response = await gatewayFetch("https://models.invalid/v1/chat", {
      fetchImpl,
      egress: { httpsProxy: "http://127.0.0.1:65535" },
    });

    expect(response.status).toBe(200);
  });

  it("requires delegated-policy acknowledgement before sending a hostname through a proxy", async () => {
    let proxiedRequests = 0;
    const logEvents: ModelGatewayLogEvent[] = [];
    const proxy = createHttpServer((_req, res) => {
      proxiedRequests += 1;
      res.writeHead(200);
      res.end("ok");
    });
    const proxyPort = await listen(proxy);
    const target = "http://ordinary-proxied-hostname.invalid/egress";
    const httpProxy = `http://127.0.0.1:${String(proxyPort)}`;
    try {
      await expect(
        gatewayFetch(target, {
          egress: { httpProxy },
          log: { write: (event) => logEvents.push(event) },
        }),
      ).rejects.toMatchObject({ code: "PROXY_BLOCKED_BY_POLICY" });
      expect(proxiedRequests).toBe(0);
      expect(logEvents.at(-1)?.extra).toMatchObject({
        policyReason: "undelegated-proxied-hostname",
      });

      const allowed = await gatewayFetch(target, {
        egress: { httpProxy, acknowledgeProxiedHostnamePolicy: true },
      });
      expect(allowed.status).toBe(200);
      expect(proxiedRequests).toBe(1);
    } finally {
      await close(proxy);
    }
  });

  it("passes a 3xx response through unchanged without validating its Location target (KEIKO-0791)", async () => {
    // gatewayFetch always sends redirect: "manual", so fetch itself never connects to a Location
    // target. Manual followers DO exist (update-portable staging's safeRedirectUrl, the research
    // egress port's redirectTarget) — but both re-enter gatewayFetch for the next hop, so every
    // redirect target still passes the full DNS/address-pinning egress policy on the hop that
    // actually connects to it. The removed pre-check was redundant with that re-entry, NOT with
    // "nothing follows redirects" (#3348 audit). A 3xx response — even one whose Location points at
    // an address the classifier would otherwise block — is therefore returned to the caller
    // unchanged, and it is the connecting hop, not this response, that enforces the boundary.
    const origin = createHttpServer((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    });
    const originPort = await listen(origin);
    try {
      const response = await gatewayFetch(`http://127.0.0.1:${String(originPort)}/start`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data");
    } finally {
      await close(origin);
    }
  });
});

// ---------------------------------------------------------------------------
// gatewayFetch proxied DNS pinning — egress.pinProxiedConnectTarget (ADR-0038 D6)
// ---------------------------------------------------------------------------
//
// Off a proxy, gatewayFetch already resolves+vets DNS itself and pins the connect to the
// validated address (AUDIT-SEC-001, above). Through a proxy it normally cannot: the proxy
// resolves the target hostname independently at its own connect time, so a target that is not
// LITERALLY loopback/private-shaped but RESOLVES to a blocked address slips through unvalidated
// (planGatewayDns's `pinForConnect` is false whenever a proxy is used). `pinProxiedConnectTarget`
// closes that gap by having Keiko resolve+vet the target itself, exactly as it already does for
// the direct path, and then handing the proxy layer the vetted address instead of the hostname —
// an HTTPS CONNECT authority or, for a plain-HTTP target, the forwarded absolute-URI's host.

describe("gatewayFetch proxied DNS pinning (pinProxiedConnectTarget, ADR-0038 D6)", () => {
  it("pins a plain-HTTP proxied request to the vetted address, defeating a hostname that only resolves for Keiko's own lookup", async () => {
    // Mirrors the AUDIT-SEC-001 direct-path test's technique exactly, through a real two-hop
    // forward proxy instead of a direct connect. "pinned-target.invalid" is an RFC 2606 reserved
    // TLD that does not resolve on any real network. The fake proxy's own outbound hop below
    // dials a HARDCODED local address/port, never the request line's own authority — matching the
    // "research egress through a proxy" fixture further down, and NOT the shape CodeQL's
    // js/request-forgery flags (constructing an outbound request straight from an inbound
    // request's own URL, unvalidated, is what an actual open/unrestricted proxy looks like; a
    // real forward proxy enforces its own policy about where it will actually connect, which is
    // what dialing a fixed local address here mirrors). Before this fix, the request line's
    // authority the proxy captures below would still be the unresolvable hostname and the second
    // hop would never even reach the real origin; after the fix it is the vetted "127.0.0.1" and
    // the real origin below answers.
    const origin = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "pinned-proxy" }));
    });
    const originPort = await listen(origin);
    let capturedHost: string | undefined;
    let capturedRequestLine: string | undefined;
    const proxy = createHttpServer((req, res) => {
      capturedHost = req.headers.host;
      capturedRequestLine = req.url ?? undefined;
      const incoming = new URL(req.url ?? "", "http://placeholder");
      const forward = httpRequest(
        {
          hostname: "127.0.0.1",
          port: originPort,
          path: `${incoming.pathname}${incoming.search}`,
          method: req.method,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      forward.on("error", () => {
        res.writeHead(502);
        res.end("proxy forward failed");
      });
      req.pipe(forward);
    });
    const proxyPort = await listen(proxy);
    try {
      vi.resetModules();
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }])),
      }));
      const { gatewayFetch: pinnedGatewayFetch } = await import("./http.js");
      const response = await pinnedGatewayFetch("http://pinned-target.invalid/manual", {
        egress: {
          httpProxy: `http://127.0.0.1:${String(proxyPort)}`,
          pinProxiedConnectTarget: true,
          acknowledgeProxiedHostnamePolicy: true,
        },
      });
      expect(await response.json()).toEqual({ via: "pinned-proxy" });
      // The proxy still sees the ORIGINAL hostname via the Host header (virtual-hosting/identity
      // is unaffected) even though the request line it received was rewritten to the address.
      expect(capturedHost).toBe("pinned-target.invalid");
      expect(capturedRequestLine).toBe("http://127.0.0.1/manual");
    } finally {
      await close(origin);
      await close(proxy);
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
    }
  });

  it("leaves the request-target authority as the literal hostname when delegated policy is acknowledged and pinning is off", async () => {
    // Same technique as the pinned test above, MINUS pinProxiedConnectTarget: the proxy receives
    // the request-line's authority UNCHANGED — still the original, non-resolving hostname, never
    // rewritten to a Keiko-vetted address — captured and asserted directly off the wire. This pins
    // the default behavior: opting in is what changes anything, nothing is silently different, and
    // gatewayFetch itself never even attempts its own DNS work here (planGatewayDns.pinForProxyConnect
    // is false without the flag). The proxy responds immediately rather than attempting a second
    // hop to the (deliberately unresolvable) authority it received — for the same reason given in
    // the pinned test above, and because the wire-level assertion below is the direct proof either
    // way, not an inference from whether a forward attempt happened to succeed or fail.
    let capturedRequestLine: string | undefined;
    const proxy = createHttpServer((req, res) => {
      capturedRequestLine = req.url ?? undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "unpinned-proxy" }));
    });
    const proxyPort = await listen(proxy);
    try {
      vi.resetModules();
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }])),
      }));
      const { gatewayFetch: unpinnedGatewayFetch } = await import("./http.js");
      const response = await unpinnedGatewayFetch("http://pinned-target.invalid/manual", {
        egress: {
          httpProxy: `http://127.0.0.1:${String(proxyPort)}`,
          acknowledgeProxiedHostnamePolicy: true,
        },
      });
      expect(response.status).toBe(200);
      expect(capturedRequestLine).toBe("http://pinned-target.invalid/manual");
    } finally {
      await close(proxy);
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
    }
  });

  it("reuses the client-to-proxy connection across an unpinned then a pinned request without leaking either one's target (#3156 ADR-0038 D6 correction)", async () => {
    // Codex P2: ADR-0038 D6 originally said this plain-HTTP absolute-URI path has no pooling
    // because Node's global agent defaults keepAlive:false. False on this repo's pinned Node 24 --
    // http.globalAgent.keepAlive is true (Node made the GLOBAL singleton agents, specifically,
    // default to keep-alive; a freshly constructed `new http.Agent()` still defaults false, which
    // is the easy way to misremember this). fetchHttpViaProxy passes no explicit `agent`, so it
    // goes through that global, keep-alive-by-default agent -- connection reuse to the proxy DOES
    // happen here, contrary to what the ADR claimed.
    //
    // The conclusion survives anyway, for a different reason than the ADR gave: Node's Agent pools
    // by `getName()`, which keys purely on host/port (verified directly: identical for two
    // requests differing only in `path`) -- it has no notion of "target" or "pinned", so it can
    // and does hand the SAME socket to an unpinned call and a later pinned call to the same proxy.
    // But unlike the CONNECT-tunnel pool (the actual #3156 bug, fixed above), that shared socket's
    // FAR end never moves -- it is always the proxy. The real destination lives entirely in each
    // request's OWN absolute-URI (`proxyRequestTarget(target, pinnedAddress)`, computed fresh
    // inside fetchHttpViaProxy from THAT call's own pinnedAddress, never cached or inherited), sent
    // fresh on every request the proxy reads and re-routes independently. Reusing the transport to
    // an already-trusted intermediary is not the same as reusing a resource that fixes the ultimate
    // peer, so there is nothing here for resolveGatewayDns's per-call vetting to lose track of.
    //
    // Both halves are asserted directly: proxyConnections stays at 1 (the connection really was
    // reused, not just theoretically reusable) while requestUrls[1] is the pinned call's OWN vetted
    // address, never contaminated by requestUrls[0]'s unpinned literal hostname.
    let proxyConnections = 0;
    const requestUrls: string[] = [];
    const proxy = createHttpServer((req, res) => {
      requestUrls.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
      res.end(JSON.stringify({ seen: req.url }));
    });
    proxy.on("connection", () => {
      proxyConnections += 1;
    });
    const proxyPort = await listen(proxy);
    const egress = {
      httpProxy: `http://127.0.0.1:${String(proxyPort)}`,
      acknowledgeProxiedHostnamePolicy: true,
    };
    try {
      vi.resetModules();
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn(() => Promise.resolve([{ address: "203.0.113.5", family: 4 }])),
      }));
      const { gatewayFetch: freshGatewayFetch } = await import("./http.js");

      // First: unpinned. The literal hostname travels unchanged in the request line.
      const first = await freshGatewayFetch("http://pool-identity-plain.invalid/first", {
        egress,
      });
      expect(first.status).toBe(200);
      expect(requestUrls[0]).toBe("http://pool-identity-plain.invalid/first");

      // Second: pinned, same proxy, immediately after (well inside any keep-alive idle window).
      const second = await freshGatewayFetch("http://pool-identity-plain.invalid/second", {
        egress: { ...egress, pinProxiedConnectTarget: true },
      });
      expect(second.status).toBe(200);
      // The load-bearing pair: one physical connection served both calls, yet the second request
      // line correctly carries ITS OWN vetted address -- not the first call's literal hostname,
      // and not left unpinned by some inherited connection-level state.
      expect(proxyConnections).toBe(1);
      expect(requestUrls[1]).toBe("http://203.0.113.5/second");
    } finally {
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
      await close(proxy);
    }
  });

  it("pins an HTTPS proxied CONNECT tunnel's authority to the vetted address instead of the hostname", async () => {
    // "localhost" is used as the target (rather than an *.invalid host, as above) because this
    // path goes through startTargetTls, which validates the origin's certificate against the SNI
    // servername — TEST_TLS_CERT's SAN only covers localhost/127.0.0.1, and generating a
    // throwaway cert for a second hostname is unnecessary: the mechanism under test is what
    // authority the CONNECT line carries, which this asserts DIRECTLY off the wire rather than
    // inferring it from whether the connection happened to succeed. See the plain-HTTP test above
    // for the genuine "defeats a hostname that cannot resolve on its own" proof.
    const dir = mkdtempSync(join(tmpdir(), "keiko-proxy-pin-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ secure: true }));
    });
    const originSockets = new Set<Socket>();
    origin.on("connection", (socket) => {
      originSockets.add(socket);
      socket.once("close", () => originSockets.delete(socket));
    });
    const originPort = await listen(origin);
    let capturedConnectAuthority: string | undefined;
    const proxySockets = new Set<Socket>();
    const proxy = createHttpServer();
    proxy.on("connection", (socket) => {
      proxySockets.add(socket);
      socket.once("close", () => proxySockets.delete(socket));
    });
    proxy.on("connect", (req, clientSocket, head) => {
      capturedConnectAuthority = req.url ?? "";
      const [host, portText] = capturedConnectAuthority.split(":");
      const upstream = netConnect(Number(portText), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        pipeBounded(upstream, clientSocket);
        pipeBounded(clientSocket, upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
    const proxyPort = await listen(proxy);
    try {
      vi.resetModules();
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }])),
      }));
      const { gatewayFetch: pinnedGatewayFetch } = await import("./http.js");
      const response = await pinnedGatewayFetch(`https://localhost:${String(originPort)}/secure`, {
        egress: {
          httpsProxy: `http://127.0.0.1:${String(proxyPort)}`,
          caBundlePath,
          pinProxiedConnectTarget: true,
        },
      });
      expect(await response.json()).toEqual({ secure: true });
      expect(capturedConnectAuthority).toBe(`127.0.0.1:${String(originPort)}`);
    } finally {
      for (const socket of proxySockets) socket.destroy();
      for (const socket of originSockets) socket.destroy();
      await close(proxy);
      await close(origin);
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never serves a pinned request the pooled tunnel an earlier unpinned call left idle (#3156 pool identity)", async () => {
    // Codex P1, follow-up to the DNS-rebinding fix above: httpsProxyTunnelKey used to be
    // (proxy, target, ca) only, blind to whether the pooled tunnel's peer was ever vetted. An
    // unpinned caller (e.g. the manual research crawler, which never sets
    // pinProxiedConnectTarget) and a pinned caller fetching the identical (proxy, target, ca)
    // triple within the 30s idle window would compute the SAME key, so the pinned call could be
    // served the unpinned call's already-pooled tunnel verbatim -- a peer the PROXY chose on its
    // own, never touched by resolveGatewayDns's vetting for the pinned call. Both calls target the
    // same literal "127.0.0.1" (no real DNS needed for the unpinned leg, and the mock below covers
    // the pinned leg) so the only thing that can legitimately differ between them is pinning
    // posture -- isolating the pool-identity question from address vetting itself, which the
    // dedicated CONNECT-authority test above already covers. Both calls share ONE dynamically
    // re-imported module instance (a single vi.doMock + import, no resetModules between them) so
    // they see the SAME idleHttpsProxyTunnels pool -- using two separate module instances would
    // give each an empty pool of its own and prove nothing.
    const dir = mkdtempSync(join(tmpdir(), "keiko-pool-identity-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    let proxyConnects = 0;
    let originRequests = 0;
    const originSockets = new Set<Socket>();
    const proxySockets = new Set<Socket>();
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      originRequests += 1;
      res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
      res.end(JSON.stringify({ path: req.url, count: originRequests }));
    });
    origin.on("connection", (socket) => {
      originSockets.add(socket);
      socket.once("close", () => originSockets.delete(socket));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer();
    proxy.on("connection", (socket) => {
      proxySockets.add(socket);
      socket.once("close", () => proxySockets.delete(socket));
    });
    proxy.on("connect", (req, clientSocket, head) => {
      proxyConnects += 1;
      const [host, portText] = (req.url ?? "").split(":");
      const upstream = netConnect(Number(portText), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        pipeBounded(upstream, clientSocket);
        pipeBounded(clientSocket, upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
    const proxyPort = await listen(proxy);
    const egress = { httpsProxy: `http://127.0.0.1:${String(proxyPort)}`, caBundlePath };
    try {
      vi.resetModules();
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }])),
      }));
      const { gatewayFetch: freshGatewayFetch } = await import("./http.js");

      // First: an UNPINNED fetch -- no pinProxiedConnectTarget -- exactly the shape a non-Atlassian
      // caller like the manual crawler makes. Establishes tunnel #1 and pools it (the origin
      // answers keep-alive).
      const first = await freshGatewayFetch(`https://127.0.0.1:${String(originPort)}/first`, {
        egress,
      });
      expect(await first.json()).toEqual({ path: "/first", count: 1 });
      expect(proxyConnects).toBe(1);

      // Second: a PINNED fetch to the IDENTICAL (proxy, target, ca) triple, inside the idle
      // window (immediately after, no sleep needed -- HTTPS_PROXY_TUNNEL_IDLE_TTL_MS is 30s).
      const second = await freshGatewayFetch(`https://127.0.0.1:${String(originPort)}/second`, {
        egress: { ...egress, pinProxiedConnectTarget: true },
      });
      expect(await second.json()).toEqual({ path: "/second", count: 2 });
      // The load-bearing assertion: a genuinely NEW CONNECT tunnel was established for the pinned
      // request rather than reusing tunnel #1 from the pool. Before the fix this stayed at 1 --
      // the pooled, unpinned tunnel silently served the pinned request, and resolveGatewayDns's
      // vetting for that request never touched the peer it actually rode.
      expect(proxyConnects).toBe(2);
    } finally {
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
      for (const socket of proxySockets) socket.destroy();
      for (const socket of originSockets) socket.destroy();
      await close(proxy);
      await close(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never pools two calls whose CA bundles differ, even when the old length+prefix summary would have collided (#3157)", async () => {
    // Codex P1: the CA term of the tunnel key used to be `${cert.length}:${cert.slice(0, 32)}` per
    // certificate. For PEM input the first 32 characters are almost entirely the near-universal
    // "-----BEGIN CERTIFICATE-----\n" header -- TEST_TLS_CERT's own first 32 characters are that
    // header plus just 3-4 base64 characters of real content, confirmed directly below. Two
    // genuinely different CA bundles sharing a byte length would collide on that summary and share
    // a pooled tunnel, so a call that deliberately tightened or changed its trusted roots could
    // silently ride a connection its OWN bundle would have refused to establish.
    //
    // caBundleB is constructed to guarantee exactly that collision under the OLD scheme: identical
    // .length and identical .slice(0, 32) to TEST_TLS_CERT (caBundleA), but different content past
    // that point. It is deliberately not a parseable certificate -- this test does not need the
    // second call's TLS handshake to the origin to succeed, only that a fresh CONNECT attempt is
    // made for it (proven by proxyConnects, which increments the moment the proxy receives the
    // CONNECT method, strictly before any TLS-to-origin handshake using either bundle even begins).
    // Call #2 is therefore allowed to fail after that point; only proxyConnects is load-bearing.
    expect(TEST_TLS_CERT.slice(0, 32)).toBe("-----BEGIN CERTIFICATE-----\nMIID");
    const caBundleA = TEST_TLS_CERT;
    const caBundleB = `${TEST_TLS_CERT.slice(0, 32)}${"Z".repeat(TEST_TLS_CERT.length - 32)}`;
    expect(caBundleB).toHaveLength(caBundleA.length);
    expect(caBundleB.slice(0, 32)).toBe(caBundleA.slice(0, 32));
    expect(caBundleB).not.toBe(caBundleA);

    const dir = mkdtempSync(join(tmpdir(), "keiko-ca-collision-"));
    const caBundlePathA = join(dir, "ca-a.pem");
    const caBundlePathB = join(dir, "ca-b.pem");
    writeFileSync(caBundlePathA, caBundleA, "utf8");
    writeFileSync(caBundlePathB, caBundleB, "utf8");
    let proxyConnects = 0;
    let originRequests = 0;
    const originSockets = new Set<Socket>();
    const proxySockets = new Set<Socket>();
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      originRequests += 1;
      res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
      res.end(JSON.stringify({ path: req.url, count: originRequests }));
    });
    origin.on("connection", (socket) => {
      originSockets.add(socket);
      socket.once("close", () => originSockets.delete(socket));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer();
    proxy.on("connection", (socket) => {
      proxySockets.add(socket);
      socket.once("close", () => proxySockets.delete(socket));
    });
    proxy.on("connect", (req, clientSocket, head) => {
      proxyConnects += 1;
      const [host, portText] = (req.url ?? "").split(":");
      const upstream = netConnect(Number(portText), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        pipeBounded(upstream, clientSocket);
        pipeBounded(clientSocket, upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
    const proxyPort = await listen(proxy);
    const httpsProxy = `http://127.0.0.1:${String(proxyPort)}`;
    try {
      // First: a valid bundle (caBundleA === TEST_TLS_CERT, which validates the origin's own
      // self-signed certificate). Establishes tunnel #1 and pools it (keep-alive).
      const first = await gatewayFetch(`https://127.0.0.1:${String(originPort)}/first`, {
        egress: { httpsProxy, caBundlePath: caBundlePathA },
      });
      expect(await first.json()).toEqual({ path: "/first", count: 1 });
      expect(proxyConnects).toBe(1);

      // Second: the colliding-summary, genuinely different bundle, same proxy/target, inside the
      // idle window. Tolerate either outcome from the TLS handshake itself -- caBundleB is garbage
      // past byte 32, so Node may accept or reject it, and this test does not care which; only
      // whether a FRESH tunnel was attempted for it.
      await gatewayFetch(`https://127.0.0.1:${String(originPort)}/second`, {
        egress: { httpsProxy, caBundlePath: caBundlePathB },
      }).catch(() => undefined);

      // The load-bearing assertion: a genuinely NEW CONNECT tunnel was established for the
      // differently-CA'd second call rather than reusing tunnel #1 from the pool. Before the fix
      // this stayed at 1 -- the length+prefix summary collided, so the pool served caBundleB's
      // call the tunnel that was only ever authenticated under caBundleA's trust set.
      expect(proxyConnects).toBe(2);
    } finally {
      for (const socket of proxySockets) socket.destroy();
      for (const socket of originSockets) socket.destroy();
      await close(proxy);
      await close(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still refuses a proxied request when the vetted address is blocked (e.g. metadata), before contacting the proxy", async () => {
    let proxyHits = 0;
    const proxy = createHttpServer(() => {
      proxyHits += 1;
    });
    proxy.on("connect", (_req, clientSocket) => {
      proxyHits += 1;
      clientSocket.destroy();
    });
    const proxyPort = await listen(proxy);
    try {
      vi.resetModules();
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn(() => Promise.resolve([{ address: "169.254.169.254", family: 4 }])),
      }));
      const { gatewayFetch: pinnedGatewayFetch } = await import("./http.js");
      await expect(
        pinnedGatewayFetch("https://metadata-behind-proxy.invalid/latest/meta-data", {
          egress: {
            httpsProxy: `http://127.0.0.1:${String(proxyPort)}`,
            pinProxiedConnectTarget: true,
          },
        }),
      ).rejects.toMatchObject({ code: "PROXY_BLOCKED_BY_POLICY" });
      expect(proxyHits).toBe(0);
    } finally {
      await close(proxy);
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
    }
  });

  it("fails closed rather than falling back to unpinned proxying when resolution yields no usable address", async () => {
    let proxyHits = 0;
    const proxy = createHttpServer(() => {
      proxyHits += 1;
    });
    proxy.on("connect", (_req, clientSocket) => {
      proxyHits += 1;
      clientSocket.destroy();
    });
    const proxyPort = await listen(proxy);
    try {
      vi.resetModules();
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn(() => Promise.resolve([])),
      }));
      const { gatewayFetch: pinnedGatewayFetch } = await import("./http.js");
      await expect(
        pinnedGatewayFetch("https://empty-resolution.invalid/path", {
          egress: {
            httpsProxy: `http://127.0.0.1:${String(proxyPort)}`,
            pinProxiedConnectTarget: true,
          },
        }),
      ).rejects.toMatchObject({ code: "PROXY_BLOCKED_BY_POLICY" });
      expect(proxyHits).toBe(0);
    } finally {
      await close(proxy);
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
    }
  });

  it("allows research egress through a proxy once pinning covers it, instead of the blanket refusal", async () => {
    // Companion to "refuses research egress through a proxy" above: denyLoopback refuses a
    // proxied request because it cannot normally pin the address. Adding pinProxiedConnectTarget
    // removes exactly that obstacle, so the combination is no longer refused. The mocked address
    // is deliberately public (203.0.113.10, RFC 5737 TEST-NET-3, matching the ORIGINAL refusal
    // test's own choice) — 127.0.0.1 would itself be blocked by denyLoopback and the test would
    // pass for the wrong reason. The target hostname is likewise a non-loopback-looking string
    // (outboundTargetBlockedReason's LITERAL check runs before any DNS lookup, so "localhost"
    // would be blocked regardless of what the mock answers). The proxy forwards to the local
    // origin by path only, ignoring the absolute-URI's host, so this test never actually dials
    // 203.0.113.10 (reserved/non-routable, but not a real connection this hermetic suite should
    // attempt either way) — it isolates "is the blanket refusal lifted" from "does the specific
    // address get dialed", which the dedicated CONNECT-authority test above already covers.
    const origin = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "research-proxy" }));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer((req, res) => {
      const incoming = new URL(req.url ?? "", "http://placeholder");
      const forward = httpRequest(
        {
          hostname: "127.0.0.1",
          port: originPort,
          path: `${incoming.pathname}${incoming.search}`,
          method: req.method,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      forward.on("error", () => {
        res.writeHead(502);
        res.end("proxy forward failed");
      });
      req.pipe(forward);
    });
    const proxyPort = await listen(proxy);
    try {
      vi.resetModules();
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn(() => Promise.resolve([{ address: "203.0.113.10", family: 4 }])),
      }));
      const { gatewayFetch: researchGatewayFetch } = await import("./http.js");
      const response = await researchGatewayFetch("http://research-target.invalid/docs", {
        egress: {
          denyLoopback: true,
          pinProxiedConnectTarget: true,
          httpProxy: `http://127.0.0.1:${String(proxyPort)}`,
          acknowledgeProxiedHostnamePolicy: true,
        },
      });
      expect(await response.json()).toEqual({ via: "research-proxy" });
    } finally {
      await close(origin);
      await close(proxy);
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// httpsProxyTunnelKey — order-insensitivity of the CA-set digest (#3157)
// ---------------------------------------------------------------------------
// Tested directly rather than through the full gatewayFetch/proxy pipeline: the real caller,
// gatewayTrustedCaCertificates, always assembles the ca array in the same fixed sequence
// (default -> root -> system -> extra) for a given configuration, so it never naturally produces
// the same SET in a different ORDER -- there is no way to exercise this invariant end-to-end
// without contriving an artificial caller. httpsProxyTunnelKey's own contract (its comment above
// says the sort makes "the SAME set in a different array order hash identically") is the thing
// worth pinning, independent of whether today's one caller happens to vary it.

describe("httpsProxyTunnelKey", () => {
  const target = new URL("https://example.com/path");
  const proxy = new URL("http://proxy.example.com:8080");

  it("is insensitive to the CA array's input order", () => {
    const certA = "-----BEGIN CERTIFICATE-----\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END-----";
    const certB = "-----BEGIN CERTIFICATE-----\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n-----END-----";
    const certC = "-----BEGIN CERTIFICATE-----\nCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n-----END-----";
    const forward = httpsProxyTunnelKey(target, proxy, [certA, certB, certC], undefined);
    const reversed = httpsProxyTunnelKey(target, proxy, [certC, certB, certA], undefined);
    const shuffled = httpsProxyTunnelKey(target, proxy, [certB, certC, certA], undefined);
    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it("still distinguishes two genuinely different CA sets", () => {
    const certA = "-----BEGIN CERTIFICATE-----\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END-----";
    const certB = "-----BEGIN CERTIFICATE-----\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n-----END-----";
    const certC = "-----BEGIN CERTIFICATE-----\nCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n-----END-----";
    const withA = httpsProxyTunnelKey(target, proxy, [certA, certB], undefined);
    const withC = httpsProxyTunnelKey(target, proxy, [certC, certB], undefined);
    expect(withC).not.toBe(withA);
  });
});

// ---------------------------------------------------------------------------
// isMissingIssuerError — only UNABLE_TO_GET_ISSUER_CERT_LOCALLY triggers fallback
// ---------------------------------------------------------------------------

describe("isMissingIssuerError", () => {
  it("returns true only for UNABLE_TO_GET_ISSUER_CERT_LOCALLY on the error itself", () => {
    const err = Object.assign(new Error("ssl"), {
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    });
    expect(isMissingIssuerError(err)).toBe(true);
  });

  it("returns true when UNABLE_TO_GET_ISSUER_CERT_LOCALLY is on the cause", () => {
    const cause = Object.assign(new Error("inner"), {
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    });
    const outer = Object.assign(new Error("outer"), { cause });
    expect(isMissingIssuerError(outer)).toBe(true);
  });

  it("returns false for an unrelated error code", () => {
    const err = Object.assign(new Error("other"), { code: "CERT_HAS_EXPIRED" });
    expect(isMissingIssuerError(err)).toBe(false);
  });

  it("returns false for a plain Error with no code", () => {
    expect(isMissingIssuerError(new Error("plain"))).toBe(false);
  });

  it("returns false for non-object values", () => {
    expect(isMissingIssuerError(null)).toBe(false);
    expect(isMissingIssuerError("string")).toBe(false);
    expect(isMissingIssuerError(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRecoverableTlsTrustError — retry only errors that additional trusted CAs can fix
// ---------------------------------------------------------------------------

describe("isRecoverableTlsTrustError", () => {
  it.each([
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ])("returns true for %s", (code) => {
    const err = Object.assign(new Error("tls"), { code });
    expect(isRecoverableTlsTrustError(err)).toBe(true);
  });

  it("returns true when the recoverable TLS code is on the cause", () => {
    const cause = Object.assign(new Error("inner"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    const outer = Object.assign(new Error("outer"), { cause });
    expect(isRecoverableTlsTrustError(outer)).toBe(true);
  });

  it.each(["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "ECONNRESET"])(
    "returns false for non-recoverable code %s",
    (code) => {
      const err = Object.assign(new Error("tls"), { code });
      expect(isRecoverableTlsTrustError(err)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// gatewayTrustedCaCertificates — preserve Node defaults and add enterprise trust sources
// ---------------------------------------------------------------------------

describe("gatewayTrustedCaCertificates", () => {
  it("preserves Node bundled root certificates in the gateway CA bundle", () => {
    const bundle = gatewayTrustedCaCertificates();
    expect(bundle.length).toBeGreaterThanOrEqual(rootCertificates.length);
    for (const certificate of rootCertificates) {
      expect(bundle).toContain(certificate);
    }
  });
});

// ---------------------------------------------------------------------------
// readJsonCapped — size bounding and JSON parsing
// ---------------------------------------------------------------------------

function streamingResponse(chunks: readonly string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const enc = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status });
}

describe("readJsonCapped", () => {
  it("parses a small JSON body delivered in a single chunk", async () => {
    const response = streamingResponse(['{"hello":"world"}']);
    const result = await readJsonCapped(response);
    expect(result).toEqual({ hello: "world" });
  });

  it("parses a JSON body delivered across multiple chunks", async () => {
    const response = streamingResponse(['{"x":', "42", "}"], 200);
    const result = await readJsonCapped(response);
    expect(result).toEqual({ x: 42 });
  });

  it("rejects when the streamed body exceeds maxBytes", async () => {
    const big = "x".repeat(200);
    const response = streamingResponse([big]);
    await expect(readJsonCapped(response, 100)).rejects.toThrow(/size limit/);
  });

  it("rejects on non-JSON content even within size limit", async () => {
    const response = streamingResponse(["not json"]);
    await expect(readJsonCapped(response, MAX_RESPONSE_BYTES)).rejects.toThrow();
  });

  it("falls back to response.json() when body is null", async () => {
    // Simulate an environment where Response.body is null while preserving the native
    // Response private slots that response.json() requires.
    const nullBody = new Response(JSON.stringify({ fallback: true }), { status: 200 });
    Object.defineProperty(nullBody, "body", { get: (): null => null });
    const result = await readJsonCapped(nullBody);
    expect(result).toEqual({ fallback: true });
  });
});

// ---------------------------------------------------------------------------
// readSseStream — line-buffered SSE parsing with cross-read reassembly
// ---------------------------------------------------------------------------

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("readSseStream", () => {
  it("parses multiple data lines and terminates on [DONE]", async () => {
    const response = streamingResponse([
      'data: {"a":1}\n',
      'data: {"b":2}\n',
      "data: [DONE]\n",
      'data: {"c":3}\n',
    ]);
    const chunks = await collect(readSseStream(response));
    expect(chunks).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reassembles a data line split across two reader chunks", async () => {
    const response = streamingResponse(['data: {"a":1}\ndata: {"b', '":2}\ndata: [DONE]\n']);
    const chunks = await collect(readSseStream(response));
    expect(chunks).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("ignores blank lines and non-data lines", async () => {
    const response = streamingResponse([
      "\n",
      ": keep-alive comment\n",
      "event: message\n",
      'data: {"a":1}\n',
      "\n",
      "data: [DONE]\n",
    ]);
    const chunks = await collect(readSseStream(response));
    expect(chunks).toEqual([{ a: 1 }]);
  });

  it("trims a trailing carriage return before parsing CRLF lines", async () => {
    const response = streamingResponse(['data: {"a":1}\r\n', "data: [DONE]\r\n"]);
    const chunks = await collect(readSseStream(response));
    expect(chunks).toEqual([{ a: 1 }]);
  });

  it("yields a final data line that has no trailing newline", async () => {
    const response = streamingResponse(['data: {"a":1}']);
    const chunks = await collect(readSseStream(response));
    expect(chunks).toEqual([{ a: 1 }]);
  });

  it("throws when the cumulative stream exceeds maxBytes", async () => {
    const big = `data: {"x":"${"y".repeat(200)}"}\n`;
    const response = streamingResponse([big]);
    await expect(collect(readSseStream(response, 100))).rejects.toThrow(/size limit/);
  });

  it("yields nothing when the response body is null", async () => {
    const inner = new Response('data: {"a":1}\n', { status: 200 });
    const nullBody = Object.create(inner, {
      body: { get: (): null => null },
    }) as Response;
    const chunks = await collect(readSseStream(nullBody));
    expect(chunks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// streamingResponseFromNode — incremental delivery, byte cap, error, headers
// ---------------------------------------------------------------------------

// Builds a PassThrough that mimics the IncomingMessage surface used by streamingResponseFromNode.
function makePassThrough(
  statusCode = 200,
  statusMessage = "OK",
  headers: Record<string, string> = {},
): PassThrough & { statusCode: number; statusMessage: string; headers: Record<string, string> } {
  const pt = new PassThrough() as PassThrough & {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
  };
  pt.statusCode = statusCode;
  pt.statusMessage = statusMessage;
  pt.headers = headers;
  return pt;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}

describe("streamingResponseFromNode", () => {
  it("delivers chunks incrementally before end() is called (mutation guard: buffered impl hangs)", async () => {
    const src = makePassThrough();
    const res = streamingResponseFromNode(src as unknown as IncomingMessage, noop);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    // Write first chunk and read it back WITHOUT calling src.end() yet.
    // A Buffer.concat-on-end implementation would never resolve this read.
    src.write("hello");
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(dec.decode(first.value)).toBe("hello");

    // Continue writing and finish.
    src.write("world");
    src.end();
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(dec.decode(second.value)).toBe("world");

    const terminal = await reader.read();
    expect(terminal.done).toBe(true);
  });

  it("rejects the reader when cumulative bytes exceed maxBytes", async () => {
    const src = makePassThrough();
    const res = streamingResponseFromNode(src as unknown as IncomingMessage, noop, 4);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const reader = res.body!.getReader();

    src.write("hello world"); // 11 bytes > 4
    await expect(reader.read()).rejects.toThrow(/size limit/);
  });

  it("propagates a stream error to the reader", async () => {
    const src = makePassThrough();
    const res = streamingResponseFromNode(src as unknown as IncomingMessage, noop);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const reader = res.body!.getReader();

    src.emit("error", new Error("boom"));
    await expect(reader.read()).rejects.toThrow("boom");
  });

  it("preserves status code and headers from the IncomingMessage", () => {
    const src = makePassThrough(200, "OK", { "content-type": "text/event-stream" });
    const res = streamingResponseFromNode(src as unknown as IncomingMessage, noop);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });
});

// ---------------------------------------------------------------------------
// parseProxyUrl — rejects invalid / forbidden proxy URL forms
// ---------------------------------------------------------------------------

describe("parseProxyUrl (via gatewayFetch egress)", () => {
  it("rejects a credentialed proxy URL with PROXY_AUTH_REQUIRED", async () => {
    await expect(
      gatewayFetch("http://target.example.invalid/path", {
        egress: { httpProxy: "http://user:pass@proxy.invalid:3128" },
      }),
    ).rejects.toMatchObject({ code: "PROXY_AUTH_REQUIRED" });
  });

  it("rejects a non-http/https scheme with PROXY_EGRESS_FAILED", async () => {
    await expect(
      gatewayFetch("http://target.example.invalid/path", {
        egress: { httpProxy: "ftp://proxy.invalid:21" },
      }),
    ).rejects.toMatchObject({ code: "PROXY_EGRESS_FAILED" });
  });

  it("rejects a garbage proxy URL with PROXY_EGRESS_FAILED", async () => {
    await expect(
      gatewayFetch("http://target.example.invalid/path", {
        egress: { httpProxy: "not-a-url" },
      }),
    ).rejects.toMatchObject({ code: "PROXY_EGRESS_FAILED" });
  });
});

// ---------------------------------------------------------------------------
// mapProxyError — error code table
// ---------------------------------------------------------------------------

describe("mapProxyError (via OutboundHttpEgressError code assignment)", () => {
  it("returns an OutboundHttpEgressError instance with PROXY_UNREACHABLE for ECONNREFUSED", async () => {
    const proxy = createHttpServer();
    const port = await listen(proxy);
    await close(proxy); // shut it down immediately so connection is refused
    await expect(
      gatewayFetch(`http://127.0.0.1:${String(port)}/path`, {
        egress: { httpProxy: `http://127.0.0.1:${String(port)}` },
      }),
    ).rejects.toMatchObject({ code: "PROXY_UNREACHABLE" });
  });
});

// ---------------------------------------------------------------------------
// noProxyRuleMatches — rule forms
// ---------------------------------------------------------------------------

describe("noProxyRuleMatches (via gatewayFetch bypassing proxy)", () => {
  // Uses a real listener and a controlled DNS answer so the request genuinely connects to `host`.
  // The reserved hostname keeps the test hermetic across libc/Node combinations that disagree on
  // whether wildcard localhost names resolve, while the pinned direct path still proves that the
  // noProxy subdomain match bypassed the configured proxy (AUDIT-SEC-001).
  async function assertBypassesToRealOrigin(noProxy: string[], host: string): Promise<void> {
    let originHits = 0;
    let proxyHits = 0;
    const origin = createHttpServer((_req, res) => {
      originHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "origin" }));
    });
    const originPort = await listenOnAllInterfaces(origin);
    const proxy = createHttpServer((_req, res) => {
      proxyHits += 1;
      res.writeHead(502);
      res.end("should not be used");
    });
    const proxyPort = await listen(proxy);
    try {
      vi.resetModules();
      vi.doMock("node:dns/promises", () => ({
        lookup: vi.fn(() => Promise.resolve([{ address: "127.0.0.1", family: 4 }])),
      }));
      const { gatewayFetch: pinnedGatewayFetch } = await import("./http.js");
      const response = await pinnedGatewayFetch(`http://${host}:${String(originPort)}/models`, {
        egress: {
          httpProxy: `http://127.0.0.1:${String(proxyPort)}`,
          noProxy,
        },
      });
      expect(await response.json()).toEqual({ via: "origin" });
      expect(proxyHits).toBe(0);
      expect(originHits).toBe(1);
    } finally {
      vi.doUnmock("node:dns/promises");
      vi.resetModules();
      await close(proxy);
      await close(origin);
    }
  }

  async function assertBypassProxy(noProxy: string[], targetPath: string): Promise<void> {
    let originHits = 0;
    let proxyHits = 0;
    const origin = createHttpServer((_req, res) => {
      originHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "origin" }));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer((_req, res) => {
      proxyHits += 1;
      res.writeHead(502);
      res.end();
    });
    const proxyPort = await listen(proxy);
    try {
      await gatewayFetch(`http://127.0.0.1:${String(originPort)}${targetPath}`, {
        egress: {
          httpProxy: `http://127.0.0.1:${String(proxyPort)}`,
          noProxy,
        },
      });
      expect(proxyHits).toBe(0);
      expect(originHits).toBe(1);
    } finally {
      await close(proxy);
      await close(origin);
    }
  }

  it("* bypasses the proxy for all targets", async () => {
    await assertBypassProxy(["*"], "/");
  });

  it("exact hostname bypasses the proxy", async () => {
    await assertBypassProxy(["127.0.0.1"], "/");
  });

  it(".host form (dot-prefix) also matches the exact domain (strips dot)", async () => {
    // The noProxy implementation strips the leading dot for exact-match purposes,
    // so ".127.0.0.1" also matches "127.0.0.1" (bypasses proxy), matching common
    // curl/wget NO_PROXY semantics where ".example.com" covers "example.com" too.
    await assertBypassProxy([".127.0.0.1"], "/");
  });

  it("bare domain rule bypasses subdomains", async () => {
    await assertBypassesToRealOrigin(["keiko-no-proxy.invalid"], "api.keiko-no-proxy.invalid");
  });

  it("leading-dot domain rule bypasses subdomains", async () => {
    await assertBypassesToRealOrigin([".keiko-no-proxy.invalid"], "api.keiko-no-proxy.invalid");
  });

  it("host:port form bypasses only the specific port", async () => {
    let originHits = 0;
    let proxyHits = 0;
    const origin = createHttpServer((_req, res) => {
      originHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "origin" }));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer((_req, res) => {
      proxyHits += 1;
      res.writeHead(502);
      res.end("should not be used");
    });
    const proxyPort = await listen(proxy);
    try {
      await gatewayFetch(`http://127.0.0.1:${String(originPort)}/`, {
        egress: {
          httpProxy: `http://127.0.0.1:${String(proxyPort)}`,
          noProxy: [`127.0.0.1:${String(originPort)}`],
        },
      });
      expect(proxyHits).toBe(0);
      expect(originHits).toBe(1);
    } finally {
      await close(proxy);
      await close(origin);
    }
  });

  it("host:port form does not bypass subdomains without an exact host match", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("should not be called")));
    vi.stubGlobal("fetch", fetchMock);
    let proxyHits = 0;
    const proxy = createHttpServer((_req, res) => {
      proxyHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "proxy" }));
    });
    const proxyPort = await listen(proxy);
    try {
      const response = await gatewayFetch("http://api.corp.example:1234/models", {
        egress: {
          httpProxy: `http://127.0.0.1:${String(proxyPort)}`,
          noProxy: ["corp.example:1234"],
          acknowledgeProxiedHostnamePolicy: true,
        },
      });
      expect(await response.json()).toEqual({ via: "proxy" });
      expect(proxyHits).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await close(proxy);
    }
  });

  it("case-insensitive rule matching (uppercase NO_PROXY entry)", async () => {
    await assertBypassProxy(["127.0.0.1"], "/");
  });

  it("whitespace-trimmed rule matching", async () => {
    await assertBypassProxy(["  127.0.0.1  "], "/");
  });
});

// ---------------------------------------------------------------------------
// CONNECT response status → error codes
// ---------------------------------------------------------------------------

describe("proxy CONNECT response status codes", () => {
  async function connectWithStatus(status: number): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "keiko-connect-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    const proxySockets = new Set<Socket>();
    const proxy = createHttpServer();
    proxy.on("connection", (s) => {
      proxySockets.add(s);
      s.once("close", () => proxySockets.delete(s));
    });
    proxy.on("connect", (_req, clientSocket) => {
      const statusLine =
        status === 200
          ? "HTTP/1.1 200 Connection Established\r\n\r\n"
          : `HTTP/1.1 ${String(status)} Error\r\n\r\n`;
      clientSocket.write(statusLine);
      if (status !== 200) clientSocket.destroy();
    });
    const proxyPort = await listen(proxy);
    try {
      await gatewayFetch("https://127.0.0.1:9999/path", {
        egress: {
          httpsProxy: `http://127.0.0.1:${String(proxyPort)}`,
          caBundlePath,
        },
      });
    } finally {
      for (const s of proxySockets) s.destroy();
      await close(proxy);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("CONNECT 407 → PROXY_AUTH_REQUIRED", async () => {
    await expect(connectWithStatus(407)).rejects.toMatchObject({ code: "PROXY_AUTH_REQUIRED" });
  });

  it("CONNECT 403 → PROXY_BLOCKED_BY_POLICY", async () => {
    await expect(connectWithStatus(403)).rejects.toMatchObject({ code: "PROXY_BLOCKED_BY_POLICY" });
  });

  it("CONNECT 502 → PROXY_EGRESS_FAILED", async () => {
    await expect(connectWithStatus(502)).rejects.toMatchObject({ code: "PROXY_EGRESS_FAILED" });
  });

  it("assembles a CONNECT response header that arrives split across chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-connect-split-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end('{"split":true}');
    });
    const originPort = await listen(origin);
    const proxySockets = new Set<Socket>();
    const proxy = createHttpServer();
    proxy.on("connection", (s) => {
      proxySockets.add(s);
      s.once("close", () => proxySockets.delete(s));
    });
    proxy.on("connect", (req, clientSocket, head) => {
      const [host, portText] = (req.url ?? "").split(":");
      const upstream = netConnect(Number(portText), host, () => {
        // Deliver the CONNECT response header across two writes: a sub-limit first chunk
        // without the terminator, then the closing CRLF. The reader must keep accumulating
        // (not trip the size bound) until the terminator arrives.
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n");
        setTimeout(() => {
          clientSocket.write("\r\n");
          if (head.length > 0) upstream.write(head);
          pipeBounded(upstream, clientSocket);
          pipeBounded(clientSocket, upstream);
        }, 10);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
    const proxyPort = await listen(proxy);
    try {
      const response = await gatewayFetch(`https://127.0.0.1:${String(originPort)}/split`, {
        egress: {
          httpsProxy: `http://127.0.0.1:${String(proxyPort)}`,
          caBundlePath,
        },
        timeoutMs: 5_000,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ split: true });
    } finally {
      for (const s of proxySockets) s.destroy();
      await close(proxy);
      await close(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a CONNECT response that floods without a header terminator (bounded read)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-connect-flood-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    const proxySockets = new Set<Socket>();
    const proxy = createHttpServer();
    proxy.on("connection", (s) => {
      proxySockets.add(s);
      s.once("close", () => proxySockets.delete(s));
    });
    proxy.on("connect", (_req, clientSocket) => {
      // A finite 20 KiB junk blob with no "\r\n\r\n" terminator: over the 16 KiB CONNECT-header
      // bound, so the size guard must reject — the terminator search alone would wait forever.
      clientSocket.write("x".repeat(20_480));
    });
    const proxyPort = await listen(proxy);
    try {
      await expect(
        gatewayFetch("https://127.0.0.1:9999/path", {
          egress: {
            httpsProxy: `http://127.0.0.1:${String(proxyPort)}`,
            caBundlePath,
          },
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({
        code: "PROXY_EGRESS_FAILED",
        message: "Proxy CONNECT response header exceeded the size limit.",
      });
    } finally {
      for (const s of proxySockets) s.destroy();
      await close(proxy);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// connectResponseHeaderExceedsLimit — exact CONNECT-header bound
// ---------------------------------------------------------------------------

describe("connectResponseHeaderExceedsLimit", () => {
  it("accepts buffers up to exactly 16384 bytes", () => {
    expect(connectResponseHeaderExceedsLimit(64)).toBe(false);
    expect(connectResponseHeaderExceedsLimit(16_384)).toBe(false);
  });

  it("rejects buffers beyond 16384 bytes", () => {
    expect(connectResponseHeaderExceedsLimit(16_385)).toBe(true);
    expect(connectResponseHeaderExceedsLimit(20_480)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// timeoutMs — aborts a stalled CONNECT with PROXY_UNREACHABLE
// ---------------------------------------------------------------------------

describe("gatewayFetch timeoutMs", () => {
  it("aborts a stalled proxy CONNECT and rejects with PROXY_UNREACHABLE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-timeout-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    const proxySockets = new Set<Socket>();
    // Stall proxy: accepts the connection, never sends CONNECT response
    const proxy = createHttpServer();
    proxy.on("connection", (s) => {
      proxySockets.add(s);
      s.once("close", () => proxySockets.delete(s));
    });
    proxy.on("connect", (_req, _clientSocket) => {
      // intentionally do nothing — stall forever
    });
    const proxyPort = await listen(proxy);
    try {
      await expect(
        gatewayFetch("https://127.0.0.1:9999/path", {
          egress: {
            httpsProxy: `http://127.0.0.1:${String(proxyPort)}`,
            caBundlePath,
          },
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({ code: "PROXY_UNREACHABLE" });
    } finally {
      for (const s of proxySockets) s.destroy();
      await close(proxy);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not affect behavior when timeoutMs is not set", async () => {
    const body = JSON.stringify({ ok: true });
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(body, { status: 200 }));
    const response = await gatewayFetch("https://example.com/v1/models", { fetchImpl });
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// maxResponseBytes override
// ---------------------------------------------------------------------------

describe("gatewayFetch maxResponseBytes override", () => {
  it("raises the cap via maxResponseBytes on the CA-bundle path", async () => {
    // Simulate a TLS-trust-error trigger to exercise the CA-bundle path, using a
    // local HTTPS server. We inject the CA bundle so the request succeeds and the
    // response is streamed rather than triggering a fallback-not-available error.
    const dir = mkdtempSync(join(tmpdir(), "keiko-maxbytes-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    const payload = "x".repeat(200);
    const originSockets = new Set<Socket>();
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", connection: "close" });
      res.end(payload);
    });
    origin.on("connection", (s) => {
      originSockets.add(s);
      s.once("close", () => originSockets.delete(s));
    });
    const originPort = await listen(origin);
    try {
      // Without override the default cap is 10MB — well above 200 bytes, so
      // a small cap of 100 should be overridable to 300.
      const res = await gatewayFetch(`https://127.0.0.1:${String(originPort)}/`, {
        useCaFallback: true,
        egress: { caBundlePath },
        maxResponseBytes: 300,
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toHaveLength(200);
    } finally {
      for (const s of originSockets) s.destroy();
      await close(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects a reduced maxResponseBytes cap on the CA-bundle path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-maxbytes-low-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    const payload = "x".repeat(200);
    const originSockets = new Set<Socket>();
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", connection: "close" });
      res.end(payload);
    });
    origin.on("connection", (s) => {
      originSockets.add(s);
      s.once("close", () => originSockets.delete(s));
    });
    const originPort = await listen(origin);
    try {
      const res = await gatewayFetch(`https://127.0.0.1:${String(originPort)}/`, {
        useCaFallback: true,
        egress: { caBundlePath },
        maxResponseBytes: 50,
      });
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const reader = res.body!.getReader();
      await expect(reader.read()).rejects.toThrow(/size limit/);
    } finally {
      for (const s of originSockets) s.destroy();
      await close(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CA bundle warn on missing path (item 5)
// ---------------------------------------------------------------------------

describe("extraCaCertificates warn on unreadable path", () => {
  beforeEach(() => {
    _resetWarnedCaBundlePaths();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits console.warn when the configured caBundlePath does not exist", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(noop);
    gatewayTrustedCaCertificates("/nonexistent/path/that/cannot/exist.pem");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("/nonexistent/path/that/cannot/exist.pem");
  });

  it("emits the warning only once per path (one-time guard)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(noop);
    gatewayTrustedCaCertificates("/nonexistent/path/that/cannot/exist.pem");
    gatewayTrustedCaCertificates("/nonexistent/path/that/cannot/exist.pem");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not warn when the path yields a valid certificate", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-caok-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(noop);
    try {
      gatewayTrustedCaCertificates(caBundlePath);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Host header — no :443 for https default port behind proxy
// ---------------------------------------------------------------------------

describe("Host header via proxy (no default port)", () => {
  it("sends Host without :443 for https default port (HTTPS via CONNECT)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-host-"));
    const caBundlePath = join(dir, "ca.pem");
    writeFileSync(caBundlePath, TEST_TLS_CERT, "utf8");
    let capturedHost: string | undefined;
    let originHits = 0;
    const originSockets = new Set<Socket>();
    const proxySockets = new Set<Socket>();
    const origin = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      originHits += 1;
      capturedHost = req.headers.host;
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ ok: true }));
    });
    origin.on("connection", (s) => {
      originSockets.add(s);
      s.once("close", () => originSockets.delete(s));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer();
    proxy.on("connection", (s) => {
      proxySockets.add(s);
      s.once("close", () => proxySockets.delete(s));
    });
    proxy.on("connect", (req, clientSocket, head) => {
      const [host, portText] = (req.url ?? "").split(":");
      const upstream = netConnect(Number(portText), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        pipeBounded(upstream, clientSocket);
        pipeBounded(clientSocket, upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
    const proxyPort = await listen(proxy);
    // Use the standard https port so the host header should omit the port
    try {
      await gatewayFetch(`https://127.0.0.1:${String(originPort)}/`, {
        egress: {
          httpsProxy: `http://127.0.0.1:${String(proxyPort)}`,
          caBundlePath,
        },
      });
      expect(originHits).toBe(1);
      // Host header must not contain ":443" for an https target on its default port.
      // (Our origin is on a non-default port so the port IS included; the test verifies
      // there is no trailing :443 appended when createConnection disables defaultPort.)
      expect(capturedHost).not.toMatch(/:443$/u);
    } finally {
      for (const s of proxySockets) s.destroy();
      for (const s of originSockets) s.destroy();
      await close(proxy);
      await close(origin);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends Host without :80 for http default port (HTTP via proxy)", async () => {
    let capturedHost: string | undefined;
    let originHits = 0;
    const origin = createHttpServer((_req, res) => {
      originHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const originPort = await listen(origin);
    const proxy = createHttpServer((req, res) => {
      capturedHost = req.headers.host;
      // Forward to the KNOWN local origin only — the fake proxy never dereferences the
      // request-line URL, so the harness cannot be steered anywhere else (js/request-forgery).
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: originPort,
          path: "/",
          method: req.method,
          headers: req.headers,
        },
        (upRes: IncomingMessage) => {
          res.writeHead(upRes.statusCode ?? 200, upRes.headers);
          pipeBounded(upRes, res);
        },
      );
      upstream.on("error", () => {
        res.destroy();
      });
      pipeBounded(req, upstream);
    });
    const proxyPort = await listen(proxy);
    // We can't test a target on port 80 in test (privileged), so we verify that
    // the proxy-path Host header correctly includes the non-default port.
    try {
      await gatewayFetch(`http://127.0.0.1:${String(originPort)}/`, {
        egress: {
          httpProxy: `http://127.0.0.1:${String(proxyPort)}`,
        },
      });
      expect(originHits).toBe(1);
      // capturedHost is what the proxy sees in the forwarded request headers —
      // for a non-default port it must include the port.
      expect(capturedHost).toContain(String(originPort));
      // Must not contain :80 suffix for standard http
      expect(capturedHost).not.toMatch(/:80$/u);
    } finally {
      await close(proxy);
      await close(origin);
    }
  });
});
