import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  decodeFeedbackBase64UrlV1,
  FEEDBACK_RECEIPT_SECRET_BYTES_V1,
} from "@oscharko-dev/keiko-contracts/feedback-intake";
import type { FeedbackReportV1 } from "@oscharko-dev/keiko-contracts/feedback-report";
import { canonicalise } from "@oscharko-dev/keiko-security";

function hmac(key: Uint8Array, domain: string, bytes: Uint8Array): string {
  return createHmac("sha256", key)
    .update(domain, "utf8")
    .update(new Uint8Array([0]))
    .update(bytes)
    .digest("hex");
}

export function abuseIdentity(key: Uint8Array, address: Uint8Array): string {
  return hmac(key, "keiko-feedback-abuse-v1", address);
}

export function semanticBytes(report: FeedbackReportV1): Uint8Array {
  const semantic = {
    schemaVersion: report.schemaVersion,
    privacyContractVersion: report.privacyContractVersion,
    productVersion: report.productVersion,
    platform: report.platform,
    ...(report.browserDescription === undefined
      ? {}
      : { browserDescription: report.browserDescription }),
    summary: report.summary,
    steps: report.steps,
    expectedResult: report.expectedResult,
    actualResult: report.actualResult,
    impact: report.impact,
    ...(report.handwrittenEvidence === undefined
      ? {}
      : { handwrittenEvidence: report.handwrittenEvidence }),
    ...(report.attachments === undefined ? {} : { attachments: report.attachments }),
    diagnostics: report.diagnostics,
  };
  return new TextEncoder().encode(`keiko-feedback-semantic-v1\n${canonicalise(semantic)}`);
}

export function dedupeIdentity(key: Uint8Array, report: FeedbackReportV1): string {
  return hmac(key, "keiko-feedback-dedupe-v1", semanticBytes(report));
}

export function receiptHash(secret: string): string | undefined {
  const bytes = decodeFeedbackBase64UrlV1(secret, FEEDBACK_RECEIPT_SECRET_BYTES_V1);
  return bytes === undefined ? undefined : receiptHashBytes(bytes);
}

export function receiptHashBytes(secretBytes: Uint8Array): string {
  return createHash("sha256")
    .update("keiko-feedback-receipt-v1", "utf8")
    .update(new Uint8Array([0]))
    .update(secretBytes)
    .digest("hex");
}

export function capability(): { readonly id: string; readonly secret: string } {
  return {
    id: randomBytes(16).toString("base64url"),
    secret: randomBytes(32).toString("base64url"),
  };
}

export function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  const paddedA = a.length === 32 ? a : Buffer.alloc(32);
  const paddedB = b.length === 32 ? b : Buffer.alloc(32);
  return timingSafeEqual(paddedA, paddedB) && a.length === 32 && b.length === 32;
}
