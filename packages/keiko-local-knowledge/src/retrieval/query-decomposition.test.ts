import { describe, expect, it } from "vitest";

import { decomposeChainedQuery } from "./query-decomposition.js";

describe("decomposeChainedQuery", () => {
  it("returns [] for single-part questions (behavioural no-op)", () => {
    expect(decomposeChainedQuery("How do I configure the retry limit?")).toEqual([]);
    expect(decomposeChainedQuery("Wie konfiguriere ich das Wiederholungslimit")).toEqual([]);
    expect(decomposeChainedQuery("torque spec for spindle mounts")).toEqual([]);
  });

  it("returns [] for empty and whitespace-only input", () => {
    expect(decomposeChainedQuery("")).toEqual([]);
    expect(decomposeChainedQuery("   ")).toEqual([]);
  });

  it("splits chains of question-mark separated questions", () => {
    expect(
      decomposeChainedQuery("How do I configure the retry limit? What does error E410 mean?"),
    ).toEqual(["How do I configure the retry limit", "What does error E410 mean"]);
  });

  it("splits German question-mark chains", () => {
    expect(
      decomposeChainedQuery("Wie setze ich das Drehmoment? Und was bedeutet Fehler E410?"),
    ).toEqual(["Wie setze ich das Drehmoment", "Und was bedeutet Fehler E410"]);
  });

  it("splits semicolon-joined parts", () => {
    expect(
      decomposeChainedQuery("retry limit configuration; meaning of error E410 timeout"),
    ).toEqual(["retry limit configuration", "meaning of error E410 timeout"]);
  });

  it("splits on a conjunction ONLY when followed by an interrogative", () => {
    expect(
      decomposeChainedQuery("Wie installiere ich das Modul und welche Fehlercodes gibt es"),
    ).toEqual(["Wie installiere ich das Modul", "welche Fehlercodes gibt es"]);
    expect(decomposeChainedQuery("How do I mount the bracket and what torque is required")).toEqual(
      ["How do I mount the bracket", "what torque is required"],
    );
  });

  it("never splits a plain conjunction between noun phrases", () => {
    expect(decomposeChainedQuery("What is the difference between Maven and Gradle")).toEqual([]);
    expect(decomposeChainedQuery("Was ist der Unterschied zwischen Maven und Gradle")).toEqual([]);
    expect(decomposeChainedQuery("Vergleiche Import und Export im Handbuch")).toEqual([]);
  });

  it("rejects decompositions containing a too-short fragment", () => {
    // "why so" (2 tokens after the interrogative) — the whole decomposition is rejected
    // rather than emitting a noise variant.
    expect(decomposeChainedQuery("How do I mount the bracket and why so")).toEqual([]);
  });

  it("rejects chains with more than three parts", () => {
    expect(
      decomposeChainedQuery("what is a? what is b now? what is c now? what is d now? what is e?"),
    ).toEqual([]);
  });

  it("keeps exact identifiers intact inside the split parts", () => {
    const parts = decomposeChainedQuery(
      "Where is ADR-0022 referenced? And how does check:package-surface verify exports?",
    );
    expect(parts).toEqual([
      "Where is ADR-0022 referenced",
      "And how does check:package-surface verify exports",
    ]);
  });

  it("does not catastrophically backtrack on a long whitespace run (no ReDoS)", () => {
    // Regression for js/polynomial-redos (CodeQL, high severity): the conjunction-split pattern
    // used to run TWO unbounded `\s+` quantifiers around an alternation. `query` is raw,
    // attacker-controlled chat text with no length limit enforced upstream, so a long run of a
    // single whitespace character with no matching conjunction word used to cost O(n^2) — the
    // unbounded form measured ~800ms at 40,000 pathological characters and grows quadratically
    // from there. Non-whitespace characters bookend the run so `.trim()` cannot strip it away
    // before it ever reaches the vulnerable pattern.
    const pathological = `a${"\t".repeat(200_000)}b`;
    const start = Date.now();
    decomposeChainedQuery(pathological);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
