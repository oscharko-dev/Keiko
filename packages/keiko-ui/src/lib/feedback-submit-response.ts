import {
  isFeedbackReceiptExpiryV1,
  isFeedbackReceiptIdV1,
  isFeedbackReceiptSecretV1,
} from "@oscharko-dev/keiko-contracts/feedback-intake";

const OUTCOMES = new Set<unknown>(["unavailable", "accepted", "rejected", "rate-limited"]);

export interface FeedbackReceiptV1 {
  readonly receiptId: string;
  readonly receiptSecret: string;
  readonly expiresAt: string;
}

export type FeedbackSubmitOutcomeV1 =
  | { readonly outcome: "unavailable" }
  | {
      readonly outcome: "accepted";
      readonly receipt: FeedbackReceiptV1;
    }
  | { readonly outcome: "rejected" }
  | { readonly outcome: "rate-limited" };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function accepted(value: Record<string, unknown>): FeedbackSubmitOutcomeV1 | undefined {
  if (!exactKeys(value, ["outcome", "receipt"])) return undefined;
  const receipt = record(value.receipt);
  if (receipt === undefined || !exactKeys(receipt, ["receiptId", "receiptSecret", "expiresAt"])) {
    return undefined;
  }
  if (!isFeedbackReceiptIdV1(receipt.receiptId)) return undefined;
  if (!isFeedbackReceiptSecretV1(receipt.receiptSecret)) return undefined;
  if (!isFeedbackReceiptExpiryV1(receipt.expiresAt)) return undefined;
  return Object.freeze({
    outcome: "accepted",
    receipt: Object.freeze({
      receiptId: receipt.receiptId,
      receiptSecret: receipt.receiptSecret,
      expiresAt: receipt.expiresAt,
    }),
  });
}

export function parseFeedbackSubmitOutcomeV1(value: unknown): FeedbackSubmitOutcomeV1 | undefined {
  const parsed = record(value);
  if (parsed === undefined || !OUTCOMES.has(parsed.outcome)) return undefined;
  if (parsed.outcome === "accepted") return accepted(parsed);
  return exactKeys(parsed, ["outcome"])
    ? (Object.freeze({ outcome: parsed.outcome }) as FeedbackSubmitOutcomeV1)
    : undefined;
}
