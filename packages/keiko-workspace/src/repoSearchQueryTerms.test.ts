import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import {
  containsNumberedCompoundQueryTerm,
  expandedQueryTermGroups,
  expandedQueryTerms,
  naturalLanguageSubjectText,
} from "./repoSearchQueryTerms.js";

describe("complete numbered compound spelling", () => {
  it.each(["A", "λ", "𐐀", "\u0301", "7", "٣", "_", "-"])(
    "rejects the compound continuation %s on either side",
    (continuation) => {
      expect(containsNumberedCompoundQueryTerm(`${continuation}Unit-G42`, "Unit-G42")).toBe(false);
      expect(containsNumberedCompoundQueryTerm(`Unit-G42${continuation}`, "Unit-G42")).toBe(false);
    },
  );

  it.each(["Unit-G42", "(Unit-G42)", "Unit-G42,", "docs/Unit-G42.md", "Unit-G42: approved"])(
    "accepts the complete spelling at punctuation and filename boundaries: %s",
    (content) => {
      expect(containsNumberedCompoundQueryTerm(content, "Unit-G42")).toBe(true);
    },
  );

  it("finds a later complete occurrence and preserves case sensitivity", () => {
    expect(containsNumberedCompoundQueryTerm("Unit-G420, then Unit-G42.", "Unit-G42")).toBe(true);
    expect(containsNumberedCompoundQueryTerm("unit-g42", "Unit-G42")).toBe(true);
    expect(containsNumberedCompoundQueryTerm("unit-g42", "Unit-G42", true)).toBe(false);
    expect(containsNumberedCompoundQueryTerm("Unit-G42", "Unit-G42", true)).toBe(true);
    expect(containsNumberedCompoundQueryTerm("Unit-G42", "Unit-G42|Other")).toBe(false);
  });
});

describe("expandedQueryTerms", () => {
  it("bounds expanded groups even when a word compound has thousands of parts", () => {
    const groups = expandedQueryTermGroups("Maple-Account-".repeat(20_000) + "Partner", false);
    expect(groups.flat().length).toBeLessThanOrEqual(48);
    expect(groups[0]).toContain("maple");
    expect(groups[1]).toContain("account");
  });

  it("derives source identifiers from test-style names", () => {
    const terms = expandedQueryTerms("Where is PaymentServiceTest implemented?", false);
    expect(terms).toContain("paymentservicetest");
    expect(terms).toContain("paymentservice");
    expect(terms).toContain("payment");
    expect(terms).toContain("service");
  });

  it("does not derive test stems from identifiers that merely end in lowercase test letters", () => {
    const terms = expandedQueryTerms("Contest Latest ApplicationContest", false);

    expect(terms).not.toContain("con");
    expect(terms).not.toContain("la");
    expect(terms).not.toContain("applicationcon");
  });

  it("derives source identifiers from separator-delimited test suffixes", () => {
    const terms = expandedQueryTerms("payment_service_test", false);

    expect(terms).toContain("payment_service");
  });

  it("derives path and symbol terms from stack-frame locations", () => {
    const terms = expandedQueryTerms(
      "TypeError at src/payments/AuthService.ts:42:13 in validateToken",
      false,
    );
    expect(terms).toContain("src/payments/authservice.ts");
    expect(terms).toContain("authservice");
    expect(terms).toContain("auth");
    expect(terms).toContain("service");
    expect(terms).toContain("validatetoken");
  });

  it("keeps a supplementary-plane character from corrupting camelCase splitting", () => {
    // Regression for the charCodeAt -> codePointAt rename (typescript:S7758) in isAsciiUpper /
    // isAsciiLower / isAsciiDigit. "𝐀" (U+1D400 MATHEMATICAL BOLD CAPITAL A) is a real \p{L}
    // letter outside the BMP (2 UTF-16 code units), so it survives the query tokenizer and
    // reaches camelParts. Neither of its surrogate halves ever falls in the ASCII upper/lower/
    // digit ranges, so it must not trigger a spurious camelCase split.
    const terms = expandedQueryTerms("Where is Get𝐀UserProfile implemented?", false);
    expect(terms).toEqual(expect.arrayContaining(["get𝐀userprofile", "get𝐀user", "profile"]));
  });

  it("adds bounded domain aliases for common monorepo terms", () => {
    const frontend = expandedQueryTerms("Which package powers the frontend?", false);
    expect(frontend).toEqual(expect.arrayContaining(["frontend", "web", "ui", "client"]));

    const infra = expandedQueryTerms("Welche Infrastruktur-Version ist gesetzt?", false);
    expect(infra).toEqual(
      expect.arrayContaining(["infrastruktur", "terraform", "kubernetes", "helm"]),
    );
  });

  it("bridges German repository-architecture vocabulary to English source text", () => {
    const terms = expandedQueryTerms(
      "Welche drei Autonomie-Modi sind definiert und welche Invariante gilt für Repository-Arbeit?",
      false,
    );

    expect(terms).toEqual(
      expect.arrayContaining([
        "three",
        "autonomy",
        "mode",
        "defined",
        "invariant",
        "repository",
        "work",
      ]),
    );
  });

  it("keeps versioned document references atomic instead of matching every sibling record", () => {
    const terms = expandedQueryTerms("Compare ADR-0129 with RFC-9110", false);

    expect(terms).toEqual(expect.arrayContaining(["adr-0129", "rfc-9110"]));
    expect(terms).not.toContain("adr");
    expect(terms).not.toContain("0129");
    expect(terms).not.toContain("rfc");
    expect(terms).not.toContain("9110");
  });

  it("adds morphology and debugging-domain aliases for code questions", () => {
    const terms = expandedQueryTerms("checkout totals are calculating wrong", false);
    expect(terms).toEqual(
      expect.arrayContaining([
        "checkout",
        "cart",
        "total",
        "sum",
        "calculating",
        "calculate",
        "wrong",
        "incorrect",
      ]),
    );
  });

  it("keeps pathological identifier input linear and bounded", () => {
    const query = `${"PaymentServiceTest ".repeat(20_000)} /api/${"x".repeat(100_000)}`;
    const start = performance.now();
    const terms = expandedQueryTerms(query, false);
    const elapsedMs = performance.now() - start;
    expect(terms.length).toBeLessThanOrEqual(48);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe("naturalLanguageSubjectText", () => {
  it.each([
    '"Cite implementation files and lines."',
    "`Cite implementation files and lines.`",
    "> Cite implementation files and lines.",
    "Cite `source`.",
    'Cite "files".',
    "Cite Source implementation.",
    "Cite src/policy.ts implementation.",
    "Cite POST /api/items implementation.",
  ])("preserves quoted, named and located source subjects: %s", (clause) => {
    const text = `Find the message in the source. ${clause}`;
    expect(naturalLanguageSubjectText(text)).toBe(text);
  });
});
