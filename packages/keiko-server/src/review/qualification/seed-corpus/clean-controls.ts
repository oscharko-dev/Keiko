// Clean controls of the synthetic review seed corpus (Issue #4132): harmless changes with nothing
// to find. Any finding a review presents on one of them is a false alarm, counted apart from recall.
// Generated for this corpus alone: no Keiko or customer code.

import { cleanControl, type ReviewSeedCorpusEntry } from "./define.js";

const TOTALS_BASE = `export function invoiceTotal(lines: readonly { readonly amount: number }[]): number {
  let t = 0;
  for (const l of lines) t += l.amount;
  return t;
}
`;

const TOTALS_HEAD = `export function invoiceTotal(lines: readonly { readonly amount: number }[]): number {
  let total = 0;
  for (const line of lines) total += line.amount;
  return total;
}
`;

const RETRY_BASE = `export function backoffDelay(attempt: number): number {
  return Math.min(30_000, 250 * 2 ** attempt);
}
`;

const RETRY_HEAD = `/** The longest wait between two attempts, in milliseconds. */
const MAX_DELAY_MS = 30_000;
/** The wait before the first retry, in milliseconds. */
const BASE_DELAY_MS = 250;

/** Exponential backoff for the given zero-based attempt, capped at {@link MAX_DELAY_MS}. */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
}
`;

const SLUG = `export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
`;

const SLUG_TEST = `import { describe, expect, it } from "vitest";

import { slugify } from "./slug.js";

describe("slugify", () => {
  it("joins words with single dashes", () => {
    expect(slugify("  Quarterly   Report 2026 ")).toBe("quarterly-report-2026");
  });

  it("drops leading and trailing separators", () => {
    expect(slugify("--Draft--")).toBe("draft");
  });
});
`;

export const REVIEW_SEED_CLEAN_CONTROLS: readonly ReviewSeedCorpusEntry[] = Object.freeze([
  cleanControl({
    id: "synthetic-clean-rename",
    baseFiles: { "src/totals.ts": TOTALS_BASE },
    headFiles: { "src/totals.ts": TOTALS_HEAD },
    summary: "Renames three local variables; behaviour is unchanged.",
  }),
  cleanControl({
    id: "synthetic-clean-named-constants",
    baseFiles: { "src/retry.ts": RETRY_BASE },
    headFiles: { "src/retry.ts": RETRY_HEAD },
    summary: "Names two literals and documents them; the computed delays are identical.",
  }),
  cleanControl({
    id: "synthetic-clean-added-test",
    baseFiles: { "src/slug.ts": SLUG },
    headFiles: { "src/slug.ts": SLUG, "src/slug.test.ts": SLUG_TEST },
    summary: "Adds a unit test for an existing helper; production code is untouched.",
  }),
]);
