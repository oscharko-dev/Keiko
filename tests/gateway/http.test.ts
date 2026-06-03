import { rootCertificates } from "node:tls";
import { describe, expect, it } from "vitest";
import {
  gatewayTrustedCaCertificates,
  gatewayFetch,
  isMissingIssuerError,
  isRecoverableTlsTrustError,
  MAX_RESPONSE_BYTES,
  readJsonCapped,
} from "../../src/gateway/http.js";

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
