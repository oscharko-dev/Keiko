export const FEEDBACK_INTAKE_REPORT_PATH_V1 = "/v1/feedback/reports";
export const FEEDBACK_INTAKE_RECEIPT_PATH_PREFIX_V1 = "/v1/feedback/receipts/";
export const FEEDBACK_BODY_SHA256_HEADER_V1 = "Keiko-Feedback-Body-SHA256";
export const FEEDBACK_RECEIPT_AUTH_SCHEME_V1 = "Keiko-Receipt";
export const FEEDBACK_RECEIPT_ID_BYTES_V1 = 16;
export const FEEDBACK_RECEIPT_SECRET_BYTES_V1 = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function validBase64UrlShape(value: string, expectedBytes: number): boolean {
  const expectedLength = Math.ceil((expectedBytes * 8) / 6);
  return BASE64URL.test(value) && !value.includes("=") && value.length === expectedLength;
}

export function decodeFeedbackBase64UrlV1(
  value: string,
  expectedBytes: number,
): Uint8Array | undefined {
  if (!validBase64UrlShape(value, expectedBytes)) return undefined;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const output = new Uint8Array(expectedBytes);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) return undefined;
    buffer = buffer * 64 + index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (offset < output.length) output[offset] = (buffer >> bits) & 255;
      offset += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  if (offset !== expectedBytes) return undefined;
  if (bits > 0 && buffer !== 0) return undefined;
  return output;
}

export function isFeedbackReceiptIdV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    decodeFeedbackBase64UrlV1(value, FEEDBACK_RECEIPT_ID_BYTES_V1) !== undefined
  );
}

export function isFeedbackReceiptSecretV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    decodeFeedbackBase64UrlV1(value, FEEDBACK_RECEIPT_SECRET_BYTES_V1) !== undefined
  );
}

export function isFeedbackReceiptExpiryV1(value: unknown): value is string {
  if (typeof value !== "string" || !RFC3339_UTC.test(value)) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const canonical = new Date(time).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

export interface FeedbackIntakeReceiptCapabilityV1 {
  readonly receiptId: string;
  readonly receiptSecret: string;
  readonly expiresAt: string;
}

export interface FeedbackIntakeReceiptStatusV1 {
  readonly receiptId: string;
  readonly status: "received" | "closed";
  readonly expiresAt: string;
}

export type FeedbackIntakeErrorCodeV1 =
  | "invalid-request"
  | "payload-too-large"
  | "unsupported-media"
  | "report-rejected"
  | "rate-limited"
  | "temporarily-unavailable";

export interface FeedbackIntakeErrorV1 {
  readonly error: FeedbackIntakeErrorCodeV1;
  readonly message?: "Try again later." | undefined;
}
