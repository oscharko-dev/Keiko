import type { FeedbackReportPreparationError } from "@oscharko-dev/keiko-contracts/feedback-report";

import type { FeedbackReportRedactionPolicyV1 } from "./feedback-report-policy.js";
import { verifyCanonicalFeedbackReportBodyV1 } from "./feedback-report-verifier.js";

export function canonicalFeedbackReportParityError(
  bytes: Uint8Array,
  digest: string,
  policy: FeedbackReportRedactionPolicyV1,
): FeedbackReportPreparationError | undefined {
  const verified = verifyCanonicalFeedbackReportBodyV1({ bytes, claimedDigest: digest, policy });
  if (verified.ok) return undefined;
  return verified.error.code === "unsafe-content"
    ? { code: "residual-sensitive-content", field: "report" }
    : { code: "invalid-shape", field: "report" };
}
