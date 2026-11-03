import { createPublicKey, verify, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserApprovalChallengeText,
  type BrowserApprovalChallenge,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  createBrowserApprovalKey,
  isBrowserApprovalPrivateKey,
  signBrowserApprovalChallenge,
} from "./browser-approval-crypto";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "./client-diagnostics";

const AT = 1_800_000_000_000;
const BINDING_CHANGES: readonly Partial<BrowserApprovalChallenge>[] = [
  { purpose: "complete", subjectId: `brq_${"b".repeat(32)}` },
  { subjectId: `bra_${"e".repeat(32)}` },
  { origin: "http://127.0.0.1:1984" },
  { installationId: "e".repeat(32) },
];

function challenge(): BrowserApprovalChallenge {
  return {
    schemaVersion: 1,
    challengeId: `bch_${"a".repeat(32)}`,
    purpose: "renew",
    subjectId: `bra_${"b".repeat(32)}`,
    installationId: "c".repeat(32),
    serverInstanceId: "d".repeat(32),
    origin: "http://127.0.0.1:1983",
    nonce: "A".repeat(43),
    issuedAtMs: AT,
    expiresAtMs: AT + 60_000,
  };
}

function binding(): {
  readonly purpose: "renew";
  readonly subjectId: string;
  readonly origin: string;
  readonly installationId: string;
} {
  const value = challenge();
  return {
    purpose: "renew",
    subjectId: value.subjectId,
    origin: value.origin,
    installationId: value.installationId,
  };
}

describe("browser approval cryptographic owner", () => {
  beforeEach(async () => {
    const nativeKey = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("CryptoKey", nativeKey.privateKey.constructor);
    vi.spyOn(Date, "now").mockReturnValue(AT + 1);
    setClientDiagnosticWriter(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetClientDiagnosticWriter();
  });

  it("creates a nonextractable private key and verifies the actual canonical server signature", async () => {
    const key = await createBrowserApprovalKey();
    expect(isBrowserApprovalPrivateKey(key.privateKey)).toBe(true);
    let privateExportSucceeded = false;
    try {
      await crypto.subtle.exportKey("jwk", key.privateKey);
      privateExportSucceeded = true;
    } catch (error) {
      expect(error).toMatchObject({ name: "InvalidAccessError" });
    }
    expect(privateExportSucceeded).toBe(false);
    const value = challenge();
    const proof = await signBrowserApprovalChallenge(key.privateKey, value, binding());
    const publicKey = createPublicKey({
      key: { kty: "EC", crv: "P-256", ...key.publicKey },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(browserApprovalChallengeText(value)),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(proof.signature, "base64url"),
      ),
    ).toBe(true);
    expect(proof.challengeId).toBe(value.challengeId);
  });

  it.each(BINDING_CHANGES)(
    "refuses a challenge for changed authority bindings %j",
    async (patch) => {
      const key = await createBrowserApprovalKey();
      await expect(
        signBrowserApprovalChallenge(key.privateKey, { ...challenge(), ...patch }, binding()),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it("leaves challenge time authority to the server when a browser clock is rounded or ahead", async () => {
    const key = await createBrowserApprovalKey();
    for (const localTime of [AT - 16, AT + 60_000]) {
      vi.mocked(Date.now).mockReturnValue(localTime);
      await expect(
        signBrowserApprovalChallenge(key.privateKey, challenge(), binding()),
      ).resolves.toMatchObject({ challengeId: challenge().challengeId });
    }
    await expect(
      signBrowserApprovalChallenge(key.privateKey, { ...challenge(), expiresAtMs: AT }, binding()),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects extractable keys and never places key coordinates or signatures in lifecycle evidence", async () => {
    const records: unknown[] = [];
    setClientDiagnosticWriter((message, meta) => records.push({ message, meta }));
    const key = await createBrowserApprovalKey();
    const proof = await signBrowserApprovalChallenge(key.privateKey, challenge(), binding());
    const extractable = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    expect(isBrowserApprovalPrivateKey(extractable.privateKey)).toBe(false);
    await expect(
      signBrowserApprovalChallenge(extractable.privateKey, challenge(), binding()),
    ).rejects.toBeInstanceOf(TypeError);
    const serialized = JSON.stringify(records);
    expect(serialized.includes(key.publicKey.x)).toBe(false);
    expect(serialized.includes(proof.signature)).toBe(false);
    expect(serialized.includes(challenge().subjectId)).toBe(false);
    expect(serialized).toContain('"operation":"proof-sign","outcome":"signed"');
  });
});
