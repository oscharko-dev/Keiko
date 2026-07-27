import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runBounded, smokePortableSecureRead } from "../portable-secure-read-smoke.mjs";
import { PORTABLE_TARGETS, validatePortableStagingManifest } from "../portable-runtime.mjs";

describe("portable secure-read bounded load runner", () => {
  it("never starts more than its bound and preserves task order", async () => {
    let active = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tasks = Array.from({ length: 9 }, (_, index) => async () => {
      active += 1;
      await gate;
      active -= 1;
      return index;
    });
    const run = runBounded(tasks, 8);
    await Promise.resolve();
    expect(active).toBe(8);
    release();
    await expect(run).resolves.toEqual({
      maxInFlight: 8,
      results: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    });
  });

  it("rejects a non-positive or non-integer concurrency bound", async () => {
    await expect(runBounded([], 0)).rejects.toThrow("invalid concurrency");
    await expect(runBounded([], 1.5)).rejects.toThrow("invalid concurrency");
  });
});

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const DIGEST_F = "f".repeat(64);
const DIGEST_1 = "1".repeat(64);
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const ROOT_PACKAGE_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
const ROOT_RELEASE_TAG = `v${ROOT_PACKAGE_VERSION}`;
const WINDOWS_TARGET = PORTABLE_TARGETS.find((target) => target.platformTarget === "windows-x64");
const HELPER_RELATIVE_PATH = "runtime/native/keiko-secure-workspace-read.exe";
const SAFE_CONTENT = "portable secure read\n";

// Reads the KSR1 request frame from stdin and answers with a protocol-faithful KSS1 frame:
// status 0 plus the exact fixture body for the safe path, a bounded empty failure otherwise.
const FAITHFUL_HELPER = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const frame = Buffer.concat(chunks);
const rootLength = frame.readUInt32LE(8);
const pathLength = frame.readUInt32LE(12);
const relativePath = frame
  .subarray(20 + rootLength, 20 + rootLength + pathLength)
  .toString("utf8");
const safe = relativePath === "src/safe.txt";
const payload = safe ? Buffer.from(${JSON.stringify(SAFE_CONTENT)}, "utf8") : Buffer.alloc(0);
const header = Buffer.alloc(12);
header.write("KSS1", 0, "ascii");
header.writeUInt16LE(1, 4);
header.writeUInt16LE(safe ? 0 : 1, 6);
header.writeUInt32LE(payload.length, 8);
process.stdout.write(Buffer.concat([header, payload]));
`;

const MALFORMED_HELPER = `
for await (const chunk of process.stdin) void chunk;
process.stdout.write(Buffer.from("JUNK", "ascii"));
`;

const UNBOUNDED_FAILURE_HELPER = `
for await (const chunk of process.stdin) void chunk;
const payload = Buffer.from("leaked body", "utf8");
const header = Buffer.alloc(12);
header.write("KSS1", 0, "ascii");
header.writeUInt16LE(1, 4);
header.writeUInt16LE(7, 6);
header.writeUInt32LE(payload.length, 8);
process.stdout.write(Buffer.concat([header, payload]));
`;

const STDERR_HELPER = `
for await (const chunk of process.stdin) void chunk;
const header = Buffer.alloc(12);
header.write("KSS1", 0, "ascii");
header.writeUInt16LE(1, 4);
header.writeUInt16LE(0, 6);
header.writeUInt32LE(0, 8);
process.stdout.write(header);
process.stderr.write("diagnostic noise");
`;

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stagingSecurity() {
  return {
    verificationPolicy: "staging",
    verificationStatus: "unverified-staging",
    verificationReasonCodes: ["staging-unverified"],
    signatureKind: "authenticode",
    signatureVerified: false,
    notarizationRequired: false,
    notarizationVerified: false,
    verificationChecks: { publisherChainVerified: false, timestampVerified: false },
    verificationSummaryPath: "evidence/signing-verification.json",
  };
}

function stagingNativeHelper(name, shippedSha256) {
  const secureRead = name === "keiko-secure-workspace-read";
  const executablePath = secureRead
    ? HELPER_RELATIVE_PATH
    : "runtime/native/keiko-runtime-supervisor.exe";
  return {
    name,
    kind: secureRead ? "secure-workspace-text-read" : "runtime-process-supervisor",
    platformTarget: "windows-x64",
    architecture: "x64",
    executablePath,
    protocol: {
      schemaVersion: 1,
      requestMagic: secureRead ? "KSR1" : "KRP1",
      responseMagic: secureRead ? "KSS1" : "KRS1",
    },
    source: {
      commitSha: COMMIT_SHA,
      path: secureRead ? "native/secure-workspace-read" : "native/runtime-supervisor/windows",
      treeSha256: DIGEST_B,
    },
    unsignedSha256: DIGEST_C,
    shippedSha256,
    sizeBytes: 4096,
    sbomBomRef: `pkg:generic/${name}@${ROOT_PACKAGE_VERSION}?platform=windows-x64`,
    signing: {
      signatureKind: "authenticode",
      verificationStatus: "unverified-staging",
      signatureVerified: false,
      notarizationRequired: false,
      notarizationVerified: false,
    },
  };
}

function stagingSidecarRuntime() {
  const root = "runtime/sidecars/opencode-compatible";
  return {
    approvalSchemaVersion: 2,
    name: "opencode-compatible",
    kind: "coding-runtime",
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
      url: "https://raw.githubusercontent.com/anomalyco/opencode/474abdd7ee60f4b67476cfcef7e5311beff4a824/packages/sdk/openapi.json",
      sha256: DIGEST_A,
      hashAlgorithm: "sha256",
      hashEncoding: "lowercase-hex",
      digestInput: "upstream-raw-bytes",
      transport: "http-sse",
    },
    releaseApproval: {
      redistribution: {
        status: "approved",
        reviewReference: "https://github.com/oscharko-dev/Keiko/issues/2253",
      },
      subscriptionAuth: {
        status: "not-applicable",
        reviewReference: "https://github.com/oscharko-dev/Keiko/issues/2253",
      },
    },
    license: {
      spdxId: "MIT",
      url: "https://raw.githubusercontent.com/anomalyco/opencode/474abdd7ee60f4b67476cfcef7e5311beff4a824/LICENSE",
      sha256: DIGEST_F,
    },
    archive: {
      platformTarget: "windows-x64",
      url: "https://github.com/anomalyco/opencode/releases/download/v1.17.17/opencode.zip",
      sizeBytes: 123456,
      sha256: DIGEST_B,
    },
    executableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
    executableTreeSha256: DIGEST_C,
    executableSha256: DIGEST_D,
    platformTarget: "windows-x64",
    payloadRootPath: root,
    executablePath: `${root}/opencode.exe`,
    payloadSha256: DIGEST_E,
    sizeBytes: 1234,
    licenseEvidence: { path: `${root}/LICENSE.txt`, sha256: DIGEST_F },
    sbomEvidence: { path: `${root}/evidence/sbom.cdx.json`, sha256: DIGEST_1 },
    signing: {
      verificationPolicy: "staging",
      verificationStatus: "unverified-staging",
      verificationReasonCodes: ["staging-unverified"],
      signatureKind: "authenticode",
      signatureVerified: false,
      notarizationRequired: false,
      notarizationVerified: false,
      verificationChecks: { publisherChainVerified: false, timestampVerified: false },
      shippedExecutableSha256: DIGEST_D,
      shippedExecutableTreeAlgorithm: "keiko-directory-tree-sha256-v1",
      shippedExecutableTreeSha256: DIGEST_C,
    },
  };
}

function stagingReviewedBinding(security, nativeHelpers, sidecarRuntimes) {
  return {
    releaseId: 0,
    releaseTag: ROOT_RELEASE_TAG,
    assetId: 0,
    assetName: "keiko-windows-x64.zip",
    assetSizeBytes: 12345678,
    platformTarget: "windows-x64",
    packageVersion: ROOT_PACKAGE_VERSION,
    nodeRuntimeIdentity: `node-v24.0.0-${WINDOWS_TARGET.runtimeTarget}`,
    archiveSha256: DIGEST_A,
    provenanceStatementSha256: DIGEST_D,
    sbomPath: "evidence/sbom.cdx.json",
    licenseNoticePath: "evidence/third-party-notices.txt",
    checksumsPath: "evidence/SHA256SUMS.txt",
    verificationPolicy: security.verificationPolicy,
    verificationStatus: security.verificationStatus,
    verificationReasonCodes: [...security.verificationReasonCodes],
    platformSignatureLocallyVerified: false,
    signatureKind: security.signatureKind,
    signatureVerified: security.signatureVerified,
    notarizationRequired: security.notarizationRequired,
    notarizationVerified: security.notarizationVerified,
    verificationChecks: { ...security.verificationChecks },
    nativeHelpers: JSON.parse(JSON.stringify(nativeHelpers)),
    sidecarRuntimes: JSON.parse(JSON.stringify(sidecarRuntimes)),
  };
}

function stagingManifest(shippedSha256) {
  const security = stagingSecurity();
  const nativeHelpers = [
    stagingNativeHelper("keiko-secure-workspace-read", shippedSha256),
    stagingNativeHelper("keiko-runtime-supervisor", DIGEST_E),
  ];
  const sidecarRuntimes = [stagingSidecarRuntime()];
  return {
    schemaVersion: 1,
    product: {
      name: "Keiko",
      packageName: "@oscharko-dev/keiko",
      packageVersion: ROOT_PACKAGE_VERSION,
    },
    release: { releaseId: 0, releaseTag: ROOT_RELEASE_TAG, stable: true, commitSha: COMMIT_SHA },
    artifact: {
      platformTarget: "windows-x64",
      assetId: 0,
      assetName: "keiko-windows-x64.zip",
      archiveFormat: "zip",
      sizeBytes: 12345678,
      sha256: DIGEST_A,
    },
    provenance: {
      sourceCommitSha: COMMIT_SHA,
      rootPackageVersion: ROOT_PACKAGE_VERSION,
      rootPackageTarballSha256: DIGEST_B,
      packagedAppTreeSha256: DIGEST_C,
      buildWorkflowRunId: 123456789,
      buildWorkflowAttempt: 1,
      provenanceStatementPath: "evidence/provenance.intoto.jsonl",
      provenanceStatementSha256: DIGEST_D,
    },
    runtime: {
      nodeVersion: "24.0.0",
      nodePlatform: "win32",
      nodeArchitecture: "x64",
      nodeDistribution: "official-nodejs-dist",
      nodeArchiveSha256: DIGEST_B,
    },
    runtimeActivation: {
      schemaVersion: 1,
      path: ".portable/runtime-activation.json",
      sha256: DIGEST_F,
      trustAnchor: "unverified-staging",
    },
    sidecarRuntimes,
    nativeHelpers,
    packageSurface: {
      source: "root-npm-package-surface",
      packageSurfaceGate: "npm run check:package-surface",
      publishManifestGate: "npm run check:publish-manifests",
      workspaceSupplyChainGate: "npm run check:workspace-supply-chain",
    },
    entrypoints: {
      primaryLauncher: "Keiko.exe",
      supportLaunchers: ["support/keiko-support.cmd"],
    },
    installLayout: {
      installMode: "portable-managed",
      bootstrapUpdateEligible: false,
      managedRootKind: "user-local-keiko-owned",
      sameVolumeStagingRequired: true,
      stateRootPolicy: "separate-local-runtime-state",
    },
    stateExclusion: {
      excludesDotKeiko: true,
      excludesCustomerData: true,
      excludesSecrets: true,
      excludesRawLogs: true,
      excludesRepositories: true,
    },
    security,
    evidence: {
      checksumsPath: "evidence/SHA256SUMS.txt",
      sbomPath: "evidence/sbom.cdx.json",
      licenseNoticePath: "evidence/third-party-notices.txt",
    },
    releaseImpact: {
      catalogPath: "app/release-impact.catalog.json",
      entryId: "release-impact-entry-id",
      entryPackageVersion: ROOT_PACKAGE_VERSION,
      entryReleaseTag: ROOT_RELEASE_TAG,
      reviewedBinding: stagingReviewedBinding(security, nativeHelpers, sidecarRuntimes),
    },
    updateEligibility: {
      stableOnly: true,
      rollbackSupported: false,
      eligibleAfterSetupOnly: true,
      requiredPredicates: {
        managedRootAttested: true,
        artifactShaVerified: true,
        platformSignatureLocallyVerified: false,
        manifestReleaseImpactBound: true,
        sameVolumeCrashSafePromotionAvailable: true,
        relaunchVersionVerificationAvailable: true,
      },
      manualOnlyWhen: [
        "managed-root-cannot-be-attested",
        "signature-or-notarization-cannot-be-verified",
        "crash-safe-promotion-unavailable",
        "admin-or-organization-managed-root",
        "prerelease-beta-downgrade-or-rollback",
      ],
    },
  };
}

describe("portable secure-read smoke qualification", () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function stageDir() {
    const dir = mkdtempSync(join(tmpdir(), "keiko-secure-read-smoke-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeHelperExecutable(stageRoot, helperBody, { executableBit = true } = {}) {
    const logicPath = join(stageRoot, "helper-logic.mjs");
    writeFileSync(logicPath, helperBody);
    const executable = join(stageRoot, "payload", "Keiko", ...HELPER_RELATIVE_PATH.split("/"));
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${logicPath}"\n`);
    chmodSync(executable, executableBit ? 0o755 : 0o644);
    return executable;
  }

  function writeManifest(stageRoot, manifest) {
    mkdirSync(join(stageRoot, "manifest"), { recursive: true });
    writeFileSync(
      join(stageRoot, "manifest", "portable-manifest.json"),
      JSON.stringify(manifest, undefined, 2),
    );
  }

  function stageWithHelper(helperBody, options = {}) {
    const stageRoot = stageDir();
    const executable = writeHelperExecutable(stageRoot, helperBody, options);
    writeManifest(stageRoot, stagingManifest(sha256OfFile(executable)));
    return stageRoot;
  }

  it("builds a staging manifest fixture the real validator accepts", () => {
    expect(validatePortableStagingManifest(stagingManifest(DIGEST_D))).toEqual([]);
  });

  it("fails closed for an unsupported platform target", async () => {
    await expect(smokePortableSecureRead(stageDir(), "amiga-68k")).rejects.toThrow(
      "portable-secure-read-smoke: target is unsupported",
    );
  });

  it("fails closed when the staged manifest fails validation", async () => {
    const stageRoot = stageDir();
    writeManifest(stageRoot, { schemaVersion: 1 });
    await expect(smokePortableSecureRead(stageRoot, "windows-x64")).rejects.toThrow(
      "portable-secure-read-smoke: manifest is invalid",
    );
  });

  it("verifies the shipped helper digest before spawning it", async () => {
    const stageRoot = stageDir();
    writeHelperExecutable(stageRoot, FAITHFUL_HELPER);
    writeManifest(stageRoot, stagingManifest(DIGEST_D));
    await expect(smokePortableSecureRead(stageRoot, "windows-x64")).rejects.toThrow(
      "portable-secure-read-smoke: helper digest does not match manifest",
    );
  });

  it("passes a faithful helper through the normal read and denied-name matrix", async () => {
    const stageRoot = stageWithHelper(FAITHFUL_HELPER);
    await expect(smokePortableSecureRead(stageRoot, "windows-x64")).resolves.toBeUndefined();
  });

  it("fails closed when the helper emits a malformed response frame", async () => {
    const stageRoot = stageWithHelper(MALFORMED_HELPER);
    await expect(smokePortableSecureRead(stageRoot, "windows-x64")).rejects.toThrow(
      "portable-secure-read-smoke: response is malformed",
    );
  });

  it("fails closed when the helper reports failure with a non-empty body", async () => {
    const stageRoot = stageWithHelper(UNBOUNDED_FAILURE_HELPER);
    await expect(smokePortableSecureRead(stageRoot, "windows-x64")).rejects.toThrow(
      "portable-secure-read-smoke: response is not bounded",
    );
  });

  it("fails closed when the helper writes to stderr", async () => {
    const stageRoot = stageWithHelper(STDERR_HELPER);
    await expect(smokePortableSecureRead(stageRoot, "windows-x64")).rejects.toThrow(
      "helper process failed closed incorrectly",
    );
  });

  it("fails closed when the helper cannot be executed", async () => {
    const stageRoot = stageWithHelper(FAITHFUL_HELPER, { executableBit: false });
    await expect(smokePortableSecureRead(stageRoot, "windows-x64")).rejects.toThrow(
      "portable-secure-read-smoke: helper process failed",
    );
  });
});
