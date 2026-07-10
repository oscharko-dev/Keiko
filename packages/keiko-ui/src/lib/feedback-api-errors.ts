export class FeedbackApiError extends Error {
  public constructor(message = "The feedback response failed validation.") {
    super(message);
    this.name = "FeedbackApiError";
  }
}
