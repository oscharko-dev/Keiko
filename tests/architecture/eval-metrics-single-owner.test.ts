// ADR-0152 D5 (amended by Issue #2635): the deterministic mean and the binary nDCG@k discount
// formula each have ONE canonical owner in @oscharko-dev/keiko-contracts. The evaluation harness,
// the server retrieval eval, and the model-gateway prompt critic previously carried their own copies
// of the same math; two copies of mean() drifted in name (`average` in the server) and shape
// (`reduce` vs. `for-of`) without changing behaviour, which is exactly the silent-drift condition a
// structural single-owner scan exists to prevent.
//
// The scan is structural, not name-based: it looks for the discount-formula fingerprint that only a
// nDCG@k implementation emits — `1 / Math.log2(<expr> + 2)` — and for the four function-name
// signatures that historically carried the retrieval-metrics primitives outside contracts. Anywhere
// a copy re-appears the scan fails closed with the file that introduced it, so the class cannot
// silently re-triplicate.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { binaryNdcgAtK, mean } from "@oscharko-dev/keiko-contracts/runtime/eval-metrics";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CANONICAL_SOURCE = "packages/keiko-contracts/src/eval-metrics.ts";
const SCANNED_ROOTS = ["packages", "src", "scripts"];
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "out",
  ".next",
  "coverage",
  "__tests__",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".js"]);

// The structural fingerprint of the nDCG@k discount: `1 / Math.log2(<expr> + 2)`. The `+ 2` offset
// keeps rank 0 at the maximum discount of 1 and is the shape's tell. Matching a shape rather than a
// function name means a copy that renames itself is still caught. `\s*` tolerates the formatter's
// output; `\S[^)]*` refuses a bare `Math.log2(+ 2)` so an unrelated coincidence cannot false-match.
const DISCOUNT_FORMULA_SENTINEL = /1\s*\/\s*Math\.log2\(\s*\S[^)]*\+\s*2\s*\)/u;

// Declarations that historically carried the retrieval-metrics primitives outside contracts. The
// pattern catches every top-level binding form JavaScript allows for such a helper: a `function`
// declaration, a `const`/`let`/`var` binding, or an `export` prefix on either. Matching on binding
// form rather than function-declaration syntax alone means a rename to arrow-function form
// (`const average = () => …`) is still caught. `mean` is deliberately absent from the forbidden
// set: it is a generic aggregate name used in other domains (e.g. the prompt-enhancer critic) and
// would false-flag unrelated code — the discount-formula sentinel above is what pins the retrieval
// nDCG owner regardless of what a copy calls itself.
const FORBIDDEN_FUNCTION_PATTERN =
  /\b(?:function|const|let|var)\s+(?:average|ndcgAtK|binaryNdcgAtK|discountedGain)\b/u;

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(extname(entry)) && !/\.test\.[cm]?[jt]sx?$/u.test(entry)) yield full;
  }
}

function canonicalize(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).split("\\").join("/");
}

describe("retrieval-metrics primitives have exactly one owner", () => {
  it("the nDCG@k discount-formula sentinel appears only in keiko-contracts/eval-metrics.ts", () => {
    const owners: string[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        if (DISCOUNT_FORMULA_SENTINEL.test(readFileSync(file, "utf8"))) {
          owners.push(canonicalize(file));
        }
      }
    }
    expect(owners, `nDCG discount formula found in: ${owners.join(", ")}`).toEqual([
      CANONICAL_SOURCE,
    ]);
  });

  it("no source file outside keiko-contracts/eval-metrics.ts declares average/ndcgAtK/binaryNdcgAtK/discountedGain", () => {
    const violations: string[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const relPath = canonicalize(file);
        if (relPath === CANONICAL_SOURCE) continue;
        if (FORBIDDEN_FUNCTION_PATTERN.test(readFileSync(file, "utf8"))) {
          violations.push(relPath);
        }
      }
    }
    expect(
      violations,
      `retrieval-metrics function shape found outside canonical file: ${violations.join(", ")}`,
    ).toEqual([]);
  });

  it("still produces the values the pre-consolidation copies produced, so eval scorecards stay byte-identical", () => {
    // The four gate floors (0.8 / 0.9 / 0.85 / 0.8 for grounded retrieval) rely on the exact
    // scorecard values these helpers return. This pins the specific formulae the server's
    // `average`/`ndcgAtK` and the harness's `mean`/`binaryNdcgAtK` used to emit so a future
    // consolidation cannot silently reshape the math.
    expect(mean([])).toBe(0);
    expect(mean([1, 0, 1])).toBe(2 / 3);
    // With a single relevant item (the server's usage), binaryNdcgAtK reduces to
    // `1 / Math.log2(index + 2)` — the shape the server's `ndcgAtK` also emits after
    // deduplication. IDCG is 1 for a single relevant item, so raw discount === normalized nDCG.
    expect(binaryNdcgAtK(["a", "b", "c"], ["b"], 3)).toBe(1 / Math.log2(3));
    expect(binaryNdcgAtK(["a", "b", "c"], ["x"], 3)).toBe(0);
  });

  it("fails closed on malformed cutoffs and dedupes ranked input so nDCG cannot exceed 1", () => {
    // NaN, Infinity, and negatives collapse to a fail-closed `0` rather than the no-work-to-do
    // `1` a plain floor+clamp would emit. `k = 0` stays the intentional no-relevance case.
    expect(binaryNdcgAtK(["a", "b"], ["a"], Number.NaN)).toBe(0);
    expect(binaryNdcgAtK(["a", "b"], ["a"], -1)).toBe(0);
    expect(binaryNdcgAtK(["a", "b"], ["a"], Number.POSITIVE_INFINITY)).toBe(0);
    expect(binaryNdcgAtK(["a"], ["a"], 0)).toBe(1);
    // Deduplication guards against a normalised nDCG greater than 1: `["a", "a"]` with relevant
    // `["a"]` used to score `1 + 1/log2(3) ≈ 1.63`; it now collapses to the unique ranking's `1`.
    expect(binaryNdcgAtK(["a", "a"], ["a"], 2)).toBe(1);
  });
});
