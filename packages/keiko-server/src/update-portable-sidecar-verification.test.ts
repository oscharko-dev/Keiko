import { describe, expect, it } from "vitest";

import {
  evaluatePortableSidecarAvailability,
  type PortableSidecarRuntimeVerification,
} from "./update-portable-sidecar-verification.js";
import {
  OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256,
  OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM,
} from "./coding-runtime/opencodeProtocolSurface.js";

const OPENCODE_SCHEMA_SHA256 = "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de";

function verifiedSidecar(): PortableSidecarRuntimeVerification {
  return {
    payloadRootPath: "runtime/sidecars/opencode-compatible",
    executablePath: "runtime/sidecars/opencode-compatible/opencode",
    shippedExecutableSha256: "e".repeat(64),
    executableTreeSha256: "d".repeat(64),
    licenseEvidencePath: "runtime/sidecars/opencode-compatible/LICENSE",
    licenseEvidenceSha256: "a".repeat(64),
    sbomEvidencePath: "runtime/sidecars/opencode-compatible/sbom.cdx.json",
    sbomEvidenceSha256: "b".repeat(64),
    protocolSchemaRawSha256: OPENCODE_SCHEMA_SHA256,
    protocolHandshakeDigest: OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256,
    protocolHandshakeAlgorithm: OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM,
    summary: {
      name: "opencode-compatible",
      kind: "coding-runtime",
      upstreamName: "opencode",
      upstreamVersion: "1.17.17",
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      protocolVersion: "http-sse",
      platformTarget: "macos-arm64",
      payloadSha256: "c".repeat(64),
      payloadSha256Prefix: "c".repeat(12),
      sizeBytes: 1,
      status: "verified",
    },
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
  };
}

describe("portable sidecar runtime availability", () => {
  it.each([
    ["platform-unsupported", { target: "windows-x64" }],
    ["redistribution-unapproved", { redistributionApproved: false }],
    ["payload-missing", { payloadPresent: false }],
    ["archive-digest-mismatch", { archiveDigestVerified: false }],
    ["executable-tree-digest-mismatch", { executableTreeDigestVerified: false }],
    ["runtime-version-mismatch", { runtimeVersionVerified: false }],
    ["protocol-schema-mismatch", { protocolSchemaVerified: false }],
    ["signature-unverified", { signatureVerified: false }],
    ["qualification-missing", { qualificationVerified: false }],
  ] as const)("reports %s before launch", (reason, override) => {
    const sidecar = verifiedSidecar();
    const result = evaluatePortableSidecarAvailability(sidecar, {
      target: "macos-arm64",
      qualificationVerified: true,
      ...override,
    });

    expect(result).toEqual({ available: false, reason });
  });

  it("uses the closed reason precedence when several proofs are absent", () => {
    const sidecar = verifiedSidecar();

    expect(
      evaluatePortableSidecarAvailability(sidecar, {
        target: "windows-x64",
        redistributionApproved: false,
        payloadPresent: false,
        archiveDigestVerified: false,
        executableTreeDigestVerified: false,
        runtimeVersionVerified: false,
        protocolSchemaVerified: false,
        signatureVerified: false,
        qualificationVerified: false,
      }),
    ).toEqual({ available: false, reason: "platform-unsupported" });
  });

  it("is available only with complete portable evidence and qualification", () => {
    expect(
      evaluatePortableSidecarAvailability(verifiedSidecar(), {
        target: "macos-arm64",
        qualificationVerified: true,
      }),
    ).toEqual({ available: true });
  });

  it.each([
    ["redistributionApproved", "redistribution-unapproved"],
    ["payloadPresent", "payload-missing"],
    ["archiveDigestVerified", "archive-digest-mismatch"],
    ["executableTreeDigestVerified", "executable-tree-digest-mismatch"],
    ["runtimeVersionVerified", "runtime-version-mismatch"],
    ["protocolSchemaVerified", "protocol-schema-mismatch"],
    ["signatureVerified", "signature-unverified"],
    ["qualificationVerified", "qualification-missing"],
  ] as const)("does not let caller true override stored %s=false", (field, reason) => {
    const verified = verifiedSidecar();
    const sidecar: PortableSidecarRuntimeVerification = {
      ...verified,
      availability: { ...verified.availability, [field]: false },
    };

    expect(
      evaluatePortableSidecarAvailability(sidecar, {
        target: "macos-arm64",
        redistributionApproved: true,
        payloadPresent: true,
        archiveDigestVerified: true,
        executableTreeDigestVerified: true,
        runtimeVersionVerified: true,
        protocolSchemaVerified: true,
        signatureVerified: true,
        qualificationVerified: true,
      }),
    ).toEqual({ available: false, reason });
  });
});
