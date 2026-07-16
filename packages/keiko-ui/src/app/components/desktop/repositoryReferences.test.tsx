// SonarCloud S8786 remediation — regression coverage for the regex-safety fixes in
// repositoryReferences.tsx. Each vulnerable pattern here had super-linear (quadratic) worst-case
// behavior on adversarial, non-matching input because an unbounded quantifier was retried across
// every character offset (or overlapped with an adjacent quantified atom). The timing assertions
// pin the fixed, linear behavior; the equivalence assertions pin that ordinary valid/invalid inputs
// still parse identically to before.
//
// Adversarial-input sizes and budgets below are deliberately large (not just "big enough to be
// slow on the old code") so the assertions are decisive rather than a coin flip:
//   - The pre-fix (quadratic) implementation takes several SECONDS at these sizes — many times the
//     budget below, on any machine.
//   - The fixed (linear) implementation finishes in a small fraction of the budget — comfortable
//     headroom even on a slow/loaded CI runner.
// Both were verified directly against the pre-fix implementation before picking these numbers (see
// the file history / PR description for the measurements); a test that only clears its budget by a
// few percent proves nothing (a prior revision of these tests had exactly that problem).

import { describe, expect, it } from "vitest";
import {
  normalizeReferencePath,
  parseExactRepositoryReference,
  repositoryReferenceTextParts,
  repositoryRootLabel,
  sanitizeRepositoryEvidenceText,
} from "./repositoryReferences";

describe("parseExactRepositoryReference / repositoryReferenceTextParts (S8786 regression)", () => {
  it("completes within budget for a slash-run with no valid extension", () => {
    // The former `(?:segment\/)*segment` core let the star and the trailing atom both consume the
    // same characters; retried at every offset of a non-matching string this was O(n^2). At this
    // size the pre-fix implementation takes upwards of 20 SECONDS; the bounded, linear
    // implementation finishes in well under a second.
    const adversarial = "a/".repeat(60000);
    const start = Date.now();
    const parts = repositoryReferenceTextParts(adversarial);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(parts).toEqual([{ kind: "text", text: adversarial }]);
  });

  it("completes within budget for a long extensionless run (no slashes at all)", () => {
    // Even without any "/" the trailing `+\.[ext]` atom alone was retried at every offset. At this
    // size the pre-fix implementation takes upwards of 30 SECONDS.
    const adversarial = "a".repeat(150000);
    const start = Date.now();
    const parts = repositoryReferenceTextParts(adversarial);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(parts).toEqual([{ kind: "text", text: adversarial }]);
  });

  it("still parses representative valid references with capture groups intact", () => {
    expect(parseExactRepositoryReference("src/app/file.ts")).toEqual({
      label: "src/app/file.ts",
      path: "src/app/file.ts",
    });
    expect(parseExactRepositoryReference("src/app/file.ts:12")).toEqual({
      label: "src/app/file.ts:12",
      path: "src/app/file.ts",
      lineStart: 12,
      lineEnd: 12,
    });
    expect(parseExactRepositoryReference("src/app/file.ts:12-34")).toEqual({
      label: "src/app/file.ts:12-34",
      path: "src/app/file.ts",
      lineStart: 12,
      lineEnd: 34,
    });
  });

  it("still rejects representative invalid references", () => {
    expect(parseExactRepositoryReference("not-a-path")).toBeNull();
    expect(parseExactRepositoryReference("../escape/file.ts")).toBeNull();
    expect(parseExactRepositoryReference("")).toBeNull();
  });

  it("still extracts an inline reference surrounded by text unchanged", () => {
    expect(repositoryReferenceTextParts("see @src/app/file.ts:1-4 for details")).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "reference",
        reference: {
          label: "@src/app/file.ts:1-4",
          path: "src/app/file.ts",
          lineStart: 1,
          lineEnd: 4,
        },
      },
      { kind: "text", text: " for details" },
    ]);
  });

  it("recognizes an unusually deep, but real, repository path (depth bound headroom)", () => {
    // Path depth is bounded (unlike per-segment length, which is pinned to the real filesystem
    // NAME_MAX of 255) purely as an application-level ReDoS mitigation, so it must clear any
    // realistic nesting depth with room to spare — e.g. a pnpm `.pnpm` store, a Bazel sandbox path,
    // or a deeply nested vendor/cache tree. 71 levels deep (comfortably beyond any of those in
    // practice) must still resolve to a clickable reference, not silently degrade to plain text.
    const deepPath = `${Array.from({ length: 71 }, (_, i) => `dir${String(i)}`).join("/")}/file.ts`;
    expect(parseExactRepositoryReference(deepPath)).toEqual({
      label: deepPath,
      path: deepPath,
    });
    expect(repositoryReferenceTextParts(`see @${deepPath} please`)).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "reference",
        reference: { label: `@${deepPath}`, path: deepPath },
      },
      { kind: "text", text: " please" },
    ]);
  });
});

describe("sanitizeRepositoryEvidenceText (S8786 regression)", () => {
  it("completes within budget for an unterminated [source: ...] label", () => {
    // `\s*` was redundant with (and overlapped) the following `[^\]]+`; with no closing bracket
    // the engine explored every way to split a long whitespace run between the two, which was
    // quadratic. At this size the pre-fix implementation takes upwards of 8 SECONDS.
    const adversarial = `[source:${" ".repeat(150000)}`;
    const start = Date.now();
    const result = sanitizeRepositoryEvidenceText(adversarial);
    expect(Date.now() - start).toBeLessThan(1500);
    // No closing "]" anywhere, so none of the bracket/label patterns match; only the trailing
    // whitespace-collapse pass (tidyEvidenceText) touches the text, collapsing the long run to " ".
    expect(result).toBe("[source: ");
  });

  it("still strips a [source: ...] label", () => {
    expect(sanitizeRepositoryEvidenceText("value [source: api] end")).toBe("value end");
  });

  it("still collapses a bracketed-then-repeated duplicate reference", () => {
    expect(
      sanitizeRepositoryEvidenceText("[src/app/file.ts:1-4] [source: api] src/app/file.ts:1-4"),
    ).toBe("src/app/file.ts:1-4");
  });

  it("still tidies extra whitespace before punctuation", () => {
    expect(sanitizeRepositoryEvidenceText("hello  ,   world  .")).toBe("hello, world.");
  });
});

describe("repositoryRootLabel (S8786 regression)", () => {
  it("completes within budget for a long slash run with no trailing match", () => {
    // The former `.replace(/\/+$/u, "")` had no start anchor, so a string that is almost all "/"
    // but does not end in one forces the engine to retry the trailing `+` scan from every offset.
    // At this size the pre-fix implementation takes upwards of 8 SECONDS.
    const adversarial = `${"/".repeat(150000)}a`;
    const start = Date.now();
    const result = repositoryRootLabel(adversarial);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(result).toBe("a");
  });

  it("still converts backslashes and trims trailing slashes for the last path segment", () => {
    expect(repositoryRootLabel("C:\\repo\\project\\")).toBe("project");
    expect(repositoryRootLabel("/a/b///")).toBe("b");
    expect(repositoryRootLabel("solo")).toBe("solo");
  });
});

describe("normalizeReferencePath (S8786 regression)", () => {
  it("completes within budget for an interior slash run before a trailing one", () => {
    // A long interior run of "/" (not just a leading one) plus a trailing run reproduces the same
    // O(n^2) retry pattern in the trailing-slash strip even after the leading strip runs first. At
    // this size the pre-fix implementation takes upwards of 8 SECONDS.
    const adversarial = `a${"/".repeat(150000)}${"b".repeat(150000)}${"/".repeat(150000)}`;
    const start = Date.now();
    const result = normalizeReferencePath(adversarial);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(result).toBe(`a${"/".repeat(150000)}${"b".repeat(150000)}`);
  });

  it("still normalizes separators and strips leading/trailing slashes", () => {
    expect(normalizeReferencePath("\\src\\a.ts\\")).toBe("src/a.ts");
    expect(normalizeReferencePath("/src/a.ts")).toBe("src/a.ts");
    expect(normalizeReferencePath("src/a.ts")).toBe("src/a.ts");
  });
});
