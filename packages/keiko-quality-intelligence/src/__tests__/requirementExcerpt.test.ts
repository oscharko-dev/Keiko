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

  it("is deterministic", () => {
    const text = "The same input must always produce the same excerpt.";
    expect(buildRequirementExcerpt(text)).toBe(buildRequirementExcerpt(text));
  });
});
