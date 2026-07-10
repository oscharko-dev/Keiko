import { FeedbackApiError } from "./feedback-api-errors";

const SECURITY_ERROR_KEYS = new Set(["error"]);
const ERROR_KEYS = new Set(["code", "message"]);
const REVALIDATION_KEYS = new Set(["outcome"]);
const REVALIDATION_OUTCOMES = new Set<unknown>(["valid", "rejected", "security"]);

export type FeedbackRevalidationOutcomeV1 =
  | { readonly outcome: "valid" }
  | { readonly outcome: "rejected" }
  | { readonly outcome: "security" };

export class FeedbackSecurityRoutingError extends FeedbackApiError {
  public constructor() {
    super("Use the private security reporting route.");
    this.name = "FeedbackSecurityRoutingError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.size &&
    keys.every((key) => typeof key === "string" && expected.has(key))
  );
}

export function isFeedbackSecurityRoutingResponse(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, SECURITY_ERROR_KEYS)) return false;
  const error = value.error;
  return (
    isPlainRecord(error) &&
    hasExactKeys(error, ERROR_KEYS) &&
    error.code === "FEEDBACK_SECURITY_REPORT" &&
    error.message === "Use the private security reporting route."
  );
}

async function postRevalidation(body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch("/api/feedback/revalidate", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new FeedbackApiError();
  }
  try {
    if (!response.ok) throw new FeedbackApiError();
    return (await response.json()) as unknown;
  } catch {
    throw new FeedbackApiError();
  }
}

export async function revalidateFeedbackReportV1(prepared: {
  readonly canonicalJson: string;
  readonly exactBodySha256: string;
}): Promise<FeedbackRevalidationOutcomeV1> {
  const value = await postRevalidation({
    canonicalJson: prepared.canonicalJson,
    exactBodySha256: prepared.exactBodySha256,
  });
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, REVALIDATION_KEYS) ||
    !REVALIDATION_OUTCOMES.has(value.outcome)
  ) {
    throw new FeedbackApiError();
  }
  return Object.freeze({ outcome: value.outcome }) as FeedbackRevalidationOutcomeV1;
}
