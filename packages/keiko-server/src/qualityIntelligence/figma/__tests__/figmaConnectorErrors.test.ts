import { describe, expect, it } from "vitest";
import { OutboundHttpEgressError } from "@oscharko-dev/keiko-model-gateway/internal/http";
import {
  classifyFigmaTransportError,
  FigmaConnectorError,
  figmaConnectorErrorBody,
  type FigmaConnectorErrorCode,
} from "../figmaConnectorErrors.js";

// The COMPLETE coded taxonomy (#760, #884). Every code the connector can surface is listed here
// so the safety + distinctness invariants below cover the whole surface, not a subset.
const ALL_CODES: readonly FigmaConnectorErrorCode[] = [
  "FIGMA_MALFORMED_URL",
  "FIGMA_TOKEN_MISSING",
  "FIGMA_CONSENT_REQUIRED",
  "FIGMA_TOKEN_INVALID",
  "FIGMA_TOKEN_EXPIRED",
  "FIGMA_TOKEN_REVOKED",
  "FIGMA_NOT_FOUND",
  "FIGMA_INSUFFICIENT_SCOPE",
  "FIGMA_RENDER_FAILED",
  "FIGMA_PROXY_EGRESS_FAILED",
  "FIGMA_PROXY_UNREACHABLE",
  "FIGMA_PROXY_AUTH_REQUIRED",
  "FIGMA_PROXY_BLOCKED_BY_POLICY",
  "FIGMA_TLS_CA_FAILURE",
  "FIGMA_OVERSIZED_SCOPE",
  "FIGMA_RESPONSE_TOO_LARGE",
  "FIGMA_RATE_LIMITED",
  "FIGMA_UPSTREAM_UNAVAILABLE",
  "FIGMA_NETWORK_UNREACHABLE",
  "FIGMA_EGRESS_TIMEOUT",
  "FIGMA_EGRESS_FAILED",
  "FIGMA_INTERNAL",
];

// Each ticket-named category in #760 must be representable by a present code. A dropped code fails
// here even if ALL_CODES is updated in lockstep, because these literals are spelled out separately.
const REQUIRED_TAXONOMY_CODES: readonly FigmaConnectorErrorCode[] = [
  "FIGMA_TOKEN_INVALID", // auth
  "FIGMA_INSUFFICIENT_SCOPE", // scope
  "FIGMA_RATE_LIMITED", // rate-limit
  "FIGMA_NOT_FOUND", // not-found
  "FIGMA_OVERSIZED_SCOPE", // oversized (node-count guard)
  "FIGMA_RESPONSE_TOO_LARGE", // oversized (response body cap)
  "FIGMA_RENDER_FAILED", // render-failed
  "FIGMA_PROXY_UNREACHABLE", // proxy-unreachable
  "FIGMA_PROXY_AUTH_REQUIRED", // proxy-auth
  "FIGMA_PROXY_BLOCKED_BY_POLICY", // proxy-policy
  "FIGMA_TLS_CA_FAILURE", // tls-ca-failure
  "FIGMA_NETWORK_UNREACHABLE", // direct connectivity failure
  "FIGMA_EGRESS_TIMEOUT", // request timeout
];

describe("FigmaConnectorError", () => {
  it("carries a stable code and a fixed safe message per code", () => {
    for (const code of ALL_CODES) {
      const err = new FigmaConnectorError(code);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.name).toBe("FigmaConnectorError");
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it("never carries a token, raw payload, or URL in its message", () => {
    const token = "figd_super-secret-token-value";
    for (const code of ALL_CODES) {
      const err = new FigmaConnectorError(code);
      expect(err.message).not.toContain(token);
      expect(err.message).not.toContain("figd_");
      expect(err.message).not.toContain("http");
      expect(err.message).not.toContain("X-Figma-Token");
    }
  });

  it("produces a safe error body envelope { error: { code, message } }", () => {
    const body = figmaConnectorErrorBody("FIGMA_NOT_FOUND");
    expect(body.error.code).toBe("FIGMA_NOT_FOUND");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("uses a distinct message for each code (no accidental collapse)", () => {
    const messages = ALL_CODES.map((code) => figmaConnectorErrorBody(code).error.message);
    expect(new Set(messages).size).toBe(ALL_CODES.length);
  });

  it("covers every required taxonomy category with a present, actionable code", () => {
    for (const code of REQUIRED_TAXONOMY_CODES) {
      const body = figmaConnectorErrorBody(code);
      expect(body.error.code).toBe(code);
      // User-actionable: a non-trivial instruction, not a bare status word.
      expect(body.error.message.length).toBeGreaterThan(20);
    }
  });
});

describe("classifyFigmaTransportError", () => {
  // ── TLS by .code ────────────────────────────────────────────────────────────
  it("classifies UNABLE_TO_VERIFY_LEAF_SIGNATURE as FIGMA_TLS_CA_FAILURE", () => {
    expect(
      classifyFigmaTransportError(
        Object.assign(new Error("x"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
      ),
    ).toBe("FIGMA_TLS_CA_FAILURE");
  });

  it("classifies DEPTH_ZERO_SELF_SIGNED_CERT as FIGMA_TLS_CA_FAILURE", () => {
    expect(
      classifyFigmaTransportError(
        Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      ),
    ).toBe("FIGMA_TLS_CA_FAILURE");
  });

  // ── TLS by .cause.code ──────────────────────────────────────────────────────
  it("classifies TLS code on .cause as FIGMA_TLS_CA_FAILURE", () => {
    expect(
      classifyFigmaTransportError(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" },
        }),
      ),
    ).toBe("FIGMA_TLS_CA_FAILURE");
  });

  // ── TLS by message ──────────────────────────────────────────────────────────
  it("classifies message 'unable to verify the first certificate' as FIGMA_TLS_CA_FAILURE", () => {
    expect(classifyFigmaTransportError(new Error("unable to verify the first certificate"))).toBe(
      "FIGMA_TLS_CA_FAILURE",
    );
  });

  // ── Direct connectivity by .code — NO proxy involved (#884) ─────────────────
  it.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"] as const)(
    "classifies %s (no proxy) as FIGMA_NETWORK_UNREACHABLE",
    (code) => {
      expect(classifyFigmaTransportError(Object.assign(new Error("x"), { code }))).toBe(
        "FIGMA_NETWORK_UNREACHABLE",
      );
    },
  );

  it.each([
    "EPIPE",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EPROTO",
    "EPERM",
    "EACCES",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ] as const)("classifies %s (no proxy) as FIGMA_NETWORK_UNREACHABLE", (code) => {
    expect(classifyFigmaTransportError(Object.assign(new Error("x"), { code }))).toBe(
      "FIGMA_NETWORK_UNREACHABLE",
    );
  });

  // ── Direct connectivity by .cause.code ──────────────────────────────────────
  it("classifies ENOTFOUND on .cause (no proxy) as FIGMA_NETWORK_UNREACHABLE", () => {
    expect(
      classifyFigmaTransportError(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
      ),
    ).toBe("FIGMA_NETWORK_UNREACHABLE");
  });

  // ── Direct connectivity by message ──────────────────────────────────────────
  it("classifies message 'socket hang up' as FIGMA_NETWORK_UNREACHABLE", () => {
    expect(classifyFigmaTransportError(new Error("socket hang up"))).toBe(
      "FIGMA_NETWORK_UNREACHABLE",
    );
  });

  it("classifies TypeError('fetch failed') as FIGMA_NETWORK_UNREACHABLE", () => {
    expect(classifyFigmaTransportError(new TypeError("fetch failed"))).toBe(
      "FIGMA_NETWORK_UNREACHABLE",
    );
  });

  // ── Timeout / abort names ────────────────────────────────────────────────────
  it("classifies an error named TimeoutError as FIGMA_EGRESS_TIMEOUT", () => {
    const err = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    expect(classifyFigmaTransportError(err)).toBe("FIGMA_EGRESS_TIMEOUT");
  });

  it("classifies an error named AbortError as FIGMA_EGRESS_TIMEOUT", () => {
    expect(classifyFigmaTransportError(new DOMException("aborted", "AbortError"))).toBe(
      "FIGMA_EGRESS_TIMEOUT",
    );
  });

  it("classifies a TimeoutError on .cause as FIGMA_EGRESS_TIMEOUT", () => {
    const inner = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const outer = Object.assign(new Error("fetch failed"), { cause: inner });
    expect(classifyFigmaTransportError(outer)).toBe("FIGMA_EGRESS_TIMEOUT");
  });

  // ── OutboundHttpEgressError — proxy was in play (#884) ──────────────────────
  it.each([
    ["TLS_CA_FAILURE", "FIGMA_TLS_CA_FAILURE"],
    ["PROXY_UNREACHABLE", "FIGMA_PROXY_UNREACHABLE"],
    ["PROXY_AUTH_REQUIRED", "FIGMA_PROXY_AUTH_REQUIRED"],
    ["PROXY_BLOCKED_BY_POLICY", "FIGMA_PROXY_BLOCKED_BY_POLICY"],
    ["PROXY_EGRESS_FAILED", "FIGMA_PROXY_EGRESS_FAILED"],
  ] as const)("classifies OutboundHttpEgressError(%s) as %s", (outboundCode, figmaCode) => {
    const err = new OutboundHttpEgressError(outboundCode, "proxy message");
    expect(classifyFigmaTransportError(err)).toBe(figmaCode);
  });

  it.each([
    ["TLS_CA_FAILURE", "FIGMA_TLS_CA_FAILURE"],
    ["PROXY_UNREACHABLE", "FIGMA_PROXY_UNREACHABLE"],
    ["PROXY_AUTH_REQUIRED", "FIGMA_PROXY_AUTH_REQUIRED"],
    ["PROXY_BLOCKED_BY_POLICY", "FIGMA_PROXY_BLOCKED_BY_POLICY"],
    ["PROXY_EGRESS_FAILED", "FIGMA_PROXY_EGRESS_FAILED"],
  ] as const)(
    "classifies OutboundHttpEgressError(%s) nested under .cause as %s",
    (outboundCode, figmaCode) => {
      const cause = new OutboundHttpEgressError(outboundCode, "proxy message");
      const err = Object.assign(new Error("wrapper"), { cause });
      expect(classifyFigmaTransportError(err)).toBe(figmaCode);
    },
  );

  // Cross-package-boundary fallback: plain Error with a string .code in the outbound set.
  it.each([
    ["TLS_CA_FAILURE", "FIGMA_TLS_CA_FAILURE"],
    ["PROXY_UNREACHABLE", "FIGMA_PROXY_UNREACHABLE"],
    ["PROXY_AUTH_REQUIRED", "FIGMA_PROXY_AUTH_REQUIRED"],
    ["PROXY_BLOCKED_BY_POLICY", "FIGMA_PROXY_BLOCKED_BY_POLICY"],
    ["PROXY_EGRESS_FAILED", "FIGMA_PROXY_EGRESS_FAILED"],
  ] as const)(
    "classifies plain Error with outbound code string %s as %s (cross-package fallback)",
    (outboundCode, figmaCode) => {
      const err = Object.assign(new Error("proxy message"), { code: outboundCode });
      expect(classifyFigmaTransportError(err)).toBe(figmaCode);
    },
  );

  // ECONNREFUSED WITHOUT proxy must NOT be misattributed as FIGMA_PROXY_UNREACHABLE (#884).
  it("ECONNREFUSED without proxy maps to FIGMA_NETWORK_UNREACHABLE, not FIGMA_PROXY_UNREACHABLE", () => {
    const result = classifyFigmaTransportError(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
    );
    expect(result).toBe("FIGMA_NETWORK_UNREACHABLE");
    expect(result).not.toBe("FIGMA_PROXY_UNREACHABLE");
  });

  // ── Fallback ─────────────────────────────────────────────────────────────────
  it("classifies an unrecognised Error as FIGMA_EGRESS_FAILED", () => {
    expect(classifyFigmaTransportError(new Error("weird egress glitch"))).toBe(
      "FIGMA_EGRESS_FAILED",
    );
  });

  it.each([undefined, "boom", 42])(
    "classifies non-Error throwable %s as FIGMA_EGRESS_FAILED",
    (value) => {
      expect(classifyFigmaTransportError(value)).toBe("FIGMA_EGRESS_FAILED");
    },
  );
});
