import { describe, expect, it } from "vitest";
import {
  installIgnoredProtocolMetadata,
  observeCapturedExtent,
  protocolEnumerationInput,
} from "./__tests__/support/protocol-observation-mechanics.js";

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

  it("rejects Windows drive-letter absolute document paths", () => {
    const request = {
      schemaVersion: "1",
      root: "/workspace",
      document: { path: "src/lib.rs", languageId: "rust", text: "fn main() {}", version: 4 },
    };
    for (const path of ["C:\\outside.rs", "d:/outside.rs"]) {
      expect(
        parseManagedLspSemanticTokenRequest({
          ...request,
          document: { ...request.document, path },
        }).ok,
      ).toBe(false);
    }
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

import {
  parseManagedLspCandidateCapabilities as publicCandidate,
  parseManagedLspSemanticTokenLegend as publicLegend,
} from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities";

describe.each([
  ["source", parseManagedLspCandidateCapabilities, parseManagedLspSemanticTokenLegend],
  ["public", publicCandidate, publicLegend],
] as const)("3918 capability owning admission %s", (_surface, parseCandidate, parseLegend) => {
  it("preserves the healthy candidate reference and concrete fields", () => {
    const input = candidate();
    const result = parseCandidate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(input);
    expect(result.value.language).toBe("python");
    expect(result.value.operations).toBe(input.operations);
  });
  it("refuses an absent physical operation", () => {
    expect(parseCandidate({ ...candidate(), operations: new Array<unknown>(1) })).toEqual({
      ok: false,
      errors: ["candidate capabilities are invalid or contain unknown fields"],
    });
  });
  it("refuses a physical operation concealed by caller every", () => {
    const operations = [42];
    Object.defineProperty(operations, "every", { value: (): boolean => true });
    expect(parseCandidate({ ...candidate(), operations })).toEqual({
      ok: false,
      errors: ["candidate capabilities are invalid or contain unknown fields"],
    });
  });
  it("refuses an absent physical legend type despite matching counts", () => {
    expect(
      parseLegend({
        ...legend(),
        tokenTypes: new Array<unknown>(1),
        returnedTypeCount: 1,
        totalTypeCount: 1,
      }),
    ).toEqual({
      ok: false,
      errors: ["semantic-token legend is invalid or contains unknown fields"],
    });
  });
  it("retains an ordinary inherited operation", () => {
    const operations = new Array<unknown>(1);
    const prototype = { 0: "hover" };
    Object.setPrototypeOf(prototype, Array.prototype);
    Object.setPrototypeOf(operations, prototype);
    const result = parseCandidate({ ...candidate(), operations });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.operations).toBe(operations);
  });
});

import { LANGUAGE_SERVICE_OPERATIONS } from "./language-service.js";

describe.each([
  ["source", parseManagedLspCandidateCapabilities],
  ["public", publicCandidate],
] as const)("3918 managed-lsp-capabilities captured extent %s", (_surface, parse) => {
  function inspectExtent(
    laterExtent: number,
    firstObservation: { readonly first: unknown } = { first: 1 },
  ): {
    readonly result: boolean;
    readonly indexReads: number;
    readonly lengths: readonly unknown[];
  } {
    const values: unknown[] = ["hover"];
    const observation = observeCapturedExtent(
      values,
      laterExtent,
      firstObservation,
      () => LANGUAGE_SERVICE_OPERATIONS.length + 1,
    );
    const { observed } = observation;
    return {
      result: parse({ ...candidate(), operations: observed }).ok,
      indexReads: observation.indexReads,
      lengths: observation.lengths,
    };
  }
  it("preserves a healthy actual captured extent", () => {
    const observation = inspectExtent(1);
    expect(observation.result).toBe(true);
    expect(observation.lengths.slice(0, 2)).toEqual([1, 1]);
    expect(observation.indexReads).toBeGreaterThan(0);
  });
  it.each([NaN, undefined])("preserves original first-limit refusal for %s", (first) => {
    const observation = inspectExtent(1, { first });
    expect(observation).toEqual({ result: false, indexReads: 0, lengths: [first] });
  });

  it.each([LANGUAGE_SERVICE_OPERATIONS.length + 1, Infinity, 0.5, -1])(
    "refuses captured extent %s before indexing",
    (extent) => {
      const observation = inspectExtent(extent);
      expect({
        accepted: observation.result,
        indexReads: observation.indexReads,
        firstTwoLengths: observation.lengths.slice(0, 2),
      }).toEqual({
        accepted: false,
        indexReads: 0,
        firstTwoLengths: [1, extent],
      });
    },
  );
});

import {
  parseManagedLspSemanticTokenData as publicTokenData,
  managedLspSemanticTokensFitDocument as publicFitDocument,
} from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities";

function finiteSemanticTokens(count: number): number[] {
  return Array.from({ length: count * 5 }, (_, index) => {
    if (index % 5 === 1) return index === 1 ? 0 : 2;
    return index % 5 === 2 ? 1 : 0;
  });
}

describe.each([
  [
    "source",
    parseManagedLspSemanticTokenData,
    parseManagedLspSemanticTokenLegend,
    managedLspSemanticTokensFitDocument,
  ],
  ["public", publicTokenData, publicLegend, publicFitDocument],
] as const)("semantic token resource admission %s", (_surface, parseData, parseLegend, fit) => {
  it("refuses finite over-cap tuples hidden behind two small length observations", () => {
    const parsedLegend = parseLegend(legend());
    expect(parsedLegend.ok).toBe(true);
    if (!parsedLegend.ok) return;
    const backing = finiteSemanticTokens(MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS + 1);
    const input = tokenData(backing);
    let lengthReads = 0;
    const observed = new Proxy(backing, {
      get(target, key, receiver): unknown {
        if (key === "length") return ++lengthReads <= 2 ? 5 : target.length;
        const value: unknown = Reflect.get(target, key, receiver);
        return value;
      },
    });
    expect(parseData({ ...input, data: observed }, parsedLegend.value).ok).toBe(false);
  });

  it("retains exact-cap identity and rejects ordinary excessive tuples", () => {
    const parsedLegend = parseLegend(legend());
    expect(parsedLegend.ok).toBe(true);
    if (!parsedLegend.ok) return;
    const backing = finiteSemanticTokens(MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS);
    const input = tokenData(backing);
    const result = parseData(input, parsedLegend.value);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(input);
      expect(result.value.data).toBe(backing);
    }
    const excessive = tokenData(finiteSemanticTokens(MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS + 1));
    expect(parseData(excessive, parsedLegend.value).ok).toBe(false);
  });

  it("does not settle counts using a different later data getter result", () => {
    const parsedLegend = parseLegend(legend());
    expect(parsedLegend.ok).toBe(true);
    if (!parsedLegend.ok) return;
    const one = finiteSemanticTokens(1);
    const two = finiteSemanticTokens(2);
    const metadata = tokenData(two);
    let reads = 0;
    const input = {
      ...metadata,
      get data(): readonly number[] {
        return ++reads === 1 ? one : two;
      },
    };
    expect(parseData(input, parsedLegend.value).ok).toBe(false);
  });

  it("does not settle legend counts using a different unvalidated array", () => {
    let reads = 0;
    const input = {
      ...legend(),
      get tokenTypes(): readonly string[] {
        return ++reads === 1 ? ["class"] : ["class", "function"];
      },
    };
    expect(parseLegend(input).ok).toBe(false);
  });

  it("does not expand tuple legend bounds during cell inspection", () => {
    const types: ("class" | "function")[] = ["class"];
    const parsedLegend = parseLegend({
      ...legend(),
      tokenTypes: types,
      returnedTypeCount: 1,
      totalTypeCount: 1,
    });
    expect(parsedLegend.ok).toBe(true);
    if (!parsedLegend.ok) return;
    const cells = new Proxy([0, 0, 1, 1, 0], {
      get(target, key, receiver): unknown {
        if (key === "0" && types.length === 1) types.push("function");
        const value: unknown = Reflect.get(target, key, receiver);
        return value;
      },
    });
    const input = tokenData(cells);
    expect(parseData(input, parsedLegend.value).ok).toBe(false);
  });

  it("refuses a fractional captured extent before reading tuple cells", () => {
    const parsedLegend = parseLegend(legend());
    expect(parsedLegend.ok).toBe(true);
    if (!parsedLegend.ok) return;
    let lengths = 0;
    let cells = 0;
    const input = tokenData();
    const observed = new Proxy([0, 0, 4, 0, 1], {
      get(target, key, receiver): unknown {
        if (key === "length") return ++lengths === 2 ? 2.5 : 5;
        if (typeof key === "string" && /^\d+$/u.test(key)) cells += 1;
        const value: unknown = Reflect.get(target, key, receiver);
        return value;
      },
    });
    expect(parseData({ ...input, data: observed }, parsedLegend.value).ok).toBe(false);
    expect(cells).toBe(0);
  });

  it("retains inherited tuple cells and an empty modifier legend", () => {
    const parsedLegend = parseLegend({
      ...legend(),
      tokenModifiers: [],
      returnedModifierCount: 0,
      totalModifierCount: 0,
    });
    expect(parsedLegend.ok).toBe(true);
    if (!parsedLegend.ok) return;
    const cells = new Array<number>(5);
    const prototype = { 0: 0, 1: 0, 2: 1, 3: 0, 4: 0 };
    Object.setPrototypeOf(prototype, Array.prototype);
    Object.setPrototypeOf(cells, prototype);
    const input = tokenData(cells);
    const result = parseData(input, parsedLegend.value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data).toBe(cells);
  });

  it("bounds fitting independently, including a retained array grown after parsing", () => {
    const limit = MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS;
    const exact = finiteSemanticTokens(limit);
    expect(fit(exact, [limit * 2])).toBe(true);
    const excessive = finiteSemanticTokens(limit + 1);
    expect(fit(excessive, [(limit + 1) * 2])).toBe(false);
    const parsedLegend = parseLegend(legend());
    expect(parsedLegend.ok).toBe(true);
    if (!parsedLegend.ok) return;
    const retained = finiteSemanticTokens(1);
    const parsed = parseData(tokenData(retained), parsedLegend.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (let index = 0; index < limit; index += 1) retained.push(0, 2, 1, 0, 0);
    expect(fit(parsed.value.data, [(limit + 1) * 2])).toBe(false);
  });
});

for (const surface of ["source", "public"] as const) {
  it(`${surface}: preserves protocol key enumeration before closed-field refusal`, async () => {
    const module =
      surface === "source"
        ? await import("./managed-lsp-capabilities.js")
        : await import("@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities");
    const trace: string[] = [];
    const value = protocolEnumerationInput(trace);
    expect(module.parseManagedLspCandidateCapabilities(value)).toEqual({
      ok: false,
      errors: ["candidate capabilities are invalid or contain unknown fields"],
    });
    expect(trace).toEqual(["ownKeys", "descriptor:unexpected", "descriptor:schemaVersion"]);
  });

  it(`${surface}: retains ignored symbol and non-enumerable protocol metadata`, async () => {
    const module =
      surface === "source"
        ? await import("./managed-lsp-capabilities.js")
        : await import("@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities");
    const value = candidate();
    let reads = 0;
    installIgnoredProtocolMetadata(value, (): void => {
      reads += 1;
    });
    expect(module.parseManagedLspCandidateCapabilities(value).ok).toBe(true);
    expect(reads).toBe(0);
  });

  it(`${surface}: rejects a non-string protocol vocabulary member without coercion`, async () => {
    const module =
      surface === "source"
        ? await import("./managed-lsp-capabilities.js")
        : await import("@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities");
    let coercions = 0;
    const foreign = {
      toString: (): never => {
        coercions += 1;
        throw new TypeError("Protocol enum coercion");
      },
    };
    const value = { ...snapshot(), protocolVersion: foreign };
    expect(module.parseManagedLspNegotiatedCapabilitySnapshot(value)).toEqual({
      ok: false,
      errors: ["capability snapshot is invalid or contains unknown fields"],
    });
    expect(coercions).toBe(0);
  });
}
