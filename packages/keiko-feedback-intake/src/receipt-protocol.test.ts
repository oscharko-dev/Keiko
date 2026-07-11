import {
  decodeFeedbackBase64UrlV1,
  FEEDBACK_RECEIPT_ID_BYTES_V1,
  FEEDBACK_RECEIPT_SECRET_BYTES_V1,
} from "@oscharko-dev/keiko-contracts/feedback-intake";
import { describe, expect, it } from "vitest";
import { capability, receiptHash, receiptHashBytes } from "./crypto.js";

describe("receipt byte protocol", () => {
  it("generates fresh capabilities from exactly 16-byte ids and 32-byte secrets", () => {
    const first = capability();
    const second = capability();
    expect(decodeFeedbackBase64UrlV1(first.id, FEEDBACK_RECEIPT_ID_BYTES_V1)).toHaveLength(16);
    expect(decodeFeedbackBase64UrlV1(first.secret, FEEDBACK_RECEIPT_SECRET_BYTES_V1)).toHaveLength(
      32,
    );
    expect(first).not.toEqual(second);
  });

  it("freezes the domain-separated unkeyed SHA-256 fixture", () => {
    const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const expected = "73e1bc27fec9bf8f649414dd13a41d6a2bb7394297b1ff67d9b56d2537eea4ff";
    expect(receiptHash(secret)).toBe(expected);
    expect(receiptHashBytes(new Uint8Array(32))).toBe(expected);
    expect(receiptHash(`${secret}=`)).toBeUndefined();
  });
});
