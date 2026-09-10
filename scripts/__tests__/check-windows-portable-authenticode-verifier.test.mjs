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

  it("rejects malformed compiler and framework-reference pins before regeneration", () => {
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        compilerDistribution: null,
      }),
    ).toThrow(/compiler-distribution pin/u);
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        referenceSha256: {
          ...COMMITTED_VERIFIER_ASSET.referenceSha256,
          "System.Core.dll": "not-a-digest",
        },
      }),
    ).toThrow(/System.Core.dll pin/u);
  });

  it.each([
    ["non-base64 assembly text", { assemblyBase64: "not base64!" }, /assembly encoding/u],
    ["a zero assembly byte length", { assemblyByteLength: 0 }, /assembly encoding/u],
    ["a noncanonical assembly digest", { assemblySha256: "A".repeat(64) }, /assembly digest/u],
    ["a noncanonical source digest", { sourceSha256: "A".repeat(64) }, /source digest/u],
    ["a noncanonical compiler digest", { compilerSha256: "A".repeat(64) }, /compiler pin/u],
    [
      "an empty compiler distribution receipt",
      {
        compilerDistribution: {
          ...COMMITTED_VERIFIER_ASSET.compilerDistribution,
          fileCount: 0,
        },
      },
      /compiler-distribution pin/u,
    ],
    [
      "a missing framework-reference receipt",
      {
        referenceSha256: {
          ...COMMITTED_VERIFIER_ASSET.referenceSha256,
          "System.dll": undefined,
        },
      },
      /System\.dll pin/u,
    ],
  ])("rejects %s", (_label, override, expectedError) => {
    expect(() =>
      assertCommittedVerifierAsset({
        ...COMMITTED_VERIFIER_ASSET,
        ...override,
      }),
    ).toThrow(expectedError);
  });
});
