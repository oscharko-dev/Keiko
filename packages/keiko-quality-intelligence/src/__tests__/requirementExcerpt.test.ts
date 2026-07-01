// Requirement excerpt builder tests (Epic #734, Issue #790).
//
// The excerpt is the ONLY place atom text escapes the server-side ingestion scope, so the
// redact-before-truncate ordering is load-bearing: a secret split by truncation would no longer
// match any redaction pattern downstream.

import { describe, expect, it } from "vitest";
import {
  buildRequirementExcerpt,
  REQUIREMENT_EXCERPT_MAX_CHARS,
} from "../domain/requirementExcerpt.js";

describe("buildRequirementExcerpt", () => {
  it("collapses whitespace (including the path\\ntext canonical shape) into one line", () => {
    expect(buildRequirementExcerpt("docs/auth.md\nLock the account\tafter   five failures.")).toBe(
      "docs/auth.md Lock the account after five failures.",
    );
  });

  it("returns undefined for empty or whitespace-only text so callers omit the field", () => {
    expect(buildRequirementExcerpt("")).toBeUndefined();
    expect(buildRequirementExcerpt("  \n\t ")).toBeUndefined();
  });

  it("truncates long text to the cap with a trailing ellipsis", () => {
    const excerpt = buildRequirementExcerpt("x".repeat(500));
    expect(excerpt).toBeDefined();
    expect(excerpt?.length).toBeLessThanOrEqual(REQUIREMENT_EXCERPT_MAX_CHARS);
    expect(excerpt?.endsWith("…")).toBe(true);
  });

  it("keeps text at exactly the cap untouched (no ellipsis)", () => {
    const text = "y".repeat(REQUIREMENT_EXCERPT_MAX_CHARS);
    expect(buildRequirementExcerpt(text)).toBe(text);
  });

  it("redacts a planted secret BEFORE truncation so no partial secret survives the cut", () => {
    const secret = `AKIA${"A".repeat(16)}`;
    // Place the secret so naive truncate-then-redact would slice it mid-key.
    const text = `${"requirement ".repeat(7)}${secret} trailing context that pushes past the cap`;
    const excerpt = buildRequirementExcerpt(text);
    expect(excerpt).toBeDefined();
    expect(excerpt).not.toContain("AKIA");
  });

  it("redacts a secret in short text and keeps the surrounding prose", () => {
    const excerpt = buildRequirementExcerpt(`use key AKIA${"B".repeat(16)} for S3`);
    expect(excerpt).toContain("[REDACTED]");
    expect(excerpt).not.toContain("AKIA");
    expect(excerpt).toContain("for S3");
  });

  it("redacts German PII and common token prefixes from requirement excerpts", () => {
    const githubToken = `ghp_${"A".repeat(36)}`;
    const excerpt = buildRequirementExcerpt(
      [
        "IBAN DE89 3704 0044 0532 0130 00",
        "Telefon +49 30 1234567",
        "E-Mail kunde@example.test",
        `Token ${githubToken}`,
      ].join(" "),
    );

    expect(excerpt).toContain("[REDACTED]");
    expect(excerpt).not.toContain("DE89");
    expect(excerpt).not.toContain("+49");
    expect(excerpt).not.toContain("kunde@example.test");
    expect(excerpt).not.toContain(githubToken);
  });

  it("strips bidi, zero-width, and C0/C1 control code points from the audit-ready excerpt", () => {
    // The excerpt feeds the coverage matrix, gap-finding summaries, and the CSV + Markdown
    // traceability export (the "audit-ready" surfaces of Epic #734). Invisible / bidi / control
    // characters must not ride through — symmetric with the candidate-text chokepoint. Built from
    // code points (not literals) so the source stays pure ASCII and the spoof bytes are explicit.
    const RLO = String.fromCodePoint(0x202e); // right-to-left override
    const ZWSP = String.fromCodePoint(0x200b); // zero-width space
    const NUL = String.fromCodePoint(0x0000); // C0
    const C1 = String.fromCodePoint(0x009b); // C1 control (CSI)
    const NEL = String.fromCodePoint(0x0085); // C1 next-line
    const dirty = `Lock${RLO}the${ZWSP} account${NUL} now${C1} done${NEL}here`;
    const excerpt = buildRequirementExcerpt(dirty);
    expect(excerpt).toBeDefined();
    for (const spoof of [RLO, ZWSP, NUL, C1, NEL]) {
      expect(excerpt).not.toContain(spoof);
    }
    // The legible words survive intact.
    expect(excerpt).toContain("Lock");
    expect(excerpt).toContain("account");
    expect(excerpt).toContain("done");
  });

  it("de-obfuscates a zero-width-split secret BEFORE redaction so it cannot survive (strip-then-redact)", () => {
    // A credential broken up by an interstitial zero-width character evades redact(), whose patterns
    // match contiguous characters. Stripping the spoof FIRST rejoins the key so redact() scrubs it;
    // redact-then-strip (or no strip at all) would leak the rejoined secret. This pins the ordering.
    const ZWSP = String.fromCodePoint(0x200b);
    const split = `use key AKIA${ZWSP}${"A".repeat(16)} for S3`;
    const excerpt = buildRequirementExcerpt(split);
    expect(excerpt).toContain("[REDACTED]");
    expect(excerpt).not.toContain("AKIA");
    expect(excerpt).not.toContain(ZWSP);
    expect(excerpt).toContain("for S3");
  });

  it("is deterministic", () => {
    const text = "The same input must always produce the same excerpt.";
    expect(buildRequirementExcerpt(text)).toBe(buildRequirementExcerpt(text));
  });
});
