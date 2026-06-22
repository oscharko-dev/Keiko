// Architecture invariant: bidi / zero-width / format-char sanitisation at persist/egress sinks.
//
// WHY THIS FILE EXISTS
// Several release-hardening passes (PRs #1095, #1099, WP-REVIEW, WP-GROUNDING) fixed gaps where
// bidi/zero-width/format characters survived into persisted data or server egress.  This test pins
// each confirmed sink so that a future edit removing a sanitiser import or call fails CI immediately.
//
// HOW TO EXTEND
// When you add a new persist/egress text sink (a route handler that writes user-supplied text to a
// store, a stream that emits text to a client, or a function that serialises text to a file), add an
// entry to SINKS below.  Pick the sanitiser that is already used in that file:
//   • normaliseCandidateText  — QI domain / route layer (NFKC + bidi/ZW strip + trim)
//   • stripUnsafeFormatChars  — general-purpose egress / grounding layer
// Do NOT assert a sanitiser that the file does not actually import and call.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Sink {
  /** Relative path from repo root (forward slashes). */
  readonly file: string;
  /** Exact symbol that must appear in the file source. */
  readonly sanitiser: string;
}

// Extend this list whenever a new persist/egress text sink is added to the codebase.
const SINKS: readonly Sink[] = [
  {
    file: "packages/keiko-quality-intelligence/src/domain/deduplication.ts",
    sanitiser: "normaliseCandidateText",
  },
  {
    file: "packages/keiko-quality-intelligence/src/domain/validation.ts",
    sanitiser: "normaliseCandidateText",
  },
  {
    file: "packages/keiko-quality-intelligence/src/generation/parseGeneratedCandidates.ts",
    sanitiser: "normaliseCandidateText",
  },
  {
    file: "packages/keiko-server/src/qualityIntelligence/editRoutes.ts",
    sanitiser: "normaliseCandidateText",
  },
  {
    file: "packages/keiko-server/src/qualityIntelligence/reviewRoutes.ts",
    sanitiser: "normaliseCandidateText",
  },
  {
    file: "packages/keiko-server/src/local-knowledge-grounded-qa.ts",
    sanitiser: "stripUnsafeFormatChars",
  },
];

describe("text-safety sinks invariant", () => {
  for (const { file, sanitiser } of SINKS) {
    it(`${file} references ${sanitiser}`, () => {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      expect(
        source.includes(sanitiser),
        `Expected "${sanitiser}" to appear in ${file} — was the sanitiser removed from a persist/egress sink?`,
      ).toBe(true);
    });
  }
});
