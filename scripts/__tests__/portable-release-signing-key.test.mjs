import { generateKeyPairSync } from "node:crypto";

import { portableReleaseTrustKeyId } from "@oscharko-dev/keiko-security/portable-release-trust";
import { describe, expect, it } from "vitest";

import { proveReleaseSigningKeyBeforePublishing } from "../lib/portable-release-signing-key.mjs";

// The publisher used to meet an untrusted or unusable KEIKO_PORTABLE_RELEASE_SIGNING_KEY only after
// `gh release create` and the archive upload. release-publish-pipeline.test.mjs proves the ordering
// end to end; this suite proves every branch of the decision in-process.

function ed25519Pair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    trustedKeys: [{ keyId: portableReleaseTrustKeyId(publicKeyPem), publicKeyPem }],
  };
}

function prove({ portableAssetCount = 5, uploadEnabled = true, signingKey, trustedKeys }) {
  const failures = [];
  const logs = [];
  let keyReads = 0;
  proveReleaseSigningKeyBeforePublishing({
    fail: (message) => failures.push(message),
    log: (message) => logs.push(message),
    now: new Date("2026-09-14T12:00:00.000Z"),
    portableAssetCount,
    signingKey: () => {
      keyReads += 1;
      return signingKey();
    },
    trustedKeys: () => trustedKeys,
    uploadEnabled,
  });
  return { failures, keyReads, logs };
}

describe("proveReleaseSigningKeyBeforePublishing", () => {
  it("accepts a key the trust roots trust and logs its public key id", () => {
    const pair = ed25519Pair();
    const result = prove({ signingKey: () => pair.privateKeyPem, trustedKeys: pair.trustedKeys });

    expect(result.failures).toStrictEqual([]);
    expect(result.logs).toStrictEqual([
      `release-publish: portable release signing key ${pair.trustedKeys[0].keyId} is trusted.`,
    ]);
  });

  it("refuses a valid Ed25519 key the trust roots do not trust", () => {
    const signing = ed25519Pair();
    const result = prove({
      signingKey: () => signing.privateKeyPem,
      trustedKeys: ed25519Pair().trustedKeys,
    });

    expect(result.failures).toStrictEqual([
      "portable release signing key is not trusted (key-untrusted); nothing was published.",
    ]);
    expect(result.logs).toStrictEqual([]);
  });

  it.each([
    ["text that is not a key", () => "not-an-ed25519-private-key"],
    [
      "an RSA private key",
      () =>
        generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
          format: "pem",
          type: "pkcs8",
        }),
    ],
    ["an Ed25519 public key", () => ed25519Pair().trustedKeys[0].publicKeyPem],
    [
      "a reader that throws with the value in its message",
      () => {
        throw new TypeError("The argument 'key' is invalid. Received 'secret-key-material'");
      },
    ],
  ])("refuses %s without echoing it", (_label, readKey) => {
    const pair = ed25519Pair();
    let offered = "";
    const result = prove({
      signingKey: () => {
        offered = String(readKey());
        return offered;
      },
      trustedKeys: pair.trustedKeys,
    });

    expect(result.failures).toStrictEqual([
      "portable release signing key is not a usable Ed25519 private key; nothing was published.",
    ]);
    expect(result.logs).toStrictEqual([]);
    expect(result.failures.join("\n")).not.toContain("secret-key-material");
    if (offered.length > 0) expect(result.failures.join("\n")).not.toContain(offered);
  });

  it.each([
    ["no portable assets", { portableAssetCount: 0, uploadEnabled: true }],
    ["a dry run or a skipped GitHub release", { portableAssetCount: 5, uploadEnabled: false }],
  ])("does not read the key for %s", (_label, run) => {
    const result = prove({
      ...run,
      signingKey: () => {
        throw new Error("the key must not be read");
      },
      trustedKeys: [],
    });

    expect(result).toStrictEqual({ failures: [], keyReads: 0, logs: [] });
  });
});
