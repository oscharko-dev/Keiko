const CANONICAL_FEEDBACK_REVIEW_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isCanonicalFeedbackReviewId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_FEEDBACK_REVIEW_ID.test(value);
}
