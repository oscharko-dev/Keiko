import { describe, expect, it } from "vitest";

import {
  evaluatePortableSidecarAvailability,
  PortableSidecarVerificationError,
  verifyPortableAttestedSidecars,
  verifyPortableManifestSidecars,
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
      platformAttested: true,
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
        platformAttested: true,
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
        platformAttested: true,
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
        platformAttested: true,
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

const EVALUATION_REASON_CODES = ["evaluation-artifact", "evaluation-unsigned-allowed"] as const;
const MACOS_CHECKS_FALSE = {
  developerIdVerified: false,
  notarizationVerified: false,
  stapleVerified: false,
  assessmentVerified: false,
};

/** A complete, well-formed macOS sidecar runtime record whose only variable is its signing lane. */
function sidecarRuntime(signing: Record<string, unknown>): Record<string, unknown> {
  const root = "runtime/sidecars/opencode-compatible";
  return {
    approvalSchemaVersion: 2,
    name: "opencode-compatible",
    kind: "coding-runtime",
    platformTarget: "macos-arm64",
    upstream: {
      owner: "anomalyco",
      repository: "opencode",
      name: "opencode",
      version: "1.17.17",
      tag: "v1.17.17",
      commit: "474abdd7ee60f4b67476cfcef7e5311beff4a824",
    },
    adapterCompatibility: {
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      transport: "http-sse",
    },
    protocolSchema: {
      path: "packages/sdk/openapi.json",
      sha256: OPENCODE_SCHEMA_SHA256,
      hashAlgorithm: "sha256",
      hashEncoding: "lowercase-hex",
      digestInput: "upstream-raw-bytes",
      transport: "http-sse",
    },
    releaseApproval: { redistribution: { status: "approved" } },
    archive: { platformTarget: "macos-arm64", sha256: "d".repeat(64) },
    executableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
    executableTreeSha256: "f".repeat(64),
    payloadRootPath: root,
    executablePath: `${root}/opencode`,
    payloadSha256: "c".repeat(64),
    sizeBytes: 42,
    licenseEvidence: { path: `${root}/LICENSE`, sha256: "a".repeat(64) },
    sbomEvidence: { path: `${root}/sbom.cdx.json`, sha256: "b".repeat(64) },
    signing,
  };
}

function productionSigning(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verificationPolicy: "production",
    verificationStatus: "verified-production",
    verificationReasonCodes: [],
    signatureKind: "developer-id-notarized",
    signatureVerified: true,
    notarizationRequired: true,
    notarizationVerified: true,
    verificationChecks: {
      developerIdVerified: true,
      notarizationVerified: true,
      stapleVerified: true,
      assessmentVerified: true,
    },
    shippedExecutableSha256: "e".repeat(64),
    shippedExecutableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
    shippedExecutableTreeSha256: "9".repeat(64),
    ...overrides,
  };
}

function evaluationSigning(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verificationPolicy: "evaluation",
    verificationStatus: "evaluation-unqualified",
    verificationReasonCodes: [...EVALUATION_REASON_CODES],
    signatureKind: "developer-id-notarized",
    signatureVerified: false,
    notarizationRequired: true,
    notarizationVerified: false,
    verificationChecks: { ...MACOS_CHECKS_FALSE },
    shippedExecutableSha256: "e".repeat(64),
    shippedExecutableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
    shippedExecutableTreeSha256: "9".repeat(64),
    ...overrides,
  };
}

function activation(signing: Record<string, unknown>): Record<string, unknown> {
  return { sidecarRuntimes: [sidecarRuntime(signing)] };
}

function attestedFailureCode(
  signing: Record<string, unknown>,
  lane?: "release-qualified" | "evaluation-unqualified",
): string | undefined {
  try {
    verifyPortableAttestedSidecars(activation(signing), "macos-arm64", lane);
    return undefined;
  } catch (error) {
    return error instanceof PortableSidecarVerificationError ? error.failureCode : "unexpected";
  }
}

/**
 * THE STRUCTURAL PIN (ADR-0163 D9). The update/promotion entry point takes no lane parameter, and
 * the activation entry point's lane defaults closed. The product may activate an unsigned sidecar;
 * it may never self-update from one.
 */
describe("the evaluation lane is reachable only from the activation entry point", () => {
  it("refuses an evaluation sidecar on the update path", () => {
    const manifest = {
      sidecarRuntimes: [sidecarRuntime(evaluationSigning())],
      releaseImpact: {
        reviewedBinding: { sidecarRuntimes: [sidecarRuntime(evaluationSigning())] },
      },
    };
    expect(() => verifyPortableManifestSidecars(manifest, "macos-arm64")).toThrow(
      PortableSidecarVerificationError,
    );
    try {
      verifyPortableManifestSidecars(manifest, "macos-arm64");
    } catch (error) {
      expect(error).toBeInstanceOf(PortableSidecarVerificationError);
      expect((error as PortableSidecarVerificationError).failureCode).toBe(
        "sidecar-signing-unverified",
      );
    }
  });

  it("refuses an evaluation sidecar when the attested entry point is called without a lane", () => {
    expect(attestedFailureCode(evaluationSigning())).toBe("sidecar-signing-unverified");
  });

  it("refuses an evaluation sidecar when the release-qualified lane is requested", () => {
    expect(attestedFailureCode(evaluationSigning(), "release-qualified")).toBe(
      "sidecar-signing-unverified",
    );
  });

  it("accepts an evaluation sidecar only when the evaluation lane is explicitly passed", () => {
    const verified = verifyPortableAttestedSidecars(
      activation(evaluationSigning()),
      "macos-arm64",
      "evaluation-unqualified",
    );
    expect(verified.sidecars).toHaveLength(1);
    expect(verified.sidecars[0]?.summary.name).toBe("opencode-compatible");
  });

  it("refuses a production sidecar when the evaluation lane is requested", () => {
    expect(attestedFailureCode(productionSigning(), "evaluation-unqualified")).toBe(
      "sidecar-signing-unverified",
    );
  });
});

describe("evaluation-lane sidecar signing predicates", () => {
  it("records an honest availability record that never forges packaged-grade evidence", () => {
    const evaluation = verifyPortableAttestedSidecars(
      activation(evaluationSigning()),
      "macos-arm64",
      "evaluation-unqualified",
    ).sidecars[0];
    expect(evaluation?.availability).toEqual({
      redistributionApproved: true,
      payloadPresent: true,
      archiveDigestVerified: true,
      executableTreeDigestVerified: true,
      runtimeVersionVerified: true,
      protocolSchemaVerified: true,
      signatureVerified: false,
      qualificationVerified: false,
    });
    const production = verifyPortableAttestedSidecars(
      activation(productionSigning()),
      "macos-arm64",
      "release-qualified",
    ).sidecars[0];
    expect(production?.availability.signatureVerified).toBe(true);
    expect(production?.availability.qualificationVerified).toBe(true);
  });

  // The exact 11-key signing set and the three shipped-executable digests are lane-INDEPENDENT.
  it.each([
    [
      "a 10-key signing object",
      (signing: Record<string, unknown>): void => {
        delete signing.signatureKind;
      },
    ],
    [
      "a 12-key signing object",
      (signing: Record<string, unknown>): void => {
        signing.extra = true;
      },
    ],
    [
      "an absent shipped executable digest",
      (signing: Record<string, unknown>): void => {
        delete signing.shippedExecutableSha256;
      },
    ],
    [
      "a non-hex shipped executable digest",
      (signing: Record<string, unknown>): void => {
        signing.shippedExecutableSha256 = "not-a-digest";
      },
    ],
    [
      "an absent shipped executable tree digest",
      (signing: Record<string, unknown>): void => {
        delete signing.shippedExecutableTreeSha256;
      },
    ],
    [
      "a foreign tree algorithm",
      (signing: Record<string, unknown>): void => {
        signing.shippedExecutableTreeAlgorithm = "sha256";
      },
    ],
    [
      "a foreign signature kind",
      (signing: Record<string, unknown>): void => {
        signing.signatureKind = "authenticode";
      },
    ],
    [
      "a notarizationRequired that does not match the target",
      (signing: Record<string, unknown>): void => {
        signing.notarizationRequired = false;
      },
    ],
  ])("refuses %s on the evaluation lane", (_name, mutate) => {
    const signing = evaluationSigning();
    mutate(signing);
    expect(attestedFailureCode(signing, "evaluation-unqualified")).toBe(
      "sidecar-signing-unverified",
    );
  });

  // The lane ASSERTS the platform booleans are present and false; it never skips them.
  it.each([
    ["signatureVerified true", { signatureVerified: true }],
    ["notarizationVerified true", { notarizationVerified: true }],
    [
      "a single platform check true",
      { verificationChecks: { ...MACOS_CHECKS_FALSE, developerIdVerified: true } },
    ],
    ["platform checks absent rather than present-and-false", { verificationChecks: {} }],
    ["only one evaluation reason code", { verificationReasonCodes: ["evaluation-artifact"] }],
    ["the staging status", { verificationStatus: "unverified-staging" }],
    ["the staging policy", { verificationPolicy: "staging" }],
  ])("refuses %s", (_name, overrides) => {
    expect(attestedFailureCode(evaluationSigning(overrides), "evaluation-unqualified")).toBe(
      "sidecar-signing-unverified",
    );
  });
});

/** MIRROR PIN — must pass both before and after: the production clause is not relaxed. */
describe("the production lane is unchanged", () => {
  it.each([
    ["signatureVerified false", { signatureVerified: false }],
    ["notarizationVerified false", { notarizationVerified: false }],
    [
      "a single platform check false",
      {
        verificationChecks: {
          developerIdVerified: false,
          notarizationVerified: true,
          stapleVerified: true,
          assessmentVerified: true,
        },
      },
    ],
    ["the evaluation status", { verificationStatus: "evaluation-unqualified" }],
    ["the evaluation policy", { verificationPolicy: "evaluation" }],
  ])("refuses a production declaration with %s", (_name, overrides) => {
    expect(attestedFailureCode(productionSigning(overrides), "release-qualified")).toBe(
      "sidecar-signing-unverified",
    );
  });

  it("accepts a complete production declaration", () => {
    expect(attestedFailureCode(productionSigning(), "release-qualified")).toBeUndefined();
    expect(attestedFailureCode(productionSigning())).toBeUndefined();
  });
});

describe("the platform-attested availability order", () => {
  it("omits only the two platform checks and keeps the other six in order", () => {
    const verified = verifiedSidecar();
    const unattested: PortableSidecarRuntimeVerification = {
      ...verified,
      availability: {
        ...verified.availability,
        signatureVerified: false,
        qualificationVerified: false,
      },
    };
    expect(
      evaluatePortableSidecarAvailability(unattested, {
        target: "macos-arm64",
        platformAttested: false,
      }),
    ).toEqual({ available: true });
    expect(
      evaluatePortableSidecarAvailability(unattested, {
        target: "macos-arm64",
        platformAttested: true,
      }),
    ).toEqual({ available: false, reason: "signature-unverified" });
  });

  it("can only remove a check, never turn a stored false into a pass", () => {
    const verified = verifiedSidecar();
    for (const [field, reason] of [
      ["redistributionApproved", "redistribution-unapproved"],
      ["payloadPresent", "payload-missing"],
      ["archiveDigestVerified", "archive-digest-mismatch"],
      ["executableTreeDigestVerified", "executable-tree-digest-mismatch"],
      ["runtimeVersionVerified", "runtime-version-mismatch"],
      ["protocolSchemaVerified", "protocol-schema-mismatch"],
    ] as const) {
      const sidecar: PortableSidecarRuntimeVerification = {
        ...verified,
        availability: { ...verified.availability, [field]: false },
      };
      expect(
        evaluatePortableSidecarAvailability(sidecar, {
          target: "macos-arm64",
          platformAttested: false,
        }),
      ).toEqual({ available: false, reason });
    }
  });

  it("still refuses a target mismatch before any other check on an unattested lane", () => {
    expect(
      evaluatePortableSidecarAvailability(verifiedSidecar(), {
        target: "windows-x64",
        platformAttested: false,
      }),
    ).toEqual({ available: false, reason: "platform-unsupported" });
  });
});
