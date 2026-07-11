import type { PreparedFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";

export interface FeedbackSubmissionReceipt {
  readonly receiptId: string;
  readonly receiptSecret: string;
  readonly expiresAt: string;
}

export type FeedbackSubmissionPortOutcome =
  | "rejected"
  | "rate-limited"
  | { readonly outcome: "accepted"; readonly receipt: FeedbackSubmissionReceipt };

export interface FeedbackSubmissionPort {
  submit(prepared: PreparedFeedbackReportV1): Promise<FeedbackSubmissionPortOutcome>;
}

export type FeedbackSubmissionUiOutcome =
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "accepted"; readonly receipt: FeedbackSubmissionReceipt }
  | { readonly outcome: "rejected" }
  | { readonly outcome: "rate-limited" };
