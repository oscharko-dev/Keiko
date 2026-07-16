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

function helper(target = "macos-arm64") {
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
      verificationStatus: "verified-production",
      signatureVerified: true,
      notarizationRequired: mac,
      notarizationVerified: mac,
    },
  };
}

function manifest(target = "macos-arm64") {
  const nativeHelper = helper(target);
  const mac = target.startsWith("macos-");
  const checks = mac
    ? {
        developerIdVerified: true,
        notarizationVerified: true,
        stapleVerified: true,
        assessmentVerified: true,
      }
    : { publisherChainVerified: true, timestampVerified: true };
  const security = {
    verificationPolicy: "production",
    verificationStatus: "verified-production",
    verificationReasonCodes: [],
    signatureKind: nativeHelper.signing.signatureKind,
    signatureVerified: true,
    notarizationRequired: mac,
    notarizationVerified: mac,
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
        platformSignatureLocallyVerified: true,
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

function binding() {
  return resolvePortableSecureWorkspaceReadBinding({
    manifest: manifest(),
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
        platform,
        resourceRoot,
      })?.artifact.target,
    ).toBe(platform.os === "win32" ? "win32-x64" : `darwin-${platform.arch}`);
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
