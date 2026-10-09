import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { collectBestLines } from "./repoSearchLineSelection.js";
import { buildMatcher, type LineMatcher } from "./repoSearchMatchers.js";
import { htmlEntityLineMatcher } from "./repoSearchHtml.js";
import { resolveSearchPolicy, scoreContentForSearch } from "./repoSearchPolicy.js";
import * as classification from "./repoSearchSourceClassification.js";

const QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "What temperature trips the Vesper dosing interlock?",
  caseSensitive: false,
  maxResults: 20,
  emittedAtMs: 0,
};
const TEXT = "<nav>Home | Maintenance | Restart</nav>\r\n<p>Vesper trips at 73.5.</p>\r\n";

function selected(matcher: LineMatcher): ReturnType<typeof collectBestLines> {
  return collectBestLines(
    {
      matcher,
      limits: { elapsedMsMax: null, maxMatchesReturned: 20 },
      nowMs: () => 0,
      startMs: 0,
    },
    TEXT,
    { truncated: false },
    "manual.html",
  );
}

afterEach(() => vi.restoreAllMocks());

describe("literal manual queries avoid unused source classification", () => {
  it.each([false, true])("retains actual physical ranges with HTML projection=%s", (projection) => {
    const spy = vi.spyOn(classification, "repositorySourceLines");
    const literal = buildMatcher(QUERY, { kind: "literal", terms: ["vesper", "trips"] });
    const matcher = projection ? htmlEntityLineMatcher(literal) : literal;
    const conservative = selected({ match: matcher.match });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockClear();
    expect(selected(matcher)).toEqual(conservative);
    expect(conservative).toEqual([{ line: 2, startLine: 2, endLine: 2, score: 1 }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not classify source syntax when content scoring cannot award structural bonuses", () => {
    const spy = vi.spyOn(classification, "repositorySourceLines");
    expect(
      scoreContentForSearch(QUERY, TEXT, resolveSearchPolicy(true), "manual.html"),
    ).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: "exact-symbol" as const,
      text: "reconcileInvoice",
      content: "export function reconcileInvoice() { return 937; }",
      path: "source.ts",
    },
    {
      kind: "natural-language" as const,
      text: "Where is reconcileInvoice defined?",
      content: "export function reconcileInvoice() { return 937; }",
      path: "source.ts",
    },
    {
      kind: "natural-language" as const,
      text: "Where is GET /api/invoices implemented?",
      content: 'router.get("/api/invoices", handler);',
      path: "routes.ts",
    },
  ])("retains structural classification for $text", (row) => {
    const spy = vi.spyOn(classification, "repositorySourceLines");
    const query = { ...QUERY, kind: row.kind, text: row.text };
    expect(
      scoreContentForSearch(query, row.content, resolveSearchPolicy(true), row.path),
    ).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledOnce();
  });
});
