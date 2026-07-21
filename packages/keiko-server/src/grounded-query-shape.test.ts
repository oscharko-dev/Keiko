import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts";
import type { SearchAnchor } from "@oscharko-dev/keiko-workflows";
import { directDefinitionSymbol } from "./grounded-query-shape.js";

function query(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 50, emittedAtMs: 0 };
}

const identifier: SearchAnchor = {
  term: "keikononexistentquantumhandler987",
  weight: 0.85,
  kind: "identifier",
};

describe("directDefinitionSymbol", () => {
  it("recognizes a single exact German definition target", () => {
    expect(
      directDefinitionSymbol(query("Wo ist KeikoNonexistentQuantumHandler987 definiert?"), [
        identifier,
      ]),
    ).toBe(identifier.term);
  });

  it("keeps relationship and history questions on the structural path", () => {
    expect(
      directDefinitionSymbol(
        query("Wo ist KeikoNonexistentQuantumHandler987 definiert und aufgerufen?"),
        [identifier],
      ),
    ).toBeUndefined();
    expect(
      directDefinitionSymbol(
        query("Show the recent history of KeikoNonexistentQuantumHandler987 definition"),
        [identifier],
      ),
    ).toBeUndefined();
  });

  it("rejects ambiguous multi-symbol definition questions", () => {
    expect(
      directDefinitionSymbol(query("Where are AlphaHandler and BetaHandler defined?"), [
        { ...identifier, term: "alphahandler" },
        { ...identifier, term: "betahandler" },
      ]),
    ).toBeUndefined();
  });

  it("keeps test-suffixed source-implementation lookups on the structural path", () => {
    expect(
      directDefinitionSymbol(query("Where is the source implementation for PaymentServiceTest?"), [
        { ...identifier, term: "paymentservicetest" },
      ]),
    ).toBeUndefined();
  });
});
