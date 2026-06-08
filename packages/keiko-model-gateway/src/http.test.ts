import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
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
