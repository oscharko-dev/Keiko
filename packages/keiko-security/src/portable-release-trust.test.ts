import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPortableReleaseTrust,
  PORTABLE_RELEASE_TRUST_MAX_LIFETIME_MS,
  portableReleaseTrustKeyId,
  verifyPortableReleaseTrust,
  type PortableReleaseTrustedKey,
} from "./portable-release-trust.js";

const SIGNED_AT = "2026-09-10T08:00:00.000Z";
const EXPIRES_AT = "2027-03-09T08:00:00.000Z";

function keyPair(): {
  readonly privateKeyPem: string;
  readonly trustedKey: PortableReleaseTrustedKey;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    trustedKey: {
      keyId: portableReleaseTrustKeyId(publicKeyPem),
      publicKeyPem,
    },
  };
}

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: { packageName: "@oscharko-dev/keiko", packageVersion: "0.3.18" },
    release: {
      releaseId: 1234,
      releaseTag: "v0.3.18",
      commitSha: "a".repeat(40),
      stable: true,
    },
    artifact: {
      assetId: 5678,
      assetName: "keiko-windows-x64.zip",
      platformTarget: "windows-x64",
      sha256: "b".repeat(64),
      sizeBytes: 100,
    },
  };
}

describe("portable release trust", () => {
  it("authenticates a canonical manifest with a trusted Ed25519 release key", () => {
    const key = keyPair();
    const signed = createPortableReleaseTrust(manifest(), {
      expiresAt: EXPIRES_AT,
      metadataVersion: 1234,
      privateKeyPem: key.privateKeyPem,
      signedAt: SIGNED_AT,
    });

    expect(
      verifyPortableReleaseTrust(signed, {
        now: new Date("2026-09-11T08:00:00.000Z"),
        trustedKeys: [key.trustedKey],
      }),
    ).toEqual({ keyId: key.trustedKey.keyId, metadataVersion: 1234, ok: true });
  });

  it("rejects artifact tampering, an unknown key, expiry, and a metadata rollback", () => {
    const key = keyPair();
    const signed = createPortableReleaseTrust(manifest(), {
      expiresAt: EXPIRES_AT,
      metadataVersion: 1234,
      privateKeyPem: key.privateKeyPem,
      signedAt: SIGNED_AT,
    });
    const tampered = structuredClone(signed);
    (tampered.artifact as Record<string, unknown>).sha256 = "c".repeat(64);

    expect(
      verifyPortableReleaseTrust(tampered, {
        now: new Date("2026-09-11T08:00:00.000Z"),
        trustedKeys: [key.trustedKey],
      }),
    ).toEqual({ ok: false, reason: "signature-invalid" });
    expect(
      verifyPortableReleaseTrust(signed, {
        now: new Date("2026-09-11T08:00:00.000Z"),
        trustedKeys: [],
      }),
    ).toEqual({ ok: false, reason: "key-untrusted" });
    expect(
      verifyPortableReleaseTrust(signed, {
        now: new Date("2026-09-11T08:00:00.000Z"),
        trustedKeys: [{ keyId: key.trustedKey.keyId, publicKeyPem: "not a public key" }],
      }),
    ).toEqual({ ok: false, reason: "key-untrusted" });
    expect(
      verifyPortableReleaseTrust(signed, {
        now: new Date("2027-03-10T08:00:00.000Z"),
        trustedKeys: [key.trustedKey],
      }),
    ).toEqual({ ok: false, reason: "metadata-expired" });
    expect(
      verifyPortableReleaseTrust(signed, {
        minimumMetadataVersion: 1235,
        now: new Date("2026-09-11T08:00:00.000Z"),
        trustedKeys: [key.trustedKey],
      }),
    ).toEqual({ ok: false, reason: "metadata-rollback" });
  });

  it("rejects malformed trust metadata before cryptographic processing", () => {
    const key = keyPair();
    const signed = createPortableReleaseTrust(manifest(), {
      expiresAt: EXPIRES_AT,
      metadataVersion: 1234,
      privateKeyPem: key.privateKeyPem,
      signedAt: SIGNED_AT,
    });
    const malformed = structuredClone(signed);
    (malformed.releaseTrust as Record<string, unknown>).algorithm = "rsa";

    expect(
      verifyPortableReleaseTrust(malformed, {
        now: new Date("2026-09-11T08:00:00.000Z"),
        trustedKeys: [key.trustedKey],
      }),
    ).toEqual({ ok: false, reason: "metadata-malformed" });
  });

  it("enforces the maximum trust lifetime when signing and verifying", () => {
    const key = keyPair();
    const overlongExpiry = new Date(
      new Date(SIGNED_AT).valueOf() + PORTABLE_RELEASE_TRUST_MAX_LIFETIME_MS + 1,
    ).toISOString();
    expect(() =>
      createPortableReleaseTrust(manifest(), {
        expiresAt: overlongExpiry,
        metadataVersion: 1234,
        privateKeyPem: key.privateKeyPem,
        signedAt: SIGNED_AT,
      }),
    ).toThrow("portable release trust lifetime exceeds the maximum");

    const signed = createPortableReleaseTrust(manifest(), {
      expiresAt: EXPIRES_AT,
      metadataVersion: 1234,
      privateKeyPem: key.privateKeyPem,
      signedAt: SIGNED_AT,
    });
    (signed.releaseTrust as Record<string, unknown>).expiresAt = overlongExpiry;
    expect(
      verifyPortableReleaseTrust(signed, {
        now: new Date(SIGNED_AT),
        trustedKeys: [key.trustedKey],
      }),
    ).toEqual({ ok: false, reason: "metadata-malformed" });
  });
});
