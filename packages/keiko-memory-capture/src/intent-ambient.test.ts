import { describe, expect, it } from "vitest";

import type { MemoryId, MemoryProposalId, UserId } from "@oscharko-dev/keiko-contracts/memory";

import { tryExtractAmbientIdentity } from "./intent-ambient.js";
import type { CaptureContext } from "./types.js";

function ctx(overrides: Partial<CaptureContext> = {}): CaptureContext {
  let memoryCounter = 0;
  let proposalCounter = 0;
  return {
    userId: "u-1" as UserId,
    nowMs: 1_700_000_000_000,
    newMemoryId: (): MemoryId => `m-${String(++memoryCounter)}` as MemoryId,
    newProposalId: (): MemoryProposalId => `p-${String(++proposalCounter)}` as MemoryProposalId,
    ...overrides,
  };
}

describe("tryExtractAmbientIdentity", () => {
  it('extracts "my name is X" as a proposed candidate', () => {
    const outcome = tryExtractAmbientIdentity("my name is Paul.", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("The user's name is Paul.");
    expect(outcome.proposal.scope).toEqual({ kind: "user", userId: "u-1" });
  });

  it('extracts "call me X" and "ich heiße X"', () => {
    expect(tryExtractAmbientIdentity("call me Bob!", ctx())?.kind).toBe("candidate");
    const outcome = tryExtractAmbientIdentity("ich heiße Anna", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("The user's name is Anna.");
  });

  it('extracts the greeting-prefixed "hallo keiko, ich bin X" weak form when strictly capitalized', () => {
    const outcome = tryExtractAmbientIdentity("Hallo Keiko, ich bin Paul", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("The user's name is Paul.");
  });

  it('rejects the weak "i am X" form when X is not strictly capitalized (avoids "i am tired")', () => {
    expect(tryExtractAmbientIdentity("i am tired", ctx())).toBeNull();
  });

  it("rejects a disallowed filler token standing in for a name", () => {
    expect(tryExtractAmbientIdentity("my name is the", ctx())).toBeNull();
    expect(tryExtractAmbientIdentity("i am working here", ctx())).toBeNull();
  });

  it("rejects more than the maximum number of name tokens", () => {
    expect(
      tryExtractAmbientIdentity("my name is Anna Maria Schmidt Meyer Extra", ctx()),
    ).toBeNull();
  });

  it("accepts up to the maximum number of name tokens", () => {
    const outcome = tryExtractAmbientIdentity("my name is Anna Maria Schmidt Meyer", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("The user's name is Anna Maria Schmidt Meyer.");
  });

  // Trailing whitespace/punctuation handling: these encode the exact edge cases the old
  // `\s*[.!?]*$` regex tail resolved, now handled by plain-JS stripping (see rewrite note below).
  it("strips trailing punctuation directly after the name", () => {
    const outcome = tryExtractAmbientIdentity("my name is Paul!!!", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("The user's name is Paul.");
  });

  it("strips a trailing whitespace run then a trailing punctuation run", () => {
    const outcome = tryExtractAmbientIdentity("my name is Paul !!!", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("The user's name is Paul.");
  });

  it("resolves a name followed by a trailing newline", () => {
    // A trailing newline (and nothing else after it) must still be absorbed, matching the
    // original `.+?\s*[.!?]*$` regex's behaviour on this input.
    const outcome = tryExtractAmbientIdentity("my name is Paul\n", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("The user's name is Paul.");
  });

  it("does not cross an embedded newline into further chat content (regression)", () => {
    // The original `.`-based capture cannot match a line terminator, so a two-line message like
    // this ("my name is Sarah" followed by a second, unrelated line) never matched at all — the
    // regex could not reach the trailing `$` because the second line's ordinary words aren't
    // whitespace/punctuation. A capture that spans line breaks (e.g. a bare `[\s\S]+`) regresses
    // this: it would merge the two lines into one bogus name ("Sarah Nice to chat"). This must
    // stay rejected, exactly like the pre-existing single-line-only extraction.
    expect(tryExtractAmbientIdentity("my name is Sarah\nNice to chat", ctx())).toBeNull();
  });

  it("does not cross an embedded newline for the weak identity form either", () => {
    expect(
      tryExtractAmbientIdentity("Hallo Keiko, ich bin Paul\nWie geht es dir", ctx()),
    ).toBeNull();
  });

  it("still tolerates purely decorative content on a trailing blank line", () => {
    // Trailing blank lines / punctuation-only lines after the name are filler, not content, and
    // the original regex's `\s*[.!?]*$` tail (which matches across embedded newlines via `\s`)
    // accepted them.
    const outcome = tryExtractAmbientIdentity("my name is Paul\n\n", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("The user's name is Paul.");
  });
});

// ─── Regex performance (SonarCloud S8786 regression) ──────────────────────────
//
// STRONG_IDENTITY_RE and WEAK_IDENTITY_RE used to end their capture group with a `\s*[.!?]*$`
// tail: two further unbounded quantifiers chained directly after `.+?`, all three over
// overlapping character classes (`.` matches whitespace and `.!?` too). That forced the engine to
// re-explore the split between the capture and the tail at every position a trailing
// whitespace/punctuation run could start, which is quadratic on adversarial input (verified
// empirically before the fix: a "keyword + N dots + trailing space" body went from 0ms at 500
// dots to 32-131ms at 8_000-16_000 dots, roughly quadrupling per doubling, i.e. O(n^2)). The fix
// reduces the tail to a single `[\s\S]+` capture and moves the trailing-punctuation/whitespace
// stripping into plain string scans (`stripIdentityCaptureTail` / `stripTrailingPunctuation`),
// which can never backtrack.
//
// TRAILING_PUNCTUATION_RE (`/[.!?]+$/u`, formerly used inside `normalizeCandidateName`) had the
// same class of issue from a different angle: being unanchored at the front, `String#replace`
// retries the match at every starting index, so a punctuation run not aligned with the true end
// (e.g. many "!" followed by one trailing non-punctuation character) made it re-scan and
// backtrack from every position within the run (verified empirically: ~13ms at 5_000 chars
// growing to ~777ms at 40_000, again O(n^2)). It is now a plain backward-scanning loop, which is
// linear regardless of alignment.
const PERFORMANCE_BUDGET_MS = 300;

describe("regex performance (SonarCloud S8786 regression)", () => {
  it("resolves a large 'dots then trailing space' body via the strong identity path quickly", () => {
    const adversarialBody = `${".".repeat(20_000)} `;
    const start = Date.now();
    const outcome = tryExtractAmbientIdentity(`my name is ${adversarialBody}`, ctx());
    expect(Date.now() - start).toBeLessThan(PERFORMANCE_BUDGET_MS);
    // Dots are not letters, so the extracted "name" fails token validation either way; the point
    // of this test is that rejection is fast, not what the outcome is.
    expect(outcome).toBeNull();
  });

  it("resolves a large 'dots then trailing space' body via the weak identity path quickly", () => {
    const adversarialBody = `${".".repeat(20_000)} `;
    const start = Date.now();
    const outcome = tryExtractAmbientIdentity(`i am ${adversarialBody}`, ctx());
    expect(Date.now() - start).toBeLessThan(PERFORMANCE_BUDGET_MS);
    expect(outcome).toBeNull();
  });

  it("resolves a large trailing punctuation run that is misaligned with the true end quickly", () => {
    // "!" run followed by one non-punctuation character: this specific shape is what made the
    // old unanchored `/[.!?]+$/u` regex re-scan from every position inside the run.
    const adversarialBody = `${"!".repeat(20_000)}a`;
    const start = Date.now();
    const outcome = tryExtractAmbientIdentity(`my name is ${adversarialBody}`, ctx());
    expect(Date.now() - start).toBeLessThan(PERFORMANCE_BUDGET_MS);
    // The token starts with "!", not a letter, so NAME_TOKEN_RE rejects it.
    expect(outcome).toBeNull();
  });

  // The greeting prefix ("hello|hi|hey|hallo" + "keiko" + optional punctuation) used to be
  // matched inline by the identity regexes via `\s+keiko\s*[,!.\-:]?\s*`: two `\s`-matching
  // quantifiers either side of a possibly-empty optional group, which is the same
  // overlapping-adjacent-quantifier shape the trailing tail (above) had. A "hello keiko" body
  // followed by a long space run and no valid identity keyword forces the engine to retry every
  // split of that run before giving up — empirically quadratic (~80ms at 10k spaces growing to
  // ~4.4s at 80k). `skipGreetingPrefix` scans the identical shape once, with no backtracking.
  it("resolves a large space run after a greeting prefix quickly (no matching keyword follows)", () => {
    const adversarialBody = " ".repeat(20_000);
    const start = Date.now();
    const outcome = tryExtractAmbientIdentity(`hello keiko${adversarialBody}`, ctx());
    expect(Date.now() - start).toBeLessThan(PERFORMANCE_BUDGET_MS);
    expect(outcome).toBeNull();
  });

  it("still extracts the name through a greeting prefix with punctuation and extra whitespace", () => {
    const outcome = tryExtractAmbientIdentity("hey   keiko  ,   my name is Paul", ctx());
    expect(outcome?.kind).toBe("candidate");
    if (outcome?.kind !== "candidate") return;
    expect(outcome.proposal.body).toBe("The user's name is Paul.");
  });

  it("does not consume a greeting-shaped prefix that never resolves to keiko", () => {
    expect(tryExtractAmbientIdentity("hello there, my name is Paul", ctx())).toBeNull();
  });
});
