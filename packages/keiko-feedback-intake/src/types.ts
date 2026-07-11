import type {
  FeedbackIntakeErrorV1,
  FeedbackIntakeReceiptCapabilityV1,
  FeedbackIntakeReceiptStatusV1,
} from "@oscharko-dev/keiko-contracts/feedback-intake";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const OPEN_ITEM_LIFETIME_MS = 90 * DAY_MS;
export const RECEIPT_LIFETIME_MS = 30 * DAY_MS;
export const DEDUPE_LIFETIME_MS = 180 * DAY_MS;
export const ABUSE_LIFETIME_MS = 48 * HOUR_MS;

export interface IntakeLimits {
  readonly perIdentity: number;
  readonly global: number;
  readonly concurrency: number;
  readonly receiptConcurrency: number;
  readonly openPayloadCount: number;
  readonly openPayloadBytes: number;
  readonly proxyHops: number;
  readonly bodyBytes: number;
  readonly headerBytes: number;
  readonly bodyDeadlineMs: number;
  readonly storageDeadlineMs: number;
}

export interface IntakeSecretKey {
  readonly id: string;
  readonly key: Uint8Array;
  readonly activatedAt: Date;
}

export interface IntakeSecretSnapshot {
  readonly active: IntakeSecretKey;
  readonly predecessors: readonly IntakeSecretKey[];
}

export interface IntakeSecretProvider {
  snapshot(now: Date): IntakeSecretSnapshot;
}

export interface ContentFreeLogger {
  event(name: "accepted" | "rejected" | "rate-limited" | "unavailable"): void;
}

export interface ContentFreeMetrics {
  increment(name: "accepted" | "rejected" | "rate_limited" | "unavailable"): void;
}

export type SubmitResult =
  | { readonly status: 202; readonly body: FeedbackIntakeReceiptCapabilityV1 }
  | { readonly status: 400 | 413 | 415 | 422 | 503; readonly body: FeedbackIntakeErrorV1 }
  | {
      readonly status: 429;
      readonly body: FeedbackIntakeErrorV1 & { readonly message: "Try again later." };
      readonly retryAfterSeconds: number;
    };

export type ReceiptResult =
  | { readonly status: 200; readonly body: FeedbackIntakeReceiptStatusV1 }
  | { readonly status: 404; readonly body: FeedbackIntakeErrorV1 };

export interface IntakeInspection {
  readonly payloadCount: number;
  readonly receiptCount: number;
  readonly dedupeCount: number;
  readonly abuseBucketCount: number;
}
