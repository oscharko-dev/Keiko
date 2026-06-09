import { describe, expect, it } from "vitest";
import { FigmaConnectorError } from "../figmaConnectorErrors.js";
import { classifyTokenFailure, resolveFigmaToken } from "../figmaTokenSource.js";

describe("resolveFigmaToken precedence (vault > config > env)", () => {
  it("prefers the vault token over config and env", () => {
    expect(
      resolveFigmaToken({
        vaultToken: "vault-pat",
        configToken: "config-pat",
        envToken: "env-pat",
      }),
    ).toBe("vault-pat");
  });

  it("falls back to config when no vault token", () => {
    expect(resolveFigmaToken({ configToken: "config-pat", envToken: "env-pat" })).toBe(
      "config-pat",
    );
  });

  it("falls back to env when no vault or config token (dev default preserved)", () => {
    expect(resolveFigmaToken({ envToken: "env-pat" })).toBe("env-pat");
  });

  it("trims surrounding whitespace from the resolved token", () => {
    expect(resolveFigmaToken({ vaultToken: "  spaced-pat  " })).toBe("spaced-pat");
  });

  it("treats a whitespace-only source as absent and falls through", () => {
    expect(resolveFigmaToken({ vaultToken: "   ", envToken: "env-pat" })).toBe("env-pat");
  });

  it("throws FIGMA_TOKEN_MISSING when every source is absent", () => {
    try {
      resolveFigmaToken({});
      throw new Error("expected resolveFigmaToken to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FigmaConnectorError);
      expect((error as FigmaConnectorError).code).toBe("FIGMA_TOKEN_MISSING");
    }
  });

  it("never echoes any token value in the missing-token error", () => {
    try {
      resolveFigmaToken({});
    } catch (error) {
      expect(String(error)).not.toContain("pat");
    }
  });
});

describe("classifyTokenFailure taxonomy (structural, generic)", () => {
  it("maps an explicit expired reason to FIGMA_TOKEN_EXPIRED", () => {
    expect(classifyTokenFailure(403, "Token has expired").code).toBe("FIGMA_TOKEN_EXPIRED");
  });

  it("maps an explicit revoked reason to FIGMA_TOKEN_REVOKED", () => {
    expect(classifyTokenFailure(403, "This token was revoked").code).toBe("FIGMA_TOKEN_REVOKED");
  });

  it("maps an insufficient-scope reason to FIGMA_INSUFFICIENT_SCOPE", () => {
    expect(classifyTokenFailure(403, "Invalid scope(s) for this token").code).toBe(
      "FIGMA_INSUFFICIENT_SCOPE",
    );
  });

  it("maps a permission reason to FIGMA_INSUFFICIENT_SCOPE", () => {
    expect(classifyTokenFailure(403, "You do not have permission").code).toBe(
      "FIGMA_INSUFFICIENT_SCOPE",
    );
  });

  it("maps a 'not allowed' reason to FIGMA_INSUFFICIENT_SCOPE", () => {
    expect(classifyTokenFailure(403, "Action not allowed for this token").code).toBe(
      "FIGMA_INSUFFICIENT_SCOPE",
    );
  });

  it("maps 401 to FIGMA_TOKEN_INVALID", () => {
    expect(classifyTokenFailure(401, "Invalid token").code).toBe("FIGMA_TOKEN_INVALID");
  });

  it("defaults an unknown 403 to the safe FIGMA_TOKEN_INVALID (no guessing)", () => {
    expect(classifyTokenFailure(403, "something we have never seen").code).toBe(
      "FIGMA_TOKEN_INVALID",
    );
  });

  it("defaults a 403 with no reason body to FIGMA_TOKEN_INVALID", () => {
    expect(classifyTokenFailure(403).code).toBe("FIGMA_TOKEN_INVALID");
  });

  it("classification is case-insensitive on the reason", () => {
    expect(classifyTokenFailure(403, "TOKEN HAS EXPIRED").code).toBe("FIGMA_TOKEN_EXPIRED");
  });

  it("maps a proxy 407 to FIGMA_PROXY_EGRESS_FAILED", () => {
    expect(classifyTokenFailure(407).code).toBe("FIGMA_PROXY_EGRESS_FAILED");
  });

  it("maps a 502 bad-gateway to FIGMA_PROXY_EGRESS_FAILED", () => {
    expect(classifyTokenFailure(502).code).toBe("FIGMA_PROXY_EGRESS_FAILED");
  });

  it("maps a 504 gateway-timeout to FIGMA_PROXY_EGRESS_FAILED", () => {
    expect(classifyTokenFailure(504).code).toBe("FIGMA_PROXY_EGRESS_FAILED");
  });

  it("maps 404 to FIGMA_NOT_FOUND", () => {
    expect(classifyTokenFailure(404).code).toBe("FIGMA_NOT_FOUND");
  });

  it("maps a generic 5xx to FIGMA_UPSTREAM_UNAVAILABLE", () => {
    expect(classifyTokenFailure(500).code).toBe("FIGMA_UPSTREAM_UNAVAILABLE");
  });

  it("maps an unclassified status to FIGMA_INTERNAL", () => {
    expect(classifyTokenFailure(418).code).toBe("FIGMA_INTERNAL");
  });

  it("never includes a token-like value in any classified error message", () => {
    const codes = [401, 403, 404, 407, 500, 502, 504, 418];
    for (const status of codes) {
      expect(classifyTokenFailure(status, "figd_secret-reason").message).not.toContain("figd_");
    }
  });
});
