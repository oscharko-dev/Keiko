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

  it("recognizes present-tense definition questions", () => {
    expect(
      directDefinitionSymbol(query("Where do we define reconcile_order?"), [
        { ...identifier, term: "reconcile_order" },
      ]),
    ).toBe("reconcile_order");
    expect(
      directDefinitionSymbol(query("Wo definieren wir reconcile_order?"), [
        { ...identifier, term: "reconcile_order" },
      ]),
    ).toBe("reconcile_order");
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
    for (const relation of [
      "usages",
      "Historie",
      "Änderungen",
      "called",
      "referenced",
      "dependencies",
      "imported",
      "invoked",
      "use",
      "introduced",
      "HISTORY",
    ]) {
      expect(
        directDefinitionSymbol(
          query(`Show the definition and ${relation} of KeikoNonexistentQuantumHandler987`),
          [identifier],
        ),
      ).toBeUndefined();
    }
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

  it("does not reject ordinary identifiers whose lowercase spelling ends in test", () => {
    expect(
      directDefinitionSymbol(query("Where is Contest defined?"), [
        { ...identifier, term: "contest" },
      ]),
    ).toBe("contest");
    expect(
      directDefinitionSymbol(query("Where is Latest defined?"), [
        { ...identifier, term: "latest" },
      ]),
    ).toBe("latest");
  });

  it("requires a definition verb and exactly one high-confidence identifier", () => {
    expect(
      directDefinitionSymbol(query("Inspect KeikoNonexistentQuantumHandler987"), [identifier]),
    ).toBeUndefined();
    expect(
      directDefinitionSymbol(query("Where is KeikoNonexistentQuantumHandler987 defined?"), []),
    ).toBeUndefined();
    expect(
      directDefinitionSymbol(query("Where is the payment route defined?"), [
        { term: "/api/payments", weight: 0.95, kind: "path" },
      ]),
    ).toBeUndefined();
    expect(
      directDefinitionSymbol(query("Where is KeikoNonexistentQuantumHandler987 defined?"), [
        { ...identifier, weight: 0.84 },
      ]),
    ).toBeUndefined();
  });
});
