import { describe, expect, it } from "vitest";
import {
  FigmaConnectorError,
  figmaConnectorErrorBody,
  type FigmaConnectorErrorCode,
} from "../figmaConnectorErrors.js";

const ALL_CODES: readonly FigmaConnectorErrorCode[] = [
  "FIGMA_MALFORMED_URL",
  "FIGMA_TOKEN_MISSING",
  "FIGMA_NOT_FOUND",
  "FIGMA_INSUFFICIENT_SCOPE",
  "FIGMA_OVERSIZED_SCOPE",
  "FIGMA_UPSTREAM_UNAVAILABLE",
  "FIGMA_INTERNAL",
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
});
