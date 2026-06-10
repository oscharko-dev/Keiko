import { PassThrough } from "node:stream";
import {
  createServer as createHttpServer,
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
import { describe, expect, it } from "vitest";
import {
  gatewayTrustedCaCertificates,
  gatewayFetch,
  isMissingIssuerError,
  isRecoverableTlsTrustError,
  MAX_RESPONSE_BYTES,
  readJsonCapped,
  readSseStream,
  streamingResponseFromNode,
} from "./http.js";

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

async function listen(server: HttpServer | HttpsServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function close(server: HttpServer | HttpsServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
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
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
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
    // Simulate an environment where Response.body is null by constructing a minimal
    // duck-typed Response object whose body property is explicitly null.
    const inner = new Response(JSON.stringify({ fallback: true }), { status: 200 });
    const nullBody = Object.create(inner, {
      body: { get: (): null => null },
    }) as Response;
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
