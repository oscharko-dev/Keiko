import { describe, expect, it } from "vitest";
import {
  decodeFeedbackBase64UrlV1,
  isFeedbackReceiptExpiryV1,
  isFeedbackReceiptIdV1,
  isFeedbackReceiptSecretV1,
} from "./feedback-intake.js";

describe("feedback intake receipt wire contract", () => {
  it("decodes exact unpadded base64url byte lengths", () => {
    expect(isFeedbackReceiptIdV1("AAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
    expect(isFeedbackReceiptSecretV1("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
    expect(decodeFeedbackBase64UrlV1("_____________________w", 16)).toEqual(
      new Uint8Array(16).fill(255),
    );
  });

  it.each([
    "AAAAAAAAAAAAAAAAAAAAA=",
    "AAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAA+",
  ])("rejects malformed or wrong-length receipt ids: %s", (value) => {
    expect(isFeedbackReceiptIdV1(value)).toBe(false);
  });

  it("accepts only canonical RFC3339 UTC expiry timestamps", () => {
    expect(isFeedbackReceiptExpiryV1("2026-08-10T00:00:00.000Z")).toBe(true);
    expect(isFeedbackReceiptExpiryV1("2026-08-10T00:00:00Z")).toBe(true);
    expect(isFeedbackReceiptExpiryV1("2026-08-10T00:00:00+00:00")).toBe(false);
    expect(isFeedbackReceiptExpiryV1("2026-02-30T00:00:00Z")).toBe(false);
  });
});
