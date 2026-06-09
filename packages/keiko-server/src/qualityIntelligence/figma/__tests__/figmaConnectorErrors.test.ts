import { describe, expect, it } from "vitest";
import {
  FigmaConnectorError,
  figmaConnectorErrorBody,
  type FigmaConnectorErrorCode,
} from "../figmaConnectorErrors.js";

// The COMPLETE coded taxonomy (#760). Every code the connector can surface is listed here so the
// safety + distinctness invariants below cover the whole surface, not a subset.
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
  "FIGMA_TLS_CA_FAILURE",
  "FIGMA_OVERSIZED_SCOPE",
  "FIGMA_RATE_LIMITED",
  "FIGMA_UPSTREAM_UNAVAILABLE",
  "FIGMA_INTERNAL",
];

// Each ticket-named category in #760 must be representable by a present code. A dropped code fails
// here even if ALL_CODES is updated in lockstep, because these literals are spelled out separately.
const REQUIRED_TAXONOMY_CODES: readonly FigmaConnectorErrorCode[] = [
  "FIGMA_TOKEN_INVALID", // auth
  "FIGMA_INSUFFICIENT_SCOPE", // scope
  "FIGMA_RATE_LIMITED", // rate-limit
  "FIGMA_NOT_FOUND", // not-found
  "FIGMA_OVERSIZED_SCOPE", // oversized
  "FIGMA_RENDER_FAILED", // render-failed
  "FIGMA_PROXY_UNREACHABLE", // proxy-unreachable
  "FIGMA_TLS_CA_FAILURE", // tls-ca-failure
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

  it("covers every required #760 taxonomy category with a present, actionable code", () => {
    for (const code of REQUIRED_TAXONOMY_CODES) {
      const body = figmaConnectorErrorBody(code);
      expect(body.error.code).toBe(code);
      // User-actionable: a non-trivial instruction, not a bare status word.
      expect(body.error.message.length).toBeGreaterThan(20);
    }
  });
});
