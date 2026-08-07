import { describe, expect, it } from "vitest";

import { createPackagedSecureWorkspaceTextReadPort } from "./packagedSecureWorkspaceTextRead.js";
import type { QualifiedPortableOpenCodeRuntime } from "./productionPortableCodingRuntime.js";

function runtime(
  target: QualifiedPortableOpenCodeRuntime["target"],
  platformAssurance: QualifiedPortableOpenCodeRuntime["platformAssurance"] = "release-qualified",
): QualifiedPortableOpenCodeRuntime {
  const digest = "a".repeat(64);
  return {
    installRoot: "/managed/Keiko",
    target,
    platformAssurance,
    manifest: {},
    sidecar: {
      summary: {
        name: "opencode-compatible",
        kind: "coding-runtime",
        upstreamName: "opencode",
        upstreamVersion: "1.17.17",
        adapterName: "keiko-coding-sidecar",
        adapterVersion: "1",
        protocolVersion: "coding-sidecar-v1",
        platformTarget: target,
        payloadSha256: digest,
        payloadSha256Prefix: digest.slice(0, 12),
        sizeBytes: 1,
        status: "verified",
      },
      payloadRootPath: "runtime/sidecars/opencode-compatible",
      executablePath: "runtime/sidecars/opencode-compatible/opencode",
      shippedExecutableSha256: digest,
      executableTreeSha256: digest,
      licenseEvidencePath: "LICENSE.txt",
      licenseEvidenceSha256: digest,
      sbomEvidencePath: "sbom.cdx.json",
      sbomEvidenceSha256: digest,
      protocolSchemaRawSha256: digest,
      protocolHandshakeDigest: digest,
      protocolHandshakeAlgorithm: "keiko-opencode-protocol-surface-v1",
      availability: {
        redistributionApproved: true,
        payloadPresent: true,
        archiveDigestVerified: true,
        executableTreeDigestVerified: true,
        runtimeVersionVerified: true,
        protocolSchemaVerified: true,
        signatureVerified: true,
        qualificationVerified: true,
      },
    },
    qualification: {
      platform: target === "windows-x64" ? "win32" : "darwin",
      arch: target === "macos-arm64" ? "arm64" : "x64",
      backend: target === "windows-x64" ? "windows-job-object" : "macos-endpoint-security",
      releaseReceipt: `sha256:${digest}`,
    },
    nativeHelperPath: "/managed/Keiko/runtime/native/supervisor",
  };
}

const HELPER_DIGEST = "b".repeat(64);
const HELPER_COMMIT = "c".repeat(40);
const HELPER_TREE = "d".repeat(64);
const PACKAGE_VERSION = "0.3.0";

/**
 * A complete, valid packaged secure-read manifest whose ONLY variable is the declared lane. Both
 * lanes must construct a port; the evaluation lane substitutes the two OS-vouching deps while every
 * structural predicate is satisfied identically.
 */
function secureReadManifest(evaluation: boolean): Record<string, unknown> {
  const verified = !evaluation;
  const signing = {
    signatureKind: "developer-id-notarized",
    verificationStatus: evaluation ? "evaluation-unqualified" : "verified-production",
    signatureVerified: verified,
    notarizationRequired: true,
    notarizationVerified: verified,
  };
  const helper = {
    name: "keiko-secure-workspace-read",
    kind: "secure-workspace-text-read",
    platformTarget: "macos-arm64",
    architecture: "arm64",
    executablePath: "runtime/native/keiko-secure-workspace-read",
    protocol: { schemaVersion: 1, requestMagic: "KSR1", responseMagic: "KSS1" },
    source: {
      commitSha: HELPER_COMMIT,
      path: "native/secure-workspace-read",
      treeSha256: HELPER_TREE,
    },
    unsignedSha256: "e".repeat(64),
    shippedSha256: HELPER_DIGEST,
    sizeBytes: 4_096,
    sbomBomRef: `pkg:generic/keiko-secure-workspace-read@${PACKAGE_VERSION}?platform=macos-arm64`,
    signing,
  };
  const security = {
    verificationPolicy: evaluation ? "evaluation" : "production",
    verificationStatus: evaluation ? "evaluation-unqualified" : "verified-production",
    verificationReasonCodes: evaluation
      ? ["evaluation-artifact", "evaluation-unsigned-allowed"]
      : [],
    signatureKind: "developer-id-notarized",
    signatureVerified: verified,
    notarizationRequired: true,
    notarizationVerified: verified,
    verificationChecks: {
      developerIdVerified: verified,
      notarizationVerified: verified,
      stapleVerified: verified,
      assessmentVerified: verified,
    },
  };
  return {
    product: { packageVersion: PACKAGE_VERSION },
    artifact: { platformTarget: "macos-arm64" },
    runtime: { nodePlatform: "darwin", nodeArchitecture: "arm64" },
    nativeHelpers: [helper],
    security,
    releaseImpact: {
      reviewedBinding: {
        ...security,
        platformSignatureLocallyVerified: verified,
        nativeHelpers: [structuredClone(helper)],
      },
    },
  };
}

describe("packaged secure workspace-read composition", () => {
  it.each(["windows-x64", "macos-arm64", "macos-x64"] as const)(
    "fails closed without an attested %s secure-read binding",
    (target) => {
      expect(
        createPackagedSecureWorkspaceTextReadPort({
          runtime: runtime(target),
          resolveWorkspaceRoot: () => "/workspace",
          safeCwd: "/safe",
        }),
      ).toBeUndefined();
    },
  );

  // The evaluation lane waives the two OS-vouching deps, never the manifest binding: an artifact
  // whose secure-read helper evidence is absent stays refused on both lanes.
  it.each(["windows-x64", "macos-arm64", "macos-x64"] as const)(
    "fails closed without an evaluation-lane %s secure-read binding",
    (target) => {
      expect(
        createPackagedSecureWorkspaceTextReadPort({
          runtime: runtime(target, "evaluation-unqualified"),
          resolveWorkspaceRoot: () => "/workspace",
          safeCwd: "/safe",
        }),
      ).toBeUndefined();
    },
  );

  /**
   * REGRESSION PIN FOR THE RESERVED-NAME TRAP. `productionOpenCodeActivation` narrows the resolved
   * runtime union with `"evidenceClass" in portable` (the functional harness stand-in) and
   * `"lane" in portable` (the dev lane). Naming the packaged lane marker either of those would
   * silently route EVERY packaged install to a different code path — `secure-read-unavailable` for
   * the first, the dev-lane secure-read port and supervisor for the second — with no diagnostic.
   */
  // Both lanes construct a real port from the same manifest shape. The evaluation lane injects the
  // waived OS-vouching deps at this seam; every structural predicate above it is satisfied
  // identically, which is what keeps the waiver to exactly the platform signature.
  it.each([
    ["release-qualified", false],
    ["evaluation-unqualified", true],
  ] as const)("constructs the packaged port on the %s lane", (platformAssurance, evaluation) => {
    const port = createPackagedSecureWorkspaceTextReadPort({
      runtime: {
        ...runtime("macos-arm64", platformAssurance),
        installRoot: "/Applications/Keiko.app/Contents/Resources",
        manifest: secureReadManifest(evaluation),
      },
      resolveWorkspaceRoot: () => "/workspace",
      safeCwd: "/safe",
    });

    expect(port).toBeDefined();
  });

  // A packaged evaluation runtime must NOT be excluded by the reserved-name narrowing: the port is
  // constructed for it, so activation never reports `secure-read-unavailable` by misrouting.
  it("refuses a cross-lane manifest rather than falling back to the other lane", () => {
    for (const [platformAssurance, evaluation] of [
      ["release-qualified", true],
      ["evaluation-unqualified", false],
    ] as const) {
      expect(
        createPackagedSecureWorkspaceTextReadPort({
          runtime: {
            ...runtime("macos-arm64", platformAssurance),
            installRoot: "/Applications/Keiko.app/Contents/Resources",
            manifest: secureReadManifest(evaluation),
          },
          resolveWorkspaceRoot: () => "/workspace",
          safeCwd: "/safe",
        }),
      ).toBeUndefined();
    }
  });

  it.each(["release-qualified", "evaluation-unqualified"] as const)(
    "keeps the packaged %s marker out of both structural discriminators",
    (platformAssurance) => {
      const packaged: object = runtime("macos-arm64", platformAssurance);
      expect("platformAssurance" in packaged).toBe(true);
      expect("evidenceClass" in packaged).toBe(false);
      expect("lane" in packaged).toBe(false);
    },
  );
});
