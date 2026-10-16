import { describe, expect, it } from "vitest";
import { linkDtoContracts, type CodeLanguage, type CodeSymbol } from "./codeIntelligence.js";

function symbol(name: string, language: CodeLanguage, scopePath = name): CodeSymbol {
  return {
    name,
    language,
    scopePath,
    kind: "interface",
    lineRange: { startLine: 1, endLine: 2 },
    fields: ["id", "value"],
    parser: "polyglot-regex",
  };
}

describe("cross-language DTO pairing work", () => {
  it("does not visit all same-language pairs in a large frontend inventory", () => {
    const symbols = Array.from({ length: 1_000 }, (_, index) =>
      symbol(`Shape${String(index)}`, "typescript"),
    );
    let workChecks = 0;
    const edges = linkDtoContracts(symbols, {
      deadlineAtMs: Infinity,
      nowMs: (): number => {
        workChecks += 1;
        return 0;
      },
    });
    expect(edges).toEqual([]);
    expect(workChecks).toBeLessThan(10_000);
  });

  it("preserves unordered-pair order, confidence and same-scope exclusion", () => {
    const symbols = [
      symbol("OrderDto", "typescript", "frontend/order.ts"),
      symbol("Different", "java", "backend/Other.java"),
      symbol("OrderRecord", "kotlin", "backend/Order.kt"),
      symbol("OrderModel", "typescript", "frontend/alias.ts"),
      symbol("OrderResponse", "java", "frontend/order.ts"),
    ];
    const edges = linkDtoContracts(symbols, { deadlineAtMs: Infinity, nowMs: () => 0 });
    expect(
      edges.map(({ source, target, confidence }) => [source.name, target.name, confidence]),
    ).toEqual([
      ["OrderDto", "Different", "heuristic"],
      ["OrderDto", "OrderRecord", "resolved"],
      ["Different", "OrderRecord", "heuristic"],
      ["Different", "OrderModel", "heuristic"],
      ["OrderRecord", "OrderModel", "resolved"],
      ["OrderRecord", "OrderResponse", "resolved"],
      ["OrderModel", "OrderResponse", "resolved"],
    ]);
  });

  it.each([false, true])(
    "does not revisit earlier cross-language targets (interleaved: %s)",
    (interleaved) => {
      const frontend = Array.from({ length: 100 }, (_, index) =>
        symbol(`Frontend${String(index)}`, "typescript"),
      );
      const backend = Array.from({ length: 100 }, (_, index) =>
        symbol(`Backend${String(index)}`, "java"),
      );
      const symbols = interleaved
        ? frontend.flatMap((entry, index) => {
            const other = backend[index];
            return other === undefined ? [entry] : [entry, other];
          })
        : [...frontend, ...backend];
      let workChecks = 0;
      const edges = linkDtoContracts(symbols, {
        deadlineAtMs: Infinity,
        nowMs: (): number => {
          workChecks += 1;
          return 0;
        },
      });
      expect(edges).toHaveLength(10_000);
      expect(workChecks).toBeLessThan(15_000);
    },
  );

  it("stops pairing when the shared deadline or signal is already exhausted", () => {
    const symbols = [symbol("OrderDto", "typescript"), symbol("OrderRecord", "java")];
    expect(linkDtoContracts(symbols, { deadlineAtMs: 0, nowMs: () => 0 })).toEqual([]);
    expect(
      linkDtoContracts(symbols, {
        deadlineAtMs: Infinity,
        nowMs: () => 0,
        signal: AbortSignal.abort(),
      }),
    ).toEqual([]);
  });
});
