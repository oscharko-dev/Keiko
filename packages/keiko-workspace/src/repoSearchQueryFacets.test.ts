import { describe, expect, it } from "vitest";
import { naturalLanguageContentTermGroups } from "./repoSearchMatchers.js";
import { naturalLanguageSubject } from "./repoSearchQueryTerms.js";

function terms(text: string): readonly string[] {
  return naturalLanguageContentTermGroups(text, false).flat();
}

describe("repository query content facets", () => {
  it("does not let an answer-length instruction become source content", () => {
    const query =
      "Explain token budgets. Cite implementation lines. Keep the answer under 200 words.";
    expect(terms(query)).not.toContain("200");
    expect(terms(query)).toContain("token");
    expect(naturalLanguageSubject(query).citationDirectiveClauseCount).toBe(1);
  });

  it("keeps complete path identity out of unrelated content-word groups", () => {
    const query = "Explain packages/payments/src/lease-policy.ts and token budgets.";
    expect(terms(query)).not.toContain("src");
    expect(terms(query)).not.toContain("ts");
    expect(terms(query)).toContain("token");
  });

  it("preserves those same words, numbers and identifiers outside paths", () => {
    expect(terms("Explain src and ts 200 in state.readPaths and token-bucket-v2.")).toEqual(
      expect.arrayContaining(["src", "ts", "200", "state.readpaths", "token-bucket-v2"]),
    );
  });

  it("preserves quoted literal subjects and their original matching behavior", () => {
    const query = 'Find "src/ts/200.ts" and "Keep the answer under 300 words."';
    expect(terms(query)).toContain("200");
    expect(terms(query)).toContain("300");
    expect(naturalLanguageSubject(query).text).toBe(query);
  });

  it("applies the existing German presentation grammar without losing the subject", () => {
    expect(terms("Erkläre token Budgets. Antworte kurz.")).not.toContain("kurz");
    expect(terms("Erkläre token Budgets. Antworte kurz.")).toContain("token");
  });
});
