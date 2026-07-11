import {
  gatewayFetch,
  type GatewayFetchOptions,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import {
  isFeedbackReceiptExpiryV1,
  isFeedbackReceiptIdV1,
  isFeedbackReceiptSecretV1,
} from "@oscharko-dev/keiko-contracts/feedback-intake";
import type { PreparedFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";
import type {
  FeedbackSubmissionPort,
  FeedbackSubmissionPortOutcome,
  FeedbackSubmissionReceipt,
} from "./feedback-submission.js";

const INTAKE_PATH = "/v1/feedback/reports";
const MAX_RECEIPT_RESPONSE_BYTES = 2_048;
const RECEIPT_KEYS = new Set(["receiptId", "receiptSecret", "expiresAt"]);

type FeedbackFetch = (url: string, options: GatewayFetchOptions) => Promise<Response>;

export interface FeedbackSubmissionHttpOptions {
  readonly origin: string | undefined;
  readonly timeoutMs: number;
  readonly egress?: GatewayFetchOptions["egress"] | undefined;
  readonly fetch?: FeedbackFetch | undefined;
}

export function exactFeedbackIntakeOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.includes("*") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    )
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function receipt(value: unknown): FeedbackSubmissionReceipt | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !Object.keys(record).every((key) => RECEIPT_KEYS.has(key))
  )
    return undefined;
  if (!validReceiptFields(record)) return undefined;
  return {
    receiptId: record.receiptId,
    receiptSecret: record.receiptSecret,
    expiresAt: record.expiresAt,
  };
}

function validReceiptFields(
  record: Record<string, unknown>,
): record is Record<"receiptId" | "receiptSecret" | "expiresAt", string> {
  if (!isFeedbackReceiptIdV1(record.receiptId)) {
    return false;
  }
  if (!isFeedbackReceiptSecretV1(record.receiptSecret)) {
    return false;
  }
  return isFeedbackReceiptExpiryV1(record.expiresAt);
}

export function createFeedbackSubmissionHttpPort(
  options: FeedbackSubmissionHttpOptions,
): FeedbackSubmissionPort | undefined {
  const origin = exactFeedbackIntakeOrigin(options.origin);
  if (origin === undefined || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    return undefined;
  const fetcher = options.fetch ?? gatewayFetch;
  return { submit: (prepared) => submit(fetcher, origin, options, prepared) };
}

async function submit(
  fetcher: FeedbackFetch,
  origin: string,
  options: FeedbackSubmissionHttpOptions,
  prepared: PreparedFeedbackReportV1,
): Promise<FeedbackSubmissionPortOutcome> {
  const response = await fetcher(`${origin}${INTAKE_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Keiko-Feedback-Body-SHA256": prepared.exactBodySha256,
    },
    body: Buffer.from(prepared.canonicalBody.copyBytes()),
    credentials: "omit",
    redirect: "manual",
    timeoutMs: options.timeoutMs,
    maxResponseBytes: MAX_RECEIPT_RESPONSE_BYTES,
    ...(options.egress === undefined ? {} : { egress: options.egress }),
  });
  if (response.status >= 300 && response.status < 400)
    throw new Error("Feedback redirect rejected");
  if ([400, 413, 415, 422].includes(response.status)) return "rejected";
  if (response.status === 429) return "rate-limited";
  if (response.status !== 202) throw new Error("Feedback submission unavailable");
  const parsed = receipt(await response.json());
  if (parsed === undefined) throw new Error("Feedback receipt invalid");
  return { outcome: "accepted", receipt: parsed };
}
import { Buffer } from "node:buffer";
