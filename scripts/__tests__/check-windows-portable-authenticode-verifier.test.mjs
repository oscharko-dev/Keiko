import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  COMMITTED_VERIFIER_ASSET,
  assertCommittedVerifierAsset,
} from "../check-windows-portable-authenticode-verifier.mjs";

describe("committed Windows portable Authenticode verifier asset", () => {
  it("binds the canonical source and exact assembly bytes to SHA-256", () => {
    expect(assertCommittedVerifierAsset(COMMITTED_VERIFIER_ASSET)).toHaveLength(
      COMMITTED_VERIFIER_ASSET.assemblyByteLength,
    );
  });

  it("rejects corrupt, truncated, and source-mismatched generated assets", () => {
    const bytes = Buffer.from(COMMITTED_VERIFIER_ASSET.assemblyBase64, "base64");
    const corrupt = Buffer.from(bytes);
    corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        assemblyBase64: corrupt.toString("base64"),
      }),
    ).toThrow(/assembly digest/u);
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        assemblyBase64: bytes.subarray(0, bytes.length - 1).toString("base64"),
      }),
    ).toThrow(/assembly digest/u);
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        source: `${COMMITTED_VERIFIER_ASSET.source}\n`,
      }),
    ).toThrow(/source digest/u);
  });
});
