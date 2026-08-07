/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createPortableSecureWorkspaceReadVerifier,
  resolvePortableSecureWorkspaceReadBinding,
  type PortableSecureWorkspaceReadMetadata,
  type PortableSecureWorkspaceReadPlatformInspection,
} from "./secureWorkspaceTextReadPortable.js";

const BYTES = Buffer.from("signed helper");
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
const TREE_DIGEST = "b".repeat(64);
const COMMIT = "c".repeat(40);

function helper(target = "macos-arm64", evaluation = false) {
  const mac = target.startsWith("macos-");
  return {
    name: "keiko-secure-workspace-read",
    kind: "secure-workspace-text-read",
    platformTarget: target,
    architecture: target.endsWith("arm64") ? "arm64" : "x64",
    executablePath: `runtime/native/keiko-secure-workspace-read${mac ? "" : ".exe"}`,
    protocol: { schemaVersion: 1, requestMagic: "KSR1", responseMagic: "KSS1" },
    source: {
      commitSha: COMMIT,
      path: "native/secure-workspace-read",
      treeSha256: TREE_DIGEST,
    },
    unsignedSha256: "d".repeat(64),
    shippedSha256: DIGEST,
    sizeBytes: BYTES.byteLength,
    sbomBomRef: `pkg:generic/keiko-secure-workspace-read@0.2.15?platform=${target}`,
    signing: {
      signatureKind: mac ? "developer-id-notarized" : "authenticode",
      verificationStatus: evaluation ? "evaluation-unqualified" : "verified-production",
      signatureVerified: !evaluation,
      notarizationRequired: mac,
      notarizationVerified: mac && !evaluation,
    },
  };
}

function manifest(target = "macos-arm64", evaluation = false) {
  const nativeHelper = helper(target, evaluation);
  const mac = target.startsWith("macos-");
  const verified = !evaluation;
  const checks = mac
    ? {
        developerIdVerified: verified,
        notarizationVerified: verified,
        stapleVerified: verified,
        assessmentVerified: verified,
      }
    : { publisherChainVerified: verified, timestampVerified: verified };
  const security = {
    verificationPolicy: evaluation ? "evaluation" : "production",
    verificationStatus: evaluation ? "evaluation-unqualified" : "verified-production",
    verificationReasonCodes: evaluation
      ? ["evaluation-artifact", "evaluation-unsigned-allowed"]
      : [],
    signatureKind: nativeHelper.signing.signatureKind,
    signatureVerified: verified,
    notarizationRequired: mac,
    notarizationVerified: mac && verified,
    verificationChecks: checks,
    verificationSummaryPath: "evidence/signing-verification.json",
  };
  return {
    product: { packageVersion: "0.2.15" },
    artifact: { platformTarget: target },
    runtime: {
      nodePlatform: mac ? "darwin" : "win32",
      nodeArchitecture: nativeHelper.architecture,
    },
    nativeHelpers: [nativeHelper],
    security,
    releaseImpact: {
      reviewedBinding: {
        verificationPolicy: security.verificationPolicy,
        verificationStatus: security.verificationStatus,
        verificationReasonCodes: security.verificationReasonCodes,
        platformSignatureLocallyVerified: verified,
        signatureKind: security.signatureKind,
        signatureVerified: security.signatureVerified,
        notarizationRequired: security.notarizationRequired,
        notarizationVerified: security.notarizationVerified,
        verificationChecks: checks,
        nativeHelpers: [structuredClone(nativeHelper)],
      },
    },
  };
}

/**
 * The evaluation mirror of `manifest()` — the SAME builder, only the declared lane differs. Every
 * structural fact (the closed 12-key helper shape, the KSR1/KSS1 protocol pin, the source
 * commit/path/tree pin, both digests, the size ceiling, the SBOM bom-ref binding, the exact
 * `verificationChecks` KEY set and the reviewed-binding deep equality) is unchanged, and every
 * platform boolean flips to a declared FALSE rather than disappearing.
 */
function evaluationManifest(target = "macos-arm64") {
  return manifest(target, true);
}

type FixtureRecord = Record<string, unknown>;

interface FixtureHelperShape extends FixtureRecord {
  signing: FixtureRecord;
  protocol: FixtureRecord;
  shippedSha256: string;
  sizeBytes: number;
  sbomBomRef: string;
}

interface FixtureManifest extends FixtureRecord {
  security: FixtureRecord & {
    verificationChecks: FixtureRecord;
    verificationReasonCodes: readonly string[];
  };
  nativeHelpers: [FixtureHelperShape, ...FixtureHelperShape[]];
  releaseImpact: {
    reviewedBinding: FixtureRecord & {
      nativeHelpers: [FixtureHelperShape, ...FixtureHelperShape[]];
    };
  };
}

/** A deep, structurally typed copy so each adversarial case mutates exactly one fact. */
function mutableEvaluationManifest(): FixtureManifest {
  return JSON.parse(JSON.stringify(evaluationManifest())) as FixtureManifest;
}

function evaluationBinding(manifestValue: unknown = evaluationManifest()) {
  return resolvePortableSecureWorkspaceReadBinding({
    manifest: manifestValue,
    lane: "evaluation-unqualified",
    platform: { os: "darwin", arch: "arm64" },
    resourceRoot: "/Applications/Keiko.app/Contents/Resources",
  });
}

describe("portable secure workspace-read binding on the evaluation lane", () => {
  it("resolves a binding for a declared evaluation artifact", () => {
    const resolved = evaluationBinding();
    expect(resolved).toBeDefined();
    // `signed` is a structural artifact-shape literal, not a platform-signature claim: the
    // point-of-use verifier and the node process both require it truthy before any read runs.
    expect(resolved?.artifact.signed).toBe(true);
    expect(resolved?.artifact.sha256).toBe(DIGEST);
  });

  it("refuses an evaluation artifact when the release-qualified lane is requested", () => {
    expect(
      resolvePortableSecureWorkspaceReadBinding({
        manifest: evaluationManifest(),
        lane: "release-qualified",
        platform: { os: "darwin", arch: "arm64" },
        resourceRoot: "/Applications/Keiko.app/Contents/Resources",
      }),
    ).toBeUndefined();
  });

  it("refuses a production artifact when the evaluation lane is requested", () => {
    expect(
      resolvePortableSecureWorkspaceReadBinding({
        manifest: manifest(),
        lane: "evaluation-unqualified",
        platform: { os: "darwin", arch: "arm64" },
        resourceRoot: "/Applications/Keiko.app/Contents/Resources",
      }),
    ).toBeUndefined();
  });

  // The lane ASSERTS the platform proof is present and false, in BOTH the security block and the
  // reviewed copy, and every non-signature predicate stays exactly as strict.
  it.each([
    [
      "the helper signing block claims a verified signature",
      (value: FixtureManifest): void => {
        value.nativeHelpers[0].signing.signatureVerified = true;
        value.releaseImpact.reviewedBinding.nativeHelpers[0].signing.signatureVerified = true;
      },
    ],
    [
      "the helper signing block keeps the production status",
      (value: FixtureManifest): void => {
        value.nativeHelpers[0].signing.verificationStatus = "verified-production";
        value.releaseImpact.reviewedBinding.nativeHelpers[0].signing.verificationStatus =
          "verified-production";
      },
    ],
    [
      "security asserts one platform check",
      (value: FixtureManifest): void => {
        value.security.verificationChecks.developerIdVerified = true;
      },
    ],
    [
      "security omits a platform check instead of declaring it false",
      (value: FixtureManifest): void => {
        delete value.security.verificationChecks.stapleVerified;
      },
    ],
    [
      "security omits an evaluation reason code",
      (value: FixtureManifest): void => {
        value.security.verificationReasonCodes = ["evaluation-artifact"];
      },
    ],
    [
      "the reviewed binding claims a locally verified platform signature",
      (value: FixtureManifest): void => {
        value.releaseImpact.reviewedBinding.platformSignatureLocallyVerified = true;
      },
    ],
    [
      "the reviewed binding declares the other lane",
      (value: FixtureManifest): void => {
        value.releaseImpact.reviewedBinding.verificationPolicy = "staging";
      },
    ],
    [
      "the helper digest is not a digest",
      (value: FixtureManifest): void => {
        value.nativeHelpers[0].shippedSha256 = "not-a-digest";
        value.releaseImpact.reviewedBinding.nativeHelpers[0].shippedSha256 = "not-a-digest";
      },
    ],
    [
      "the helper protocol pin drifts",
      (value: FixtureManifest): void => {
        value.nativeHelpers[0].protocol.requestMagic = "KSR2";
        value.releaseImpact.reviewedBinding.nativeHelpers[0].protocol.requestMagic = "KSR2";
      },
    ],
    [
      "the reviewed helpers stop matching the manifest helpers",
      (value: FixtureManifest): void => {
        value.releaseImpact.reviewedBinding.nativeHelpers[0].sizeBytes += 1;
      },
    ],
    [
      "the sbom bom-ref version binding drifts",
      (value: FixtureManifest): void => {
        value.nativeHelpers[0].sbomBomRef = "pkg:generic/keiko-secure-workspace-read@9.9.9";
        value.releaseImpact.reviewedBinding.nativeHelpers[0].sbomBomRef =
          "pkg:generic/keiko-secure-workspace-read@9.9.9";
      },
    ],
  ])("refuses an evaluation artifact where %s", (_name, mutate) => {
    const value = mutableEvaluationManifest();
    mutate(value);
    expect(evaluationBinding(value)).toBeUndefined();
  });
});

function binding() {
  return resolvePortableSecureWorkspaceReadBinding({
    manifest: manifest(),
    lane: "release-qualified",
    platform: { os: "darwin", arch: "arm64" },
    resourceRoot: "/Applications/Keiko.app/Contents/Resources",
  })!;
}

function metadata(overrides: Partial<PortableSecureWorkspaceReadMetadata> = {}) {
  return {
    identity: "device:inode",
    size: BYTES.byteLength,
    modifiedNs: "100",
    changedNs: "101",
    regularFile: true,
    linkCount: 1,
    ...overrides,
  };
}

function verifierDeps(overrides: Partial<PortableSecureWorkspaceReadPlatformInspection> = {}) {
  const platform: PortableSecureWorkspaceReadPlatformInspection = {
    inspectPath: vi.fn(async () => [
      { symbolicLink: false, reparsePoint: false, safeType: true },
      { symbolicLink: false, reparsePoint: false, safeType: true },
      { symbolicLink: false, reparsePoint: false, safeType: true },
      { symbolicLink: false, reparsePoint: false, safeType: true },
    ]),
    openReadSameIdentity: vi.fn(async () => ({
      bytes: Buffer.from(BYTES),
      before: metadata(),
      after: metadata(),
    })),
    verifySignature: vi.fn(async () => true),
    ...overrides,
  };
  return {
    platform,
    proveImmutableResourceTree: vi.fn(async () => true),
  };
}

describe("portable secure workspace-read binding", () => {
  it("parses an unknown verified manifest into the closed current-target artifact", () => {
    expect(
      resolvePortableSecureWorkspaceReadBinding({
        manifest: manifest(),
        lane: "release-qualified",
        platform: { os: "darwin", arch: "arm64" },
        resourceRoot: "/Applications/Keiko.app/Contents/Resources",
      }),
    ).toEqual({
      artifact: {
        target: "darwin-arm64",
        installRelativePath: "runtime/native/keiko-secure-workspace-read",
        sha256: DIGEST,
        protocol: "KSR1/KSS1",
        sourceCommit: COMMIT,
        sourceTreeSha256: TREE_DIGEST,
        signed: true,
      },
      executable:
        "/Applications/Keiko.app/Contents/Resources/runtime/native/keiko-secure-workspace-read",
      helperSizeBytes: BYTES.byteLength,
      resourceRoot: "/Applications/Keiko.app/Contents/Resources",
    });
  });

  it.each([
    [{ os: "win32", arch: "x64" }, "windows-x64", String.raw`C:\Keiko\Resources`],
    [{ os: "darwin", arch: "arm64" }, "macos-arm64", "/Keiko/Resources"],
    [{ os: "darwin", arch: "x64" }, "macos-x64", "/Keiko/Resources"],
  ] as const)("maps only the current supported target %o", (platform, target, resourceRoot) => {
    expect(
      resolvePortableSecureWorkspaceReadBinding({
        manifest: manifest(target),
        lane: "release-qualified",
        platform,
        resourceRoot,
      })?.artifact.target,
    ).toBe(platform.os === "win32" ? "win32-x64" : `darwin-${platform.arch}`);
  });

  it("selects the secure-read helper from the exact release helper set", () => {
    const value = manifest();
    const supervisor = {
      ...structuredClone(value.nativeHelpers[0]!),
      name: "keiko-runtime-supervisor",
      kind: "runtime-process-supervisor",
      executablePath: "runtime/native/keiko-runtime-supervisor",
      protocol: { schemaVersion: 1, requestMagic: "KRP1", responseMagic: "KRS1" },
      source: {
        commitSha: COMMIT,
        path: "native/runtime-supervisor/macos",
        treeSha256: "e".repeat(64),
      },
      sbomBomRef: "pkg:generic/keiko-runtime-supervisor@0.2.15?platform=macos-arm64",
    };
    value.nativeHelpers.push(supervisor);
    value.releaseImpact.reviewedBinding.nativeHelpers.push(structuredClone(supervisor));

    expect(
      resolvePortableSecureWorkspaceReadBinding({
        manifest: value,
        lane: "release-qualified",
        platform: { os: "darwin", arch: "arm64" },
        resourceRoot: "/Applications/Keiko.app/Contents/Resources",
      }),
    ).toBeDefined();
  });

  it("rejects Linux before parsing or touching point-of-use dependencies", async () => {
    const malformed = new Proxy(
      {},
      {
        get: () => {
          throw new Error("manifest touched");
        },
      },
    );
    expect(
      resolvePortableSecureWorkspaceReadBinding({
        manifest: malformed,
        lane: "release-qualified",
        platform: { os: "linux", arch: "x64" },
        resourceRoot: "/Keiko/Resources",
      }),
    ).toBeUndefined();
  });

  it("fails closed when an unknown supported-target manifest is ambiguous", () => {
    const ambiguous = new Proxy(
      {},
      {
        get: () => {
          throw new Error("ambiguous");
        },
      },
    );
    expect(
      resolvePortableSecureWorkspaceReadBinding({
        manifest: ambiguous,
        lane: "release-qualified",
        platform: { os: "darwin", arch: "arm64" },
        resourceRoot: "/Keiko/Resources",
      }),
    ).toBeUndefined();
  });

  it("rejects reviewed-binding, security, protocol, digest, and path drift", () => {
    const cases = [
      (value: ReturnType<typeof manifest>) => {
        value.releaseImpact.reviewedBinding.nativeHelpers[0]!.shippedSha256 = "e".repeat(64);
      },
      (value: ReturnType<typeof manifest>) => {
        value.security.signatureVerified = false;
      },
      (value: ReturnType<typeof manifest>) => {
        value.nativeHelpers[0]!.protocol.requestMagic = "BAD1";
      },
      (value: ReturnType<typeof manifest>) => {
        value.nativeHelpers[0]!.shippedSha256 = "not-a-digest";
      },
      (value: ReturnType<typeof manifest>) => {
        value.nativeHelpers[0]!.executablePath = "runtime/native/other";
      },
      (value: ReturnType<typeof manifest>) => {
        value.nativeHelpers[0]!.sbomBomRef =
          "pkg:generic/keiko-secure-workspace-read@other?platform=macos-arm64";
      },
    ];
    for (const mutate of cases) {
      const value = manifest();
      mutate(value);
      expect(
        resolvePortableSecureWorkspaceReadBinding({
          manifest: value,
          lane: "release-qualified",
          platform: { os: "darwin", arch: "arm64" },
          resourceRoot: "/Keiko/Resources",
        }),
      ).toBeUndefined();
    }
  });
});

describe("portable secure workspace-read point-of-use proof", () => {
  it("proves confinement, stable same-identity bytes, digest, then signature", async () => {
    const deps = verifierDeps();
    const verified = createPortableSecureWorkspaceReadVerifier(binding(), deps);

    await expect(verified.verify(binding().artifact)).resolves.toBe(true);
    expect(deps.proveImmutableResourceTree).toHaveBeenCalledOnce();
    expect(deps.platform.openReadSameIdentity).toHaveBeenCalledWith(
      binding().executable,
      BYTES.byteLength + 1,
    );
    expect(deps.platform.verifySignature).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.platform.openReadSameIdentity).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.platform.verifySignature).mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ["symlink", { symbolicLink: true, reparsePoint: false, safeType: true }],
    ["reparse", { symbolicLink: false, reparsePoint: true, safeType: true }],
    ["unsafe type", { symbolicLink: false, reparsePoint: false, safeType: false }],
  ])("rejects a %s helper or ancestor without reading or signing", async (_label, unsafe) => {
    const deps = verifierDeps({ inspectPath: vi.fn(async () => [unsafe]) });
    const verified = createPortableSecureWorkspaceReadVerifier(binding(), deps);

    await expect(verified.verify(binding().artifact)).resolves.toBe(false);
    expect(deps.platform.openReadSameIdentity).not.toHaveBeenCalled();
    expect(deps.platform.verifySignature).not.toHaveBeenCalled();
  });

  it.each([
    ["tampered bytes", { bytes: Buffer.from("tampered") }],
    ["hard linked helper", { before: metadata({ linkCount: 2 }) }],
    ["metadata mutation", { after: metadata({ changedNs: "102" }) }],
    [
      "manifest size mismatch",
      {
        before: metadata({ size: BYTES.byteLength + 1 }),
        after: metadata({ size: BYTES.byteLength + 1 }),
      },
    ],
  ])("fails closed for %s", async (_label, changed) => {
    const read = {
      bytes: Buffer.from(BYTES),
      before: metadata(),
      after: metadata(),
      ...changed,
    };
    const deps = verifierDeps({ openReadSameIdentity: vi.fn(async () => read) });

    await expect(
      createPortableSecureWorkspaceReadVerifier(binding(), deps).verify(binding().artifact),
    ).resolves.toBe(false);
    expect(deps.platform.verifySignature).not.toHaveBeenCalled();
  });

  it("requires confinement and the final platform signature proof", async () => {
    const noConfinement = verifierDeps();
    noConfinement.proveImmutableResourceTree.mockResolvedValue(false);
    await expect(
      createPortableSecureWorkspaceReadVerifier(binding(), noConfinement).verify(
        binding().artifact,
      ),
    ).resolves.toBe(false);
    expect(noConfinement.platform.inspectPath).not.toHaveBeenCalled();

    const noSignature = verifierDeps({ verifySignature: vi.fn(async () => false) });
    await expect(
      createPortableSecureWorkspaceReadVerifier(binding(), noSignature).verify(binding().artifact),
    ).resolves.toBe(false);
  });
});
