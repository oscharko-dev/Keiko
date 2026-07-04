import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";

import { buildMatcher } from "./repoSearchMatchers.js";

function nlq(text: string): RetrievalQuery {
  return {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
  };
}

describe("buildMatcher definition intent scoring", () => {
  it("boosts JVM and .NET class declarations over plain references", () => {
    const matcher = buildMatcher(nlq("Where is PaymentService defined?"));
    const reference = matcher.match("PaymentService registry entry");
    expect(matcher.match("public final class PaymentService {")).toBeGreaterThan(reference);
    expect(
      matcher.match("internal sealed partial class PaymentService : BaseService {"),
    ).toBeGreaterThan(reference);
  });

  it("boosts Python, Go, and Rust function/type declarations over plain references", () => {
    const matcher = buildMatcher(nlq("Where is reconcileOrder defined?"));
    const reference = matcher.match("reconcileOrder appears in a comment");
    expect(matcher.match("def reconcileOrder(order):")).toBeGreaterThan(reference);
    expect(matcher.match("func reconcileOrder(order Order) error {")).toBeGreaterThan(reference);
    expect(matcher.match("fn reconcileOrder(order: Order) -> Result<()> {")).toBeGreaterThan(
      reference,
    );
  });
});
