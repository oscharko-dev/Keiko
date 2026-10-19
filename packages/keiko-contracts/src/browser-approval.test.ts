import { createPublicKey, verify, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BROWSER_APPROVAL_CHALLENGE_TTL_MS,
  browserApprovalChallengeText,
  isBrowserApprovalPublicKey,
  validateBrowserApprovalChallenge,
  validateBrowserApprovalChallengeInput,
  validateBrowserApprovalDecisionInput,
  validateBrowserApprovalProofInput,
  validateBrowserApprovalRequestInput,
  type BrowserApprovalChallenge,
} from "./browser-approval.js";

function challenge(): BrowserApprovalChallenge {
  return {
    schemaVersion: 1,
    challengeId: `bch_${"a".repeat(32)}`,
    purpose: "complete",
    subjectId: `brq_${"b".repeat(32)}`,
    installationId: "c".repeat(32),
    serverInstanceId: "d".repeat(32),
    origin: "http://127.0.0.1:1983",
    nonce: "A".repeat(43),
    issuedAtMs: 1_000,
    expiresAtMs: 1_000 + BROWSER_APPROVAL_CHALLENGE_TTL_MS,
  };
}

describe("browser approval wire boundaries", () => {
  it("accepts only public canonical coordinates and explicit remember intent", () => {
    const publicKey = { x: "A".repeat(43), y: "A".repeat(43) };
    expect(validateBrowserApprovalRequestInput({ publicKey, remember: false }).ok).toBe(true);
    expect(validateBrowserApprovalRequestInput({ publicKey }).ok).toBe(false);
    expect(isBrowserApprovalPublicKey({ ...publicKey, d: "A".repeat(43) })).toBe(false);
    expect(isBrowserApprovalPublicKey({ ...publicKey, x: `${"A".repeat(42)}B` })).toBe(false);
    expect(isBrowserApprovalPublicKey({ ...publicKey, kty: "RSA" })).toBe(false);
  });

  it("binds explicit decisions to one request and comparison code", () => {
    const decision = {
      requestId: `brq_${"a".repeat(32)}`,
      comparisonCode: "01234567",
      remember: false,
    };
    expect(validateBrowserApprovalDecisionInput(decision).ok).toBe(true);
    expect(
      validateBrowserApprovalDecisionInput({ ...decision, comparisonCode: "1234567" }).ok,
    ).toBe(false);
    expect(validateBrowserApprovalDecisionInput({ ...decision, remember: "true" }).ok).toBe(false);
    expect(validateBrowserApprovalDecisionInput({ ...decision, authority: "full-access" }).ok).toBe(
      false,
    );
  });

  it.each([
    { purpose: "complete", subjectId: `bra_${"a".repeat(32)}` },
    { purpose: "renew", subjectId: `brq_${"a".repeat(32)}` },
    { purpose: "approve", subjectId: `brq_${"a".repeat(32)}` },
    { purpose: "renew", subjectId: "../approval" },
  ])("refuses cross-purpose or malformed subjects: $purpose", (value) => {
    expect(validateBrowserApprovalChallengeInput(value).ok).toBe(false);
  });

  it.each([
    { origin: "http://127.0.0.1:1983/path" },
    { origin: "http://user@127.0.0.1:1983" },
    { origin: "https://example.invalid" },
    { origin: "http://127.0.0.1:1983#fragment" },
    { nonce: `${"A".repeat(42)}B` },
    { expiresAtMs: 1_000 },
    { expiresAtMs: 1_001 + BROWSER_APPROVAL_CHALLENGE_TTL_MS },
    { issuedAtMs: Number.NaN },
    { serverInstanceId: "foreign" },
    { schemaVersion: 2 },
  ])("refuses malformed or unbounded challenge fields: %j", (patch) => {
    expect(validateBrowserApprovalChallenge({ ...challenge(), ...patch }).ok).toBe(false);
  });

  it("refuses noncanonical signature bytes before cryptographic verification", () => {
    const proof = { challengeId: challenge().challengeId, signature: "A".repeat(86) };
    expect(validateBrowserApprovalProofInput(proof).ok).toBe(true);
    expect(
      validateBrowserApprovalProofInput({ ...proof, signature: `${"A".repeat(85)}B` }).ok,
    ).toBe(false);
    expect(validateBrowserApprovalProofInput({ ...proof, signature: "A".repeat(85) }).ok).toBe(
      false,
    );
    expect(validateBrowserApprovalProofInput({ ...proof, publicKey: {} }).ok).toBe(false);
  });
});

describe("browser/server proof interoperability", () => {
  it("verifies real WebCrypto signatures and rejects every changed authority binding", async () => {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const jwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
    const value = challenge();
    expect(validateBrowserApprovalChallenge(value).ok).toBe(true);
    const bytes = new TextEncoder().encode(browserApprovalChallengeText(value));
    const signed = Buffer.from(
      await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, bytes),
    );
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const options = { key: publicKey, dsaEncoding: "ieee-p1363" as const };
    expect(verify("sha256", bytes, options, signed)).toBe(true);
    expect(
      validateBrowserApprovalProofInput({
        challengeId: value.challengeId,
        signature: signed.toString("base64url"),
      }).ok,
    ).toBe(true);
    for (const patch of changedBindings()) {
      expect(
        verify(
          "sha256",
          new TextEncoder().encode(browserApprovalChallengeText({ ...value, ...patch })),
          options,
          signed,
        ),
      ).toBe(false);
    }
  });
});

function changedBindings(): readonly Partial<BrowserApprovalChallenge>[] {
  return [
    { purpose: "renew" },
    { subjectId: `bra_${"e".repeat(32)}` },
    { challengeId: `bch_${"e".repeat(32)}` },
    { installationId: "e".repeat(32) },
    { serverInstanceId: "e".repeat(32) },
    { origin: "http://127.0.0.1:1984" },
    { nonce: "B".repeat(42) + "A" },
    { issuedAtMs: 1_001 },
    { expiresAtMs: 2_000 },
  ];
}
