// SHA-256 step of the Keiko for Quality finding fingerprint (ADR-0182 D7, Issue #4131). The
// framed preimage and its normalization are owned by keiko-contracts, which cannot hash; this is
// the one place that turns it into the digest, so every consumer computes the same identity.

import { reviewFindingFingerprintPreimage } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";
import type { ReviewFindingReport } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { sha256Hex } from "./hashing.js";

/**
 * The content-derived, line-independent fingerprint of a finding: SHA-256 over the framed
 * normalized file path, category and `defect` excerpt. `defectExcerpt` is the code the finding's
 * `defect` evidence names in the reviewed commit, read by the caller from the Git object.
 */
export function computeReviewFindingFingerprint(
  report: Pick<ReviewFindingReport, "file" | "category">,
  defectExcerpt: string,
): string {
  return sha256Hex(
    reviewFindingFingerprintPreimage({
      file: report.file,
      category: report.category,
      defectExcerpt,
    }),
  );
}
