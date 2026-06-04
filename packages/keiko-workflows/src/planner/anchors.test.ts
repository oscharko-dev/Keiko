// Tests for the deterministic search-anchor extractor (Issue #181).

import { describe, expect, it } from "vitest";

import { extractAnchors, type AnchorExtractionResult } from "./anchors.js";

function run(text: string, maxAnchors = 8): AnchorExtractionResult {
  return extractAnchors({ text, maxAnchors });
}

describe("extractAnchors", () => {
  it("returns an empty result for empty text", () => {
    const result = run("");
    expect(result.anchors).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.tokensConsidered).toBe(0);
  });

  it("returns an empty truncated result when input exceeds the safety cap", () => {
    const result = run("a".repeat(4097));
    expect(result.anchors).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.tokensConsidered).toBe(0);
  });

  it("captures a double-quoted span as a quoted anchor at weight 1.0", () => {
    const result = run('look for "foo bar" here');
    const quoted = result.anchors.filter((a) => a.kind === "quoted");
    expect(quoted).toEqual([{ term: "foo bar", weight: 1, kind: "quoted" }]);
  });

  it("captures a single-quoted span as a quoted anchor", () => {
    const result = run("look for 'foo bar' here");
    const quoted = result.anchors.filter((a) => a.kind === "quoted");
    expect(quoted).toEqual([{ term: "foo bar", weight: 1, kind: "quoted" }]);
  });

  it("captures a path-shaped token as a path anchor at weight 0.95", () => {
    const result = run("see src/foo/bar.ts for context");
    const path = result.anchors.find((a) => a.kind === "path");
    expect(path).toEqual({ term: "src/foo/bar.ts", weight: 0.95, kind: "path" });
  });

  it("captures a backtick span as an identifier anchor at weight 0.9", () => {
    const result = run("the `MyClass` symbol");
    const ident = result.anchors.find((a) => a.kind === "identifier" && a.term === "myclass");
    expect(ident).toEqual({ term: "myclass", weight: 0.9, kind: "identifier" });
  });

  it("mixed prompt yields one anchor per concept and drops stop-words", () => {
    const result = run("How does `SearchScope` work in src/foo.ts when relativePaths is empty?");
    const terms = result.anchors.map((a) => a.term).sort();
    expect(terms).toContain("searchscope");
    expect(terms).toContain("src/foo.ts");
    expect(terms).toContain("relativepaths");
    expect(terms).not.toContain("how");
    expect(terms).not.toContain("does");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("when");
    expect(terms).not.toContain("is");
  });

  it("classifies dotted tokens as identifiers", () => {
    const result = run("call Foo.bar from there");
    const ident = result.anchors.find((a) => a.term === "foo.bar");
    expect(ident).toBeDefined();
    expect(ident?.kind).toBe("identifier");
  });

  it("is deterministic across repeated calls", () => {
    const text = "look at `Planner` in src/p/q.ts and the ExplorationBudget value";
    const first = run(text);
    const second = run(text);
    expect(second).toEqual(first);
  });

  it("dedups identical tokens to one anchor", () => {
    const result = run("foo foo foo");
    const fooHits = result.anchors.filter((a) => a.term === "foo");
    expect(fooHits).toHaveLength(1);
  });

  it("truncates the output when more candidates exist than maxAnchors", () => {
    const result = run("alpha beta gamma delta epsilon zeta", 2);
    expect(result.anchors).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("drops a prompt made of only stop-words", () => {
    const result = run("the and for of");
    expect(result.anchors).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("does NOT match Windows-style backslash paths", () => {
    const result = run("see src\\foo\\bar.ts for context");
    const path = result.anchors.find((a) => a.kind === "path");
    expect(path).toBeUndefined();
  });

  it("sorts by weight desc then term asc", () => {
    const result = run('alpha bravo "charlie delta" src/x.ts `Echo`');
    const sortedCopy = [...result.anchors].sort((a, b) => {
      if (a.weight !== b.weight) {
        return b.weight - a.weight;
      }
      return a.term.localeCompare(b.term);
    });
    expect(result.anchors).toEqual(sortedCopy);
  });
});
