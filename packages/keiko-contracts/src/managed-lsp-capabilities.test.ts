import { describe, expect, it } from "vitest";

import {
  MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS,
  MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS,
  MANAGED_LSP_SEMANTIC_TOKEN_TYPES,
  isManagedLspOperationNegotiated,
  managedLspSemanticTokensFitDocument,
  parseManagedLspCandidateCapabilities,
  parseManagedLspNegotiatedCapabilitySnapshot,
  parseManagedLspSemanticTokenData,
  parseManagedLspSemanticTokenLegend,
  parseManagedLspSemanticTokenRequest,
} from "./managed-lsp-capabilities.js";

function candidate(): Record<string, unknown> {
  return {
    schemaVersion: MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
    language: "python",
    operations: ["diagnostics", "hover", "inlayHints"],
    semanticTokensCandidate: true,
  };
}

function snapshot(): Record<string, unknown> {
  return {
    schemaVersion: MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
    snapshotVersion: 3,
    configurationRevision: 7,
    language: "python",
    protocolVersion: "3.18",
    positionEncoding: "utf-16",
    textSync: "incremental",
    candidateOperations: ["diagnostics", "hover", "inlayHints"],
    negotiatedOperations: ["diagnostics", "hover"],
    dynamicallyUnregisteredOperations: ["inlayHints"],
    semanticTokens: { supported: true, legendVersion: 2 },
  };
}

function legend(): Record<string, unknown> {
  return {
    schemaVersion: MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
    legendVersion: 2,
    tokenTypes: ["class", "function"],
    tokenModifiers: ["declaration", "readonly"],
    returnedTypeCount: 2,
    totalTypeCount: 2,
    returnedModifierCount: 2,
    totalModifierCount: 2,
    truncated: false,
  };
}

function tokenData(data: readonly number[] = [0, 0, 4, 0, 1]): Record<string, unknown> {
  return {
    schemaVersion: MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
    legendVersion: 2,
    documentVersion: 9,
    dataVersion: 4,
    data,
    returnedTokenCount: data.length / 5,
    totalTokenCount: data.length / 5,
    truncated: false,
  };
}

describe("candidate and negotiated managed LSP capabilities", () => {
  it("keeps static candidates distinct from versioned negotiated snapshots", () => {
    expect(parseManagedLspCandidateCapabilities(candidate()).ok).toBe(true);
    expect(parseManagedLspNegotiatedCapabilitySnapshot(snapshot()).ok).toBe(true);
    expect(parseManagedLspCandidateCapabilities(snapshot()).ok).toBe(false);
    expect(parseManagedLspNegotiatedCapabilitySnapshot(candidate()).ok).toBe(false);
  });

  it("advertises only negotiated, still-registered operations", () => {
    const parsed = parseManagedLspNegotiatedCapabilitySnapshot(snapshot());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(isManagedLspOperationNegotiated(parsed.value, "hover")).toBe(true);
      expect(isManagedLspOperationNegotiated(parsed.value, "inlayHints")).toBe(false);
      expect(isManagedLspOperationNegotiated(parsed.value, "futureOperation")).toBe(false);
    }
  });

  it.each([
    ["unknown operation", { ...snapshot(), negotiatedOperations: ["futureOperation"] }],
    ["not a candidate", { ...snapshot(), negotiatedOperations: ["formatting"] }],
    [
      "registered and unregistered",
      {
        ...snapshot(),
        negotiatedOperations: ["inlayHints"],
        dynamicallyUnregisteredOperations: ["inlayHints"],
      },
    ],
    ["unknown field", { ...snapshot(), rawServerCapabilities: { executeCommand: true } }],
    ["schema skew", { ...snapshot(), schemaVersion: "2" }],
  ])("fails closed for $0", (_label, input) => {
    expect(parseManagedLspNegotiatedCapabilitySnapshot(input).ok).toBe(false);
  });

  it("supports LSP 3.17 and 3.18 compatibility only", () => {
    expect(
      parseManagedLspNegotiatedCapabilitySnapshot({ ...snapshot(), protocolVersion: "3.17" }).ok,
    ).toBe(true);
    expect(
      parseManagedLspNegotiatedCapabilitySnapshot({ ...snapshot(), protocolVersion: "3.19" }).ok,
    ).toBe(false);
  });

  it("fails closed for unknown position encodings and text synchronization modes", () => {
    expect(
      parseManagedLspNegotiatedCapabilitySnapshot({ ...snapshot(), positionEncoding: "utf-32" }).ok,
    ).toBe(false);
    expect(
      parseManagedLspNegotiatedCapabilitySnapshot({ ...snapshot(), textSync: "future" }).ok,
    ).toBe(false);
  });

  it("represents Shell provider metadata without claiming semantic tokens", () => {
    const shellOperations = ["diagnostics", "completion", "hover", "symbols"];
    expect(
      parseManagedLspCandidateCapabilities({
        ...candidate(),
        language: "shell",
        operations: shellOperations,
        semanticTokensCandidate: false,
      }).ok,
    ).toBe(true);
    expect(
      parseManagedLspNegotiatedCapabilitySnapshot({
        ...snapshot(),
        language: "shell",
        candidateOperations: shellOperations,
        negotiatedOperations: shellOperations,
        dynamicallyUnregisteredOperations: [],
        semanticTokens: { supported: false, legendVersion: null },
      }).ok,
    ).toBe(true);
  });
});

describe("bounded Monaco-safe semantic tokens", () => {
  it("rejects positions outside or overlapping the current document", () => {
    expect(managedLspSemanticTokensFitDocument([0, 0, 4, 0, 0, 1, 2, 2, 0, 0], [4, 4])).toBe(true);
    expect(managedLspSemanticTokensFitDocument([0, 3, 2, 0, 0], [4])).toBe(false);
    expect(managedLspSemanticTokensFitDocument([0, 2, 2, 0, 0, 0, 0, 1, 0, 0], [4])).toBe(false);
  });
  it("accepts only bounded Rust full-document request envelopes", () => {
    const request = {
      schemaVersion: "1",
      root: "/workspace",
      document: { path: "src/lib.rs", languageId: "rust", text: "fn main() {}", version: 4 },
    };
    expect(parseManagedLspSemanticTokenRequest(request).ok).toBe(true);
    expect(
      parseManagedLspSemanticTokenRequest({
        ...request,
        document: { ...request.document, path: "../outside.rs" },
      }).ok,
    ).toBe(false);
    expect(
      parseManagedLspSemanticTokenRequest({
        ...request,
        document: { ...request.document, languageId: "python" },
      }).ok,
    ).toBe(false);
    expect(parseManagedLspSemanticTokenRequest({ ...request, tokenBodies: true }).ok).toBe(false);
  });

  it("freezes the closed Monaco-safe token vocabulary", () => {
    expect(MANAGED_LSP_SEMANTIC_TOKEN_TYPES).toContain("class");
    expect(MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS).toContain("readonly");
    expect(Object.isFrozen(MANAGED_LSP_SEMANTIC_TOKEN_TYPES)).toBe(true);
    expect(Object.isFrozen(MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS)).toBe(true);
  });

  it("accepts a versioned legend and matching five-integer token data", () => {
    const parsedLegend = parseManagedLspSemanticTokenLegend(legend());
    expect(parsedLegend.ok).toBe(true);
    if (parsedLegend.ok) {
      expect(parseManagedLspSemanticTokenData(tokenData(), parsedLegend.value).ok).toBe(true);
    }
  });

  it("accepts explicit legend and data truncation with honest counts", () => {
    expect(
      parseManagedLspSemanticTokenLegend({
        ...legend(),
        returnedTypeCount: 2,
        totalTypeCount: 3,
        truncated: true,
      }).ok,
    ).toBe(true);
    const parsedLegend = parseManagedLspSemanticTokenLegend(legend());
    expect(parsedLegend.ok).toBe(true);
    if (parsedLegend.ok) {
      expect(
        parseManagedLspSemanticTokenData(
          { ...tokenData(), returnedTokenCount: 1, totalTokenCount: 2, truncated: true },
          parsedLegend.value,
        ).ok,
      ).toBe(true);
    }
  });

  it.each([
    ["unknown token type", { ...legend(), tokenTypes: ["credential"] }],
    ["duplicate token type", { ...legend(), tokenTypes: ["class", "class"] }],
    ["dishonest truncation", { ...legend(), totalTypeCount: 3, truncated: false }],
    ["unknown field", { ...legend(), sourceText: "SENTINEL" }],
    ["schema skew", { ...legend(), schemaVersion: "2" }],
  ])("rejects $0 legends", (_label, input) => {
    expect(parseManagedLspSemanticTokenLegend(input).ok).toBe(false);
  });

  it("rejects malformed, unsafe-index, modifier-mask, version-skew, and over-cap data", () => {
    const parsedLegend = parseManagedLspSemanticTokenLegend(legend());
    expect(parsedLegend.ok).toBe(true);
    if (!parsedLegend.ok) return;
    expect(parseManagedLspSemanticTokenData(tokenData([0, 0, 4, 0]), parsedLegend.value).ok).toBe(
      false,
    );
    expect(
      parseManagedLspSemanticTokenData(tokenData([0, 0, 4, 2, 0]), parsedLegend.value).ok,
    ).toBe(false);
    expect(
      parseManagedLspSemanticTokenData(tokenData([0, 0, 4, 0, 4]), parsedLegend.value).ok,
    ).toBe(false);
    expect(
      parseManagedLspSemanticTokenData({ ...tokenData(), legendVersion: 3 }, parsedLegend.value).ok,
    ).toBe(false);
    expect(
      parseManagedLspSemanticTokenData(
        { ...tokenData(), totalTokenCount: 5, truncated: false },
        parsedLegend.value,
      ).ok,
    ).toBe(false);
    const overCap = Array.from(
      { length: (MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS + 1) * 5 },
      (_, index) => (index % 5 === 2 ? 1 : 0),
    );
    expect(parseManagedLspSemanticTokenData(tokenData(overCap), parsedLegend.value).ok).toBe(false);
  });

  it("never throws when a hostile legend is inspected", () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error("hostile getter");
        },
      },
    );
    expect(() => parseManagedLspSemanticTokenLegend(hostile)).not.toThrow();
    expect(parseManagedLspSemanticTokenLegend(hostile).ok).toBe(false);
  });
});
