// The synthetic review seed corpus (Issue #4132, ADR-0182 D9): nine planted-defect cases and three
// clean controls in small generated repositories, shipped with the server so customer pair
// qualification (Issue #4137) can run it, and scored with `scoreReviewSeedRun` — the same rule the
// development seed gate in keiko-evaluations applies.

import type { ReviewSeedCase } from "@oscharko-dev/keiko-contracts";

import { REVIEW_SEED_CLEAN_CONTROLS } from "./clean-controls.js";
import { REVIEW_SEED_DEFECT_CASES } from "./defect-cases.js";
import type { ReviewSeedCorpusEntry } from "./define.js";

export { REVIEW_SEED_DEFECT_KINDS } from "./define.js";
export type { ReviewSeedCorpusEntry, ReviewSeedDefectKind } from "./define.js";
export { materializeReviewSeedTree, planReviewSeedTree } from "./materialize.js";
export type { ReviewSeedTreeEntry, ReviewSeedTreeWriter } from "./materialize.js";

export const REVIEW_SEED_CORPUS: readonly ReviewSeedCorpusEntry[] = Object.freeze([
  ...REVIEW_SEED_DEFECT_CASES,
  ...REVIEW_SEED_CLEAN_CONTROLS,
]);

/** The scored cases alone, in corpus order, as `scoreReviewSeedRun` takes them. */
export const REVIEW_SEED_CORPUS_CASES: readonly ReviewSeedCase[] = Object.freeze(
  REVIEW_SEED_CORPUS.map((entry) => entry.seed),
);
