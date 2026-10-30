// Private review ref retention (Issue #4133): a ref goes when no retained run references it, when
// its pull request is closed, or after 30 days, whichever comes first; only refs under
// `refs/keiko-review/` are ever touched.

import { describe, expect, it } from "vitest";
import { REVIEW_PRIVATE_REF_RETENTION_MS } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { reviewRefExpired } from "./refRetention.js";

const SHA = "c".repeat(40);
const REF = `refs/keiko-review/k0123456789abcdef/12/${SHA}`;
const LOCAL = "refs/keiko-review/k0123456789abcdef/local/r-0123456789abcdef01234567";

function facts(
  overrides: Partial<Parameters<typeof reviewRefExpired>[1]> = {},
): Parameters<typeof reviewRefExpired>[1] {
  return {
    retained: new Set([REF, LOCAL]),
    open: new Set([12]),
    records: new Map([
      [REF, { ref: REF, repositoryRoot: "/r", createdAtMs: 0, pullRequestNumber: 12 }],
    ]),
    nowMs: 1_000,
    ...overrides,
  };
}

describe("reviewRefExpired", () => {
  it("keeps a retained ref of an open pull request inside the retention window", () => {
    expect(reviewRefExpired(REF, facts())).toBe(false);
    expect(reviewRefExpired(LOCAL, facts())).toBe(false);
  });

  it("expires a ref no retained run references", () => {
    expect(reviewRefExpired(REF, facts({ retained: new Set() }))).toBe(true);
  });

  it("expires a ref whose pull request is closed, and ignores that rule when the list is unknown", () => {
    expect(reviewRefExpired(REF, facts({ open: new Set([13]) }))).toBe(true);
    expect(reviewRefExpired(REF, facts({ open: undefined }))).toBe(false);
    expect(reviewRefExpired(LOCAL, facts({ open: new Set() }))).toBe(false);
  });

  it("expires a ref after 30 days even while referenced", () => {
    expect(reviewRefExpired(REF, facts({ nowMs: REVIEW_PRIVATE_REF_RETENTION_MS + 1 }))).toBe(true);
    expect(reviewRefExpired(REF, facts({ nowMs: REVIEW_PRIVATE_REF_RETENTION_MS }))).toBe(false);
  });
});
