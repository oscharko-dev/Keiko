import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";

import { buildMatcher, normalizeNaturalLanguageToken } from "./repoSearchMatchers.js";

function nlq(text: string): RetrievalQuery {
  return {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
  };
}

describe("normalizeNaturalLanguageToken", () => {
  it("strips leading/trailing punctuation while preserving internal punctuation", () => {
    expect(normalizeNaturalLanguageToken("ADR-0022")).toBe("ADR-0022");
    expect(normalizeNaturalLanguageToken("-ADR-0022-")).toBe("ADR-0022");
    expect(normalizeNaturalLanguageToken("file.ts")).toBe("file.ts");
    expect(normalizeNaturalLanguageToken(".file.ts.")).toBe("file.ts");
    expect(normalizeNaturalLanguageToken("!!!hello???")).toBe("hello");
    expect(normalizeNaturalLanguageToken("")).toBe("");
    expect(normalizeNaturalLanguageToken("???")).toBe("");
    expect(normalizeNaturalLanguageToken("héllo")).toBe("héllo");
  });

  // SonarCloud S8786: the trailing strip used to be the unanchored `[^\p{L}\p{N}]+$`. Without a
  // `^` anchor, the engine retries the match at every position inside a long non-alphanumeric run
  // before concluding there is no match at the string's end — quadratic in input length
  // (confirmed empirically: ~580ms at 32k characters before the fix). Must stay fast well past
  // that size.
  //
  // The adversarial input MUST start with an alphanumeric character. A run of non-alnum
  // characters at the very START of the string (e.g. `"!".repeat(60_000) + "a"`) is fully
  // consumed by the (always-safe, `^`-anchored) leading strip before the previously-vulnerable
  // trailing strip ever sees more than a 1-character string — that shape exercises no quadratic
  // behavior at all, on either the old or the new implementation. Anchoring the run between two
  // alphanumeric characters (`"x" + "!"*60_000 + "a"`) means the leading strip matches nothing
  // (the string already starts with an alnum char), so the full 60,000-character run reaches the
  // trailing-strip logic — this is what actually reproduces the O(n^2) blowup on the old
  // `[^\p{L}\p{N}]+$` pattern (~1.8s at 60k characters on the pre-fix code).
  it("stays fast on a long embedded non-alphanumeric run bounded by alnum chars (regression for SonarCloud S8786)", () => {
    const adversarial = `x${"!".repeat(60_000)}a`;
    const start = Date.now();
    const result = normalizeNaturalLanguageToken(adversarial);
    expect(Date.now() - start).toBeLessThan(1500);
    // Internal punctuation between two alphanumeric characters is preserved (same contract as the
    // "ADR-0022" case above) — the string is unchanged because there is nothing to strip at
    // either end.
    expect(result).toBe(adversarial);
  });
});

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
