import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, type Mock, vi } from "vitest";

import {
  LINUX_QUALIFICATION_REHEARSAL_SIGSTORE_POLICY,
  LINUX_QUALIFICATION_SIGSTORE_POLICY,
  type SigstoreBundleVerifier,
  verifyLinuxQualificationBundle,
  verifyLinuxQualificationRehearsalBundle,
} from "./linuxPortableSigstore.js";

const WORKFLOW = "https://github.com/oscharko-dev/Keiko/.github/workflows/portable-assets.yml";

function verifierMock(): Mock<SigstoreBundleVerifier["verify"]> {
  const { publicKey } = generateKeyPairSync("ed25519");
  return vi.fn<SigstoreBundleVerifier["verify"]>(() => ({ key: publicKey }));
}

function serializedBundle(receipt: Buffer): object {
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      publicKey: { hint: "test-key" },
      tlogEntries: [],
    },
    messageSignature: {
      messageDigest: {
        algorithm: "SHA2_256",
        digest: createHash("sha256").update(receipt).digest("base64"),
      },
      signature: "c2lnbmF0dXJl",
    },
  };
}

describe("Linux portable Sigstore verification", () => {
  it("binds the exact receipt bytes to the release workflow and GitHub OIDC issuer", () => {
    const verify = verifierMock();
    const receipt = Buffer.from('{"result":"passed"}\n', "utf8");

    verifyLinuxQualificationBundle(receipt, serializedBundle(receipt), { verify });

    expect(verify).toHaveBeenCalledOnce();
    expect(
      verify.mock.calls[0]?.[0].signature.compareDigest(
        createHash("sha256").update(receipt).digest(),
      ),
    ).toBe(true);
    expect(verify.mock.calls[0]?.[1]).toBe(LINUX_QUALIFICATION_SIGSTORE_POLICY);
    expect(LINUX_QUALIFICATION_SIGSTORE_POLICY.extensions.issuer).toBe(
      "https://token.actions.githubusercontent.com",
    );
    const identity = LINUX_QUALIFICATION_SIGSTORE_POLICY.subjectAlternativeName;
    expect(
      identity.test(
        "https://github.com/oscharko-dev/Keiko/.github/workflows/portable-assets.yml@refs/tags/v1.2.3",
      ),
    ).toBe(true);
    expect(
      identity.test(
        "https://github.com/oscharko-dev/Keiko/.github/workflows/portable-assets.yml@refs/heads/dev",
      ),
    ).toBe(false);
  });

  it("rejects malformed bundles before the verifier can run", () => {
    const verify = verifierMock();

    expect(() => {
      verifyLinuxQualificationBundle(Buffer.from("receipt"), {}, { verify });
    }).toThrow();
    expect(verify).not.toHaveBeenCalled();
  });

  it("binds a rehearsal receipt to the dev-branch workflow policy, never the release policy", () => {
    const verify = verifierMock();
    const receipt = Buffer.from('{"result":"passed"}\n', "utf8");

    verifyLinuxQualificationRehearsalBundle(receipt, serializedBundle(receipt), { verify });

    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.calls[0]?.[1]).toBe(LINUX_QUALIFICATION_REHEARSAL_SIGSTORE_POLICY);
    expect(verify.mock.calls[0]?.[1]).not.toBe(LINUX_QUALIFICATION_SIGSTORE_POLICY);
    expect(LINUX_QUALIFICATION_REHEARSAL_SIGSTORE_POLICY.extensions.issuer).toBe(
      "https://token.actions.githubusercontent.com",
    );
  });

  // The fence: an identity one policy accepts, the other must refuse, so a rehearsal-signed
  // qualification can never satisfy the release policy the product runtime enforces.
  it.each([
    [`${WORKFLOW}@refs/tags/v1.2.3`, true, false],
    [`${WORKFLOW}@refs/heads/dev`, false, true],
    [`${WORKFLOW}@refs/heads/dev-release`, false, false],
    [`${WORKFLOW}@refs/heads/devel`, false, false],
    [`${WORKFLOW}@refs/heads/main`, false, false],
    [`${WORKFLOW}@refs/tags/v1.2.3-rc.1`, false, false],
    [`${WORKFLOW}@refs/heads/dev\n`, false, false],
    [
      "https://github.com/someone-else/Keiko/.github/workflows/portable-assets.yml@refs/heads/dev",
      false,
      false,
    ],
    [
      "https://github.com/oscharko-dev/Keiko/.github/workflows/release.yml@refs/heads/dev",
      false,
      false,
    ],
  ])(
    "keeps the release and rehearsal identities disjoint for %s",
    (identity, release, rehearsal) => {
      expect(LINUX_QUALIFICATION_SIGSTORE_POLICY.subjectAlternativeName.test(identity)).toBe(
        release,
      );
      expect(
        LINUX_QUALIFICATION_REHEARSAL_SIGSTORE_POLICY.subjectAlternativeName.test(identity),
      ).toBe(rehearsal);
    },
  );

  it("rejects a malformed rehearsal bundle before the verifier can run", () => {
    const verify = verifierMock();

    expect(() => {
      verifyLinuxQualificationRehearsalBundle(Buffer.from("receipt"), {}, { verify });
    }).toThrow();
    expect(verify).not.toHaveBeenCalled();
  });

  it("constructs the offline public verifier from the embedded Sigstore trust root", () => {
    expect(() => {
      verifyLinuxQualificationBundle(Buffer.from("receipt"), {});
    }).toThrow("invalid bundle");
  });
});
