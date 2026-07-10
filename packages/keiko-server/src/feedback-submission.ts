import type { PreparedFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";

export type FeedbackSubmissionPortOutcome = "accepted" | "rejected";

export interface FeedbackSubmissionPort {
  submit(prepared: PreparedFeedbackReportV1): Promise<FeedbackSubmissionPortOutcome>;
}

export type FeedbackSubmissionUiOutcome =
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "accepted" }
  | { readonly outcome: "rejected" };
