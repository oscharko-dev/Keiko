import { describe, expect, it } from "vitest";

import { createPackagedSecureWorkspaceTextReadPort } from "./packagedSecureWorkspaceTextRead.js";
import type { QualifiedPortableOpenCodeRuntime } from "./productionPortableCodingRuntime.js";

function runtime(
  target: QualifiedPortableOpenCodeRuntime["target"],
): QualifiedPortableOpenCodeRuntime {
  const digest = "a".repeat(64);
  return {
    installRoot: "/managed/Keiko",
    target,
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
});
