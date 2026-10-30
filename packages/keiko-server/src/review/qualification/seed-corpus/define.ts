// Construction helpers of the synthetic review seed corpus (Issue #4132, ADR-0182 D9). A corpus
// case is data: a small generated repository before and after one change. A defect case's expected
// location is derived from the planted text itself, so the recorded range can never drift from the
// fixture it describes; a planted text that is absent or ambiguous fails when the module loads.

import type { ReviewFindingCategory, ReviewSeedFixture } from "@oscharko-dev/keiko-contracts";

export const REVIEW_SEED_DEFECT_KINDS = [
  "removed-authorization-guard",
  "swallowed-error",
  "missing-await",
  "off-by-one-boundary",
  "nullish-dereference-after-optional",
  "path-traversal-in-file-read",
  "unchecked-input-to-sensitive-sink",
  "resource-not-released-on-error-path",
  "inverted-condition",
] as const;
export type ReviewSeedDefectKind = (typeof REVIEW_SEED_DEFECT_KINDS)[number];

/** One shippable corpus case: the scored fixture plus what it plants, for qualification reports. */
export interface ReviewSeedCorpusEntry extends ReviewSeedFixture {
  readonly kind: ReviewSeedDefectKind | "clean-control";
  readonly summary: string;
}

type Files = Readonly<Record<string, string>>;

function plantedRange(content: string, planted: string): { startLine: number; endLine: number } {
  const at = content.indexOf(planted);
  if (at === -1 || content.includes(planted, at + 1)) {
    throw new Error("review seed corpus: a planted text must occur exactly once in its file");
  }
  const startLine = content.slice(0, at).split("\n").length;
  return { startLine, endLine: startLine + planted.replace(/\n$/u, "").split("\n").length - 1 };
}

/** A case with one planted defect in `file`; `planted` is the defective text in the head tree. */
export function defectCase(input: {
  readonly id: string;
  readonly kind: ReviewSeedDefectKind;
  readonly seedClass: ReviewFindingCategory;
  readonly file: string;
  readonly planted: string;
  readonly baseFiles: Files;
  readonly headFiles: Files;
  readonly summary: string;
}): ReviewSeedCorpusEntry {
  const head = input.headFiles[input.file];
  if (head === undefined)
    throw new Error(`review seed corpus: ${input.id} has no head ${input.file}`);
  return {
    seed: {
      id: input.id,
      seedClass: input.seedClass,
      required: true,
      cleanControl: false,
      expected: { file: input.file, ...plantedRange(head, input.planted) },
    },
    scope: "repository",
    baseFiles: input.baseFiles,
    headFiles: input.headFiles,
    kind: input.kind,
    summary: input.summary,
  };
}

/** A clean control: a harmless change on which any presented finding is a false alarm. */
export function cleanControl(input: {
  readonly id: string;
  readonly baseFiles: Files;
  readonly headFiles: Files;
  readonly summary: string;
}): ReviewSeedCorpusEntry {
  return {
    seed: { id: input.id, seedClass: "maintainability", required: false, cleanControl: true },
    scope: "repository",
    baseFiles: input.baseFiles,
    headFiles: input.headFiles,
    kind: "clean-control",
    summary: input.summary,
  };
}
