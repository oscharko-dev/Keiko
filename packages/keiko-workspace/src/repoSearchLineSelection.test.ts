import { describe, expect, it } from "vitest";

import { looksLikeBlockHeader, looksLikeSignatureStart } from "./repoSearchLineSelection.js";

describe("looksLikeBlockHeader", () => {
  it("recognises common signature shapes across languages", () => {
    expect(looksLikeBlockHeader("public void foo(int a, int b) {")).toBe(true);
    expect(looksLikeBlockHeader("private static int bar(String x) throws IOException {")).toBe(
      true,
    );
    expect(looksLikeBlockHeader("public Map<String, List<Integer>> baz(int a, int b) {")).toBe(
      true,
    );
    expect(looksLikeBlockHeader("async function run(a, b) {")).toBe(true);
    expect(looksLikeBlockHeader("public T method(A a, B b) throws X, Y, Z {")).toBe(true);
  });

  it("rejects non-signature lines, including control-flow headers and bare statements", () => {
    expect(looksLikeBlockHeader("if (x) {")).toBe(false);
    expect(looksLikeBlockHeader("int x = 5;")).toBe(false);
    // Contains the "function" keyword, so it matches via the keyword branch even without a `{`.
    expect(looksLikeBlockHeader("function noBrace(a, b)")).toBe(true);
    expect(looksLikeBlockHeader("class Foo {")).toBe(true); // has the class/interface/... keyword
    // Also has a keyword ("const"), so it matches via the keyword branch, not the shape scan.
    expect(looksLikeBlockHeader("  const x = (a) => {")).toBe(true);
    // A plain call/statement: no keyword, and no trailing `{` for the shape scan to find.
    expect(looksLikeBlockHeader("x.foo(a, b);")).toBe(false);
  });

  // Regression for typescript/javascript:S8786. The parameter-list segment used to be
  // `[^;{}]*\)`: the class includes `)`, so on a dead-end line (repeated "ident ident("
  // head-shapes, never followed by `{`) the engine re-walks the greedy-then-backtrack search for
  // a closing `)` from every one of those starting points, which is quadratic in line length. A
  // 40,000-character adversarial line (no keyword, no `{` anywhere) would have taken well over a
  // second; the bounded parameter-list class keeps this linear.
  it("resolves an adversarial no-brace line in linear time", () => {
    const adversarialLine = "a b()".repeat(8_000);
    const start = Date.now();
    const result = looksLikeBlockHeader(adversarialLine);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(300);
    expect(result).toBe(false);
  });

  // Second S8786 regression: bounding only the parameter-list class left an independent
  // quadratic vector in the type-prefix class `[\w$<>,.[\]?]*`, which includes `,` and `.` and
  // therefore overlaps with comma/dot-separated content. This adversarial line never contains
  // `{`, so the whole pattern must fail, and it contains no `()` pairing either — it exercises
  // the type-prefix class in isolation from the (already-bounded) parameter-list class. Against
  // the pre-fix pattern (parameter-list bounded, type-prefix left as `*`) this took well over a
  // second at this length with clear quadratic (~4x per doubling) growth; the bounded type-prefix
  // class keeps it linear.
  it("resolves an adversarial comma-separated no-brace line in linear time", () => {
    const adversarialLine = "x y(" + "a,".repeat(20_000) + ";z";
    const start = Date.now();
    const result = looksLikeBlockHeader(adversarialLine);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(300);
    expect(result).toBe(false);
  });

  // Regression for the follow-up finding that a *narrow* finite bound is itself a behaviour
  // change: verbose real signatures (many parameters, long generic types, long default values)
  // can plausibly exceed a small cap like 300 characters. The bound must be generous enough that
  // no realistic single-line signature is silently un-recognised.
  it("still recognises signatures with a long parameter list or type prefix", () => {
    // No keyword branch match here (no class/function/public/.../var token), so this exercises
    // the shape-scanning regex, not the keyword shortcut.
    const longParamList = Array.from(
      { length: 40 },
      (_, i) => `paramName${String(i)}: SomeType${String(i)}`,
    ).join(", ");
    expect(longParamList.length).toBeGreaterThan(300);
    expect(looksLikeBlockHeader(`ReturnType customBuild(${longParamList}) {`)).toBe(true);

    const longTypePrefix = `Map<${Array.from(
      { length: 30 },
      (_, i) => `Key${String(i)}, Value${String(i)}`,
    ).join(", ")}>`;
    expect(longTypePrefix.length).toBeGreaterThan(300);
    expect(looksLikeBlockHeader(`${longTypePrefix} customBuild(int a) {`)).toBe(true);
  });

  // Regression: the manual word-boundary scan used `[\w$]` to decide whether a candidate start
  // position was preceded by a "boundary", but JS's real `\b` (which the original regex's leading
  // `\b` relied on) is defined purely in terms of `\w` = `[A-Za-z0-9_]` and does NOT include `$`.
  // A digit immediately followed by `$` IS a real boundary there (digit is `\w`, `$` isn't): the
  // scan must retry starting at the `$` itself, not skip past it as if it were a continuation of
  // the preceding digit. (Confirmed to actually discriminate: the pre-fix scan returns `false`
  // for this exact line, since it never retries at the `$` position at all.)
  it("recognises a signature whose type-prefix starts right after a digit-adjacent $", () => {
    expect(looksLikeBlockHeader("9$Type getValue() {")).toBe(true);
  });
});

describe("looksLikeSignatureStart", () => {
  it("recognises a no-brace signature shape", () => {
    expect(looksLikeSignatureStart("public void foo(int a, int b)")).toBe(true);
  });

  it("rejects control-flow headers and empty lines", () => {
    expect(looksLikeSignatureStart("if (x)")).toBe(false);
    expect(looksLikeSignatureStart("   ")).toBe(false);
  });

  // Same S8786 shape as `looksLikeBlockHeader`'s type-prefix regression, reached via this
  // function's own `(?:[A-Za-z_$][\w$<>,.[\]?]*\s+)+` fallback regex (used when the keyword and
  // `looksLikeBlockHeader` branches don't match). Never contains `(`, so the whole pattern must
  // fail. Against the pre-fix pattern (unbounded type-prefix class inside the repeated group)
  // this showed the same clean ~4x-per-doubling quadratic growth as the `looksLikeBlockHeader`
  // finding (18ms/68ms/265ms/1067ms at 8k/16k/32k/64k repetitions); the bounded class keeps it
  // linear.
  it("resolves an adversarial comma-separated no-paren line in linear time", () => {
    const adversarialLine = "a,".repeat(20_000) + ";z";
    const start = Date.now();
    const result = looksLikeSignatureStart(adversarialLine);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(300);
    expect(result).toBe(false);
  });
});
