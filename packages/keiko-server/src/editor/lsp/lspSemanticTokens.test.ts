import { describe, expect, it } from "vitest";

import { MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS } from "@oscharko-dev/keiko-contracts";

import {
  MANAGED_LSP_SEMANTIC_MAX_DOCUMENT_BYTES,
  negotiateSemanticTokenLegend,
  sanitizeSemanticTokenResponse,
  type LspSemanticTokenNegotiation,
} from "./lspSemanticTokens.js";

function negotiation(): LspSemanticTokenNegotiation {
  const value = negotiateSemanticTokenLegend({
    full: true,
    legend: {
      tokenTypes: ["class", "builtinType", "deriveHelper"],
      tokenModifiers: ["declaration", "mutable", "injected"],
    },
  });
  if (value === undefined) throw new Error("semantic-token fixture did not negotiate");
  return value;
}

describe("managed LSP semantic-token sanitizer", () => {
  it("maps reviewed standard and rust-analyzer legend values into the closed Monaco vocabulary", () => {
    const negotiated = negotiation();
    const result = sanitizeSemanticTokenResponse(
      { data: [0, 0, 5, 0, 1, 0, 6, 4, 1, 2, 1, 0, 5, 2, 4] },
      "Class type\nmacro",
      7,
      negotiated,
    );

    expect(result).toMatchObject({
      documentVersion: 7,
      returnedTokenCount: 3,
      truncated: false,
    });
    expect(result?.data[3]).toBe(negotiated.legend.tokenTypes.indexOf("class"));
    expect(result?.data[8]).toBe(negotiated.legend.tokenTypes.indexOf("type"));
    expect(result?.data[13]).toBe(negotiated.legend.tokenTypes.indexOf("macro"));
  });

  it.each([
    ["missing legend", { full: true }],
    ["delta only", { full: false, legend: { tokenTypes: [], tokenModifiers: [] } }],
    [
      "duplicate types",
      { full: true, legend: { tokenTypes: ["class", "class"], tokenModifiers: [] } },
    ],
    ["non-string type", { full: true, legend: { tokenTypes: [3], tokenModifiers: [] } }],
  ])("rejects malformed negotiation: %s", (_label, provider) => {
    expect(negotiateSemanticTokenLegend(provider)).toBeUndefined();
  });

  it.each([
    ["short tuple", [0, 0, 1, 0]],
    ["negative delta", [-1, 0, 1, 0, 0]],
    ["unsafe integer", [Number.MAX_SAFE_INTEGER + 1, 0, 1, 0, 0]],
    ["zero length", [0, 0, 0, 0, 0]],
    ["unknown type", [0, 0, 1, 99, 0]],
    ["unknown modifier bit", [0, 0, 1, 0, 8]],
    ["out of range line", [2, 0, 1, 0, 0]],
    ["out of range column", [0, 9, 2, 0, 0]],
    ["overlap", [0, 0, 4, 0, 0, 0, 2, 2, 0, 0]],
  ])("rejects malformed or out-of-document data: %s", (_label, data) => {
    expect(
      sanitizeSemanticTokenResponse({ data }, "short\nline", 1, negotiation()),
    ).toBeUndefined();
  });

  it("rejects excessive token and document payloads without returning a partial overlay", () => {
    const excessive = Array.from(
      { length: (MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS + 1) * 5 },
      (_, index) => (index % 5 === 2 ? 1 : 0),
    );
    expect(
      sanitizeSemanticTokenResponse({ data: excessive }, "x", 1, negotiation()),
    ).toBeUndefined();
    expect(
      sanitizeSemanticTokenResponse(
        { data: [] },
        "x".repeat(MANAGED_LSP_SEMANTIC_MAX_DOCUMENT_BYTES + 1),
        1,
        negotiation(),
      ),
    ).toBeUndefined();
  });

  it("does not retain or echo malformed hostile payload fields", () => {
    const hostile = { data: [0, 0, 1, 0, 0], resultId: "SENTINEL_SECRET" };
    const result = sanitizeSemanticTokenResponse(hostile, "x", 1, negotiation());
    expect(JSON.stringify(result)).not.toContain("SENTINEL_SECRET");
  });

  it("maps the 10,000-token ceiling within the committed full-response budget", () => {
    const tokenCount = MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS;
    const data = Array.from({ length: tokenCount * 5 }, (_, index) => {
      const field = index % 5;
      if (field === 1) return index === 1 ? 0 : 2;
      if (field === 2) return 1;
      return 0;
    });
    const document = `${"x ".repeat(tokenCount)}\n`;
    const started = performance.now();
    const result = sanitizeSemanticTokenResponse({ data }, document, 5, negotiation());
    const durationMs = performance.now() - started;

    expect(result?.returnedTokenCount).toBe(tokenCount);
    expect(durationMs).toBeLessThan(250);
  });
});
