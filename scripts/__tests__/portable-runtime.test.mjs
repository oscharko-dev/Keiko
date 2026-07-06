import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PORTABLE_TARGETS,
  safeArchiveEntryPath,
  sha256File,
  validatePortableManifest,
  verifySha256File,
} from "../portable-runtime.mjs";
import { appSurfaceFailures, assemblePortableStage } from "../stage-portable-runtime.mjs";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const DIGEST_F = "f".repeat(64);
const DIGEST_1 = "1".repeat(64);
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const NODE_VERSION = "24.14.0";
const STAGE_COMMAND_TIMEOUT_MS = 300_000;
const VERIFY_SIGNING_SCRIPT = "scripts/verify-portable-runtime-signing.mjs";
let packageSurfacePreparedForTest = false;

const BASE_MANIFEST = {
  schemaVersion: 1,
  product: {
    name: "Keiko",
    packageName: "@oscharko-dev/keiko",
    packageVersion: "0.2.11",
  },
  release: {
    releaseId: 123456789,
    releaseTag: "v0.2.11",
    stable: true,
    commitSha: COMMIT_SHA,
  },
  artifact: {
    platformTarget: "windows-x64",
    assetId: 123456789,
    assetName: "keiko-windows-x64.zip",
    archiveFormat: "zip",
    sizeBytes: 12345678,
    sha256: DIGEST_A,
  },
  provenance: {
    sourceCommitSha: COMMIT_SHA,
    rootPackageVersion: "0.2.11",
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
  security: {
    verificationPolicy: "production",
    verificationStatus: "verified-production",
    verificationReasonCodes: [],
    signatureKind: "authenticode",
    signatureVerified: true,
    notarizationRequired: false,
    notarizationVerified: false,
    verificationChecks: {
      publisherChainVerified: true,
      timestampVerified: true,
    },
    verificationSummaryPath: "evidence/signing-verification.json",
  },
  evidence: {
    checksumsPath: "evidence/SHA256SUMS.txt",
    sbomPath: "evidence/sbom.cdx.json",
    licenseNoticePath: "evidence/third-party-notices.txt",
  },
  releaseImpact: {
    catalogPath: "app/release-impact.catalog.json",
    entryId: "release-impact-entry-id",
    entryPackageVersion: "0.2.11",
    entryReleaseTag: "v0.2.11",
    reviewedBinding: {
      releaseId: 123456789,
      releaseTag: "v0.2.11",
      assetId: 123456789,
      assetName: "keiko-windows-x64.zip",
      assetSizeBytes: 12345678,
      platformTarget: "windows-x64",
      packageVersion: "0.2.11",
      nodeRuntimeIdentity: "node-v24.0.0-win32-x64",
      archiveSha256: DIGEST_A,
      provenanceStatementSha256: DIGEST_D,
      sbomPath: "evidence/sbom.cdx.json",
      licenseNoticePath: "evidence/third-party-notices.txt",
      checksumsPath: "evidence/SHA256SUMS.txt",
      verificationPolicy: "production",
      verificationStatus: "verified-production",
      verificationReasonCodes: [],
      platformSignatureLocallyVerified: true,
      signatureKind: "authenticode",
      signatureVerified: true,
      notarizationRequired: false,
      notarizationVerified: false,
      verificationChecks: {
        publisherChainVerified: true,
        timestampVerified: true,
      },
    },
  },
  updateEligibility: {
    stableOnly: true,
    rollbackSupported: false,
    eligibleAfterSetupOnly: true,
    requiredPredicates: {
      managedRootAttested: true,
      artifactShaVerified: true,
      platformSignatureLocallyVerified: true,
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

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function manifest() {
  return JSON.parse(JSON.stringify(BASE_MANIFEST));
}

function digestFor(text) {
  return createHash("sha256").update(text).digest("hex");
}

function digestBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "keiko-portable-runtime-test-"));
  tempDirs.push(dir);
  return dir;
}

function portableTarget(platformTarget) {
  const target = PORTABLE_TARGETS.find((candidate) => candidate.platformTarget === platformTarget);
  if (target === undefined) throw new Error(`unknown portable target: ${platformTarget}`);
  return target;
}

function createNodeArchiveFixture(dir, platformTarget, options = {}) {
  const target = portableTarget(platformTarget);
  const rootName = `node-v${NODE_VERSION}-${target.nodeArchiveTarget}`;
  const sourceParent = join(dir, `node-fixture-${platformTarget}`);
  const sourceRoot = join(sourceParent, rootName);
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "LICENSE"), "Node.js fixture license\n");
  writeFixtureNodeLauncher(target, sourceRoot);
  if (options.unsafeSymlinkTarget !== undefined) {
    symlinkSync(options.unsafeSymlinkTarget, join(sourceRoot, "unsafe-link"));
  }
  const archivePath = join(dir, `${rootName}.${target.nodeArchiveExtension}`);
  packNodeFixtureArchive(target, archivePath, sourceParent, rootName, options);
  return { path: archivePath, sha256: digestBuffer(readFileSync(archivePath)) };
}

function writeFixtureNodeLauncher(target, sourceRoot) {
  if (target.nodePlatform === "win32") {
    writeFileSync(join(sourceRoot, "node.exe"), "fixture-node\n");
    return;
  }
  mkdirSync(join(sourceRoot, "bin"), { recursive: true });
  writeFileSync(join(sourceRoot, "bin", "node"), "fixture-node\n");
}

function packNodeFixtureArchive(target, archivePath, sourceParent, rootName, options) {
  if (target.nodeArchiveExtension === "zip") {
    runFixtureCommand(
      "zip",
      [options.preserveSymlinks ? "-yqr" : "-qr", archivePath, rootName],
      sourceParent,
    );
    return;
  }
  runFixtureCommand("tar", ["-czf", archivePath, "-C", sourceParent, rootName], sourceParent);
}

function runFixtureCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function runStage(args) {
  return spawnSync(process.execPath, ["scripts/stage-portable-runtime.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: STAGE_COMMAND_TIMEOUT_MS,
  });
}

function runSigningVerify(args) {
  return spawnSync(process.execPath, [VERIFY_SIGNING_SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: STAGE_COMMAND_TIMEOUT_MS,
  });
}

function windowsVerificationChecks(overrides = {}) {
  return {
    publisherChainVerified: true,
    timestampVerified: true,
    ...overrides,
  };
}

function macVerificationChecks(overrides = {}) {
  return {
    developerIdVerified: true,
    notarizationVerified: true,
    stapleVerified: true,
    assessmentVerified: true,
    ...overrides,
  };
}

function defaultVerificationChecks(target) {
  return target.nodePlatform === "win32" ? windowsVerificationChecks() : macVerificationChecks();
}

function platformSignatureLocallyVerified(candidate) {
  const target = portableTarget(candidate.artifact.platformTarget);
  const checks = candidate.security.verificationChecks;
  if (target.nodePlatform === "win32") {
    return (
      candidate.security.signatureVerified === true &&
      checks.publisherChainVerified === true &&
      checks.timestampVerified === true
    );
  }
  return (
    candidate.security.signatureVerified === true &&
    candidate.security.notarizationVerified === true &&
    checks.developerIdVerified === true &&
    checks.notarizationVerified === true &&
    checks.stapleVerified === true &&
    checks.assessmentVerified === true
  );
}

function syncReviewedBinding(candidate) {
  candidate.releaseImpact.reviewedBinding = {
    ...candidate.releaseImpact.reviewedBinding,
    assetId: candidate.artifact.assetId,
    assetName: candidate.artifact.assetName,
    assetSizeBytes: candidate.artifact.sizeBytes,
    platformTarget: candidate.artifact.platformTarget,
    archiveSha256: candidate.artifact.sha256,
    packageVersion: candidate.product.packageVersion,
    nodeRuntimeIdentity: `node-v${candidate.runtime.nodeVersion}-${portableTarget(candidate.artifact.platformTarget).runtimeTarget}`,
    provenanceStatementSha256: candidate.provenance.provenanceStatementSha256,
    checksumsPath: candidate.evidence.checksumsPath,
    licenseNoticePath: candidate.evidence.licenseNoticePath,
    sbomPath: candidate.evidence.sbomPath,
    verificationPolicy: candidate.security.verificationPolicy,
    verificationStatus: candidate.security.verificationStatus,
    verificationReasonCodes: [...candidate.security.verificationReasonCodes],
    platformSignatureLocallyVerified: platformSignatureLocallyVerified(candidate),
    signatureKind: candidate.security.signatureKind,
    signatureVerified: candidate.security.signatureVerified,
    notarizationRequired: candidate.security.notarizationRequired,
    notarizationVerified: candidate.security.notarizationVerified,
    verificationChecks: { ...candidate.security.verificationChecks },
  };
  if (Array.isArray(candidate.sidecarRuntimes) && candidate.sidecarRuntimes.length > 0) {
    candidate.releaseImpact.reviewedBinding.sidecarRuntimes = JSON.parse(
      JSON.stringify(candidate.sidecarRuntimes),
    );
  } else {
    delete candidate.releaseImpact.reviewedBinding.sidecarRuntimes;
  }
  candidate.updateEligibility.requiredPredicates.platformSignatureLocallyVerified =
    platformSignatureLocallyVerified(candidate);
}

function setManifestTarget(candidate, platformTarget) {
  const target = portableTarget(platformTarget);
  candidate.artifact.platformTarget = target.platformTarget;
  candidate.artifact.assetName = target.assetName;
  candidate.runtime.nodePlatform = target.nodePlatform;
  candidate.runtime.nodeArchitecture = target.nodeArchitecture;
  candidate.entrypoints.primaryLauncher = target.primaryLauncher;
  candidate.entrypoints.supportLaunchers =
    target.nodePlatform === "win32" ? ["support/keiko-support.cmd"] : ["support/keiko-support.sh"];
  candidate.security.signatureKind = target.signatureKind;
  candidate.security.notarizationRequired = target.nodePlatform === "darwin";
  candidate.security.notarizationVerified = target.nodePlatform !== "darwin";
  candidate.security.verificationChecks = defaultVerificationChecks(target);
  syncReviewedBinding(candidate);
}

function setVerificationState(candidate, options = {}) {
  const target = portableTarget(candidate.artifact.platformTarget);
  const checks = options.verificationChecks ?? defaultVerificationChecks(target);
  candidate.security.verificationPolicy = options.verificationPolicy ?? "production";
  candidate.security.verificationStatus = options.verificationStatus ?? "verified-production";
  candidate.security.verificationReasonCodes = options.verificationReasonCodes ?? [];
  candidate.security.verificationChecks = checks;
  candidate.security.signatureVerified =
    target.nodePlatform === "win32"
      ? checks.publisherChainVerified === true && checks.timestampVerified === true
      : checks.developerIdVerified === true;
  candidate.security.notarizationRequired = target.nodePlatform === "darwin";
  candidate.security.notarizationVerified =
    target.nodePlatform === "darwin" ? checks.notarizationVerified === true : false;
  syncReviewedBinding(candidate);
}

function writeManifestFixture(candidate, dir) {
  const stageRoot = join(dir, "portable-runtime");
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  mkdirSync(join(stageRoot, "manifest"), { recursive: true });
  mkdirSync(join(stageRoot, "evidence"), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(candidate, null, 2) + "\n");
  return { manifestPath, stageRoot };
}

function writeVerificationInput(dir, input) {
  const path = join(dir, "verification-input.json");
  writeFileSync(path, JSON.stringify(input, null, 2) + "\n");
  return path;
}

function preparePackageSurfaceForTest() {
  if (packageSurfacePreparedForTest) return;
  runFixtureCommand("npm", ["run", "build"], process.cwd());
  runFixtureCommand("npm", ["run", "prepare:bin"], process.cwd());
  packageSurfacePreparedForTest = true;
}

async function assembleStageForTest(target, nodeArchive, outDir, dir, sidecarRuntimeSpecs = []) {
  return assemblePortableStage(
    {
      commitSha: COMMIT_SHA,
      dryRun: false,
      nodeArchive: nodeArchive.path,
      nodeArchiveUrl: undefined,
      nodeCacheDir: join(dir, "cache"),
      nodeSha256: nodeArchive.sha256,
      nodeVersion: NODE_VERSION,
      outDir,
      releaseId: 123456789,
      releaseTag: "v0.2.11",
      sidecarRuntimeSpecs,
      target,
    },
    {
      buildPrimaryLauncher: writePrimaryLauncherFixture,
      preparePackageSurface: preparePackageSurfaceForTest,
    },
  );
}

function writePrimaryLauncherFixture(target, destination) {
  writeFileSync(destination, `fixture native launcher for ${target.platformTarget}\n`);
}

function sidecarRuntimeFor(platformTarget, overrides = {}) {
  const target = portableTarget(platformTarget);
  const name = overrides.name ?? "opencode-compatible";
  const payloadRootPath = `runtime/sidecars/${name}`;
  return {
    name,
    kind: "coding-runtime",
    upstream: { name: "OpenCode-compatible", version: "1.0.0" },
    adapterCompatibility: {
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      protocolVersion: "coding-sidecar-v1",
    },
    platformTarget,
    payloadRootPath,
    executablePath: sidecarExecutablePath(payloadRootPath, target),
    payloadSha256: DIGEST_E,
    sizeBytes: 1234,
    licenseEvidence: { path: `${payloadRootPath}/LICENSE.txt`, sha256: DIGEST_F },
    sbomEvidence: { path: `${payloadRootPath}/evidence/sbom.cdx.json`, sha256: DIGEST_1 },
    signing: verifiedSidecarSigning(target),
    ...overrides,
  };
}

function sidecarExecutablePath(payloadRootPath, target) {
  return target.nodePlatform === "win32"
    ? `${payloadRootPath}/opencode.cmd`
    : `${payloadRootPath}/bin/opencode`;
}

function verifiedSidecarSigning(target) {
  const verificationChecks =
    target.nodePlatform === "win32" ? windowsVerificationChecks() : macVerificationChecks();
  return {
    verificationPolicy: "production",
    verificationStatus: "verified-production",
    verificationReasonCodes: [],
    signatureKind: target.signatureKind,
    signatureVerified: true,
    notarizationRequired: target.nodePlatform === "darwin",
    notarizationVerified: target.nodePlatform === "darwin",
    verificationChecks,
  };
}

function addSidecarRuntime(candidate, platformTarget, overrides = {}) {
  candidate.sidecarRuntimes = [sidecarRuntimeFor(platformTarget, overrides)];
  syncReviewedBinding(candidate);
}

function createSidecarFixture(dir, platformTarget, overrides = {}) {
  const target = portableTarget(platformTarget);
  const sourceRoot = join(dir, `sidecar-${platformTarget}`);
  const executablePath = target.nodePlatform === "win32" ? "opencode.cmd" : "bin/opencode";
  mkdirSync(join(sourceRoot, "bin"), { recursive: true });
  mkdirSync(join(sourceRoot, "evidence"), { recursive: true });
  writeFileSync(join(sourceRoot, executablePath), `fixture opencode for ${platformTarget}\n`);
  writeFileSync(join(sourceRoot, "LICENSE.txt"), "OpenCode-compatible fixture license\n");
  writeFileSync(join(sourceRoot, "evidence", "sbom.cdx.json"), '{"bomFormat":"CycloneDX"}\n');
  return sidecarFixtureSpec(platformTarget, sourceRoot, executablePath, overrides);
}

function sidecarFixtureSpec(platformTarget, sourceRoot, executablePath, overrides) {
  return {
    name: "opencode-compatible",
    kind: "coding-runtime",
    upstream: { name: "OpenCode-compatible", version: "1.0.0" },
    adapterCompatibility: {
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      protocolVersion: "coding-sidecar-v1",
    },
    platformTarget,
    sourceRoot,
    executablePath,
    licenseEvidencePath: "LICENSE.txt",
    sbomEvidencePath: "evidence/sbom.cdx.json",
    ...overrides,
  };
}

function stageArgs(dir, platformTarget, nodeArchive, sidecarSpec) {
  return [
    "--target",
    platformTarget,
    "--node-archive",
    nodeArchive.path,
    "--node-sha256",
    nodeArchive.sha256,
    "--node-version",
    NODE_VERSION,
    "--commit-sha",
    COMMIT_SHA,
    "--release-id",
    "123456789",
    "--release-tag",
    "v0.2.11",
    "--node-cache-dir",
    join(dir, "cache"),
    "--out-dir",
    join(dir, "out"),
    "--sidecar-runtime-spec",
    JSON.stringify(sidecarSpec),
  ];
}

describe("portable runtime target contract", () => {
  it("defines exactly the first-class portable release targets", () => {
    expect(
      PORTABLE_TARGETS.map((target) => ({
        assetName: target.assetName,
        platformTarget: target.platformTarget,
      })),
    ).toEqual([
      { assetName: "keiko-windows-x64.zip", platformTarget: "windows-x64" },
      { assetName: "keiko-macos-arm64.zip", platformTarget: "macos-arm64" },
      { assetName: "keiko-macos-x64.zip", platformTarget: "macos-x64" },
    ]);
  });
});

describe("safeArchiveEntryPath", () => {
  it("accepts contained Keiko archive entries", () => {
    expect(safeArchiveEntryPath("Keiko/app/package.json")).toBe("Keiko/app/package.json");
  });

  it("rejects traversal, absolute, drive-relative, UNC, and wrong-root entries", () => {
    expect(safeArchiveEntryPath("../Keiko/app/package.json")).toBeUndefined();
    expect(safeArchiveEntryPath("/Keiko/app/package.json")).toBeUndefined();
    expect(safeArchiveEntryPath("C:Keiko/app/package.json")).toBeUndefined();
    expect(safeArchiveEntryPath("\\\\server\\share\\Keiko\\app")).toBeUndefined();
    expect(safeArchiveEntryPath("Other/app/package.json")).toBeUndefined();
  });
});

describe("verifySha256File", () => {
  it("passes for the expected file digest and rejects mismatches", async () => {
    const dir = tempDir();
    const path = join(dir, "node.zip");
    writeFileSync(path, "node-runtime");

    await expect(verifySha256File(path, digestFor("node-runtime"))).resolves.toBe(
      digestFor("node-runtime"),
    );
    await expect(verifySha256File(path, DIGEST_A)).rejects.toThrow("SHA-256 mismatch");
  });
});

describe("validatePortableManifest", () => {
  it("accepts a complete production manifest", () => {
    expect(validatePortableManifest(manifest())).toEqual([]);
  });

  it("accepts manifests with absent or empty sidecar runtimes", () => {
    expect(validatePortableManifest(manifest())).toEqual([]);
    const candidate = manifest();
    candidate.sidecarRuntimes = [];

    expect(validatePortableManifest(candidate)).toEqual([]);
  });

  it("accepts generic sidecar runtime metadata for every portable target", () => {
    for (const platformTarget of ["windows-x64", "macos-arm64", "macos-x64"]) {
      const candidate = manifest();
      setManifestTarget(candidate, platformTarget);
      setVerificationState(candidate);
      addSidecarRuntime(candidate, platformTarget);

      expect(validatePortableManifest(candidate)).toEqual([]);
    }
  });

  it("rejects sidecar platform drift, missing evidence, and production signing gaps", () => {
    const candidate = manifest();
    addSidecarRuntime(candidate, "macos-arm64");
    delete candidate.sidecarRuntimes[0].licenseEvidence;
    candidate.sidecarRuntimes[0].signing.signatureVerified = false;

    const failures = validatePortableManifest(candidate).join("\n");
    expect(failures).toContain("sidecarRuntimes[0].platformTarget: must match artifact");
    expect(failures).toContain("sidecarRuntimes[0].licenseEvidence: is required");
    expect(failures).toContain("sidecarRuntimes[0].signing.signatureVerified: must be true");
  });

  it("rejects sidecar runtimes without production signing metadata", () => {
    const candidate = manifest();
    addSidecarRuntime(candidate, "windows-x64");
    delete candidate.sidecarRuntimes[0].signing;
    syncReviewedBinding(candidate);

    const failures = validatePortableManifest(candidate).join("\n");
    expect(failures).toContain("sidecarRuntimes[0].signing: is required");
  });

  it("rejects sidecar path traversal and release-impact binding drift", () => {
    const candidate = manifest();
    addSidecarRuntime(candidate, "windows-x64", {
      executablePath: "../opencode.cmd",
    });
    candidate.releaseImpact.reviewedBinding.sidecarRuntimes[0].payloadSha256 = DIGEST_A;

    const failures = validatePortableManifest(candidate).join("\n");
    expect(failures).toContain("sidecarRuntimes[0].executablePath");
    expect(failures).toContain("releaseImpact.reviewedBinding.sidecarRuntimes");
  });

  it("rejects sidecar metadata that carries private or forbidden payload references", () => {
    const candidate = manifest();
    addSidecarRuntime(candidate, "windows-x64");
    candidate.sidecarRuntimes[0].upstream.name = "/Users/customer/opencode";
    candidate.sidecarRuntimes[0].sbomEvidence.path =
      "runtime/sidecars/opencode-compatible/.keiko/sbom.cdx.json";
    syncReviewedBinding(candidate);

    const failures = validatePortableManifest(candidate).join("\n");
    expect(failures).toContain("sidecarRuntimes[0].upstream.name");
    expect(failures).toContain("contains forbidden payload reference .keiko");
  });

  it("rejects target and asset mismatches", () => {
    const candidate = manifest();
    candidate.artifact.platformTarget = "macos-arm64";

    expect(validatePortableManifest(candidate).join("\n")).toContain(
      "artifact.assetName: must be keiko-macos-arm64.zip",
    );
  });

  it("rejects secrets, private paths, credential URLs, and state payload references", () => {
    const candidate = manifest();
    candidate.evidence.checksumsPath = "\\\\server\\share\\SHA256SUMS.txt";
    candidate.evidence.sbomPath = "https://user:pass@example.com/sbom.json";
    candidate.releaseImpact.entryId = "/private/var/folders/customer/capsules.db";

    const failures = validatePortableManifest(candidate).join("\n");
    expect(failures).toContain("evidence.checksumsPath: must be a relative contained path");
    expect(failures).toContain("evidence.sbomPath: must be a relative contained path");
    expect(failures).toContain("releaseImpact.entryId: contains secret-like or private-path text");
    expect(failures).toContain("releaseImpact.entryId: contains forbidden payload reference");
  });

  it("rejects raw log and package-manager output fields", () => {
    const candidate = manifest();
    candidate.evidence.rawLogsPath = "logs/session.log";
    candidate.releaseImpact.packageManagerOutput = "npm ERR! raw install output";

    const failures = validatePortableManifest(candidate).join("\n");
    expect(failures).toContain("evidence.rawLogsPath: uses a forbidden manifest key");
    expect(failures).toContain("releaseImpact.packageManagerOutput: uses a forbidden manifest key");
  });

  it("rejects rollback eligibility and unverified platform signatures", () => {
    const candidate = manifest();
    candidate.updateEligibility.rollbackSupported = true;
    setVerificationState(candidate, {
      verificationChecks: windowsVerificationChecks({ publisherChainVerified: false }),
      verificationReasonCodes: ["windows-publisher-chain-unverified"],
      verificationStatus: "verification-failed",
    });

    const failures = validatePortableManifest(candidate).join("\n");
    expect(failures).toContain("updateEligibility.rollbackSupported: must be false");
    expect(failures).toContain("security.signatureVerified: must be true");
    expect(failures).toContain("platformSignatureLocallyVerified");
  });

  it("accepts unsigned manifests only in explicit unverified staging mode", () => {
    const candidate = manifest();
    setVerificationState(candidate, {
      verificationChecks: windowsVerificationChecks({
        publisherChainVerified: false,
        timestampVerified: false,
      }),
      verificationPolicy: "staging",
      verificationReasonCodes: ["staging-unverified"],
      verificationStatus: "unverified-staging",
    });

    expect(validatePortableManifest(candidate).join("\n")).toContain(
      "security.signatureVerified: must be true",
    );
    expect(validatePortableManifest(candidate, { allowUnverified: true })).toEqual([]);
  });

  it("reserves missing release asset ids for explicit unverified staging mode", () => {
    const candidate = manifest();
    candidate.artifact.assetId = 0;
    setVerificationState(candidate, {
      verificationChecks: windowsVerificationChecks({
        publisherChainVerified: false,
        timestampVerified: false,
      }),
      verificationPolicy: "staging",
      verificationReasonCodes: ["staging-unverified"],
      verificationStatus: "unverified-staging",
    });

    expect(validatePortableManifest(candidate).join("\n")).toContain(
      "artifact.assetId: must be greater than 0",
    );
    expect(validatePortableManifest(candidate, { allowUnverified: true })).toEqual([]);
  });

  it("requires explicit verification policy metadata for production manifests", () => {
    const candidate = manifest();
    delete candidate.security.verificationPolicy;

    const failures = validatePortableManifest(candidate).join("\n");
    expect(failures).toContain("security.verificationPolicy: is required");
  });

  it("requires equal macOS verification checks for both macOS targets", () => {
    for (const platformTarget of ["macos-arm64", "macos-x64"]) {
      const candidate = manifest();
      setManifestTarget(candidate, platformTarget);
      setVerificationState(candidate, {
        verificationChecks: macVerificationChecks({ stapleVerified: false }),
        verificationReasonCodes: ["macos-staple-unverified"],
        verificationStatus: "verification-failed",
      });

      const failures = validatePortableManifest(candidate).join("\n");
      expect(failures).toContain(
        "updateEligibility.requiredPredicates.platformSignatureLocallyVerified",
      );
    }
  });

  it("rejects reviewed binding drift from the manifest", () => {
    const candidate = manifest();
    candidate.releaseImpact.reviewedBinding.releaseId = 999;
    candidate.releaseImpact.reviewedBinding.checksumsPath = "evidence/other.txt";
    candidate.releaseImpact.reviewedBinding.signatureKind = "bogus";

    const failures = validatePortableManifest(candidate).join("\n");
    expect(failures).toContain("releaseImpact.reviewedBinding.releaseId");
    expect(failures).toContain("releaseImpact.reviewedBinding.checksumsPath");
    expect(failures).toContain("releaseImpact.reviewedBinding.signatureKind");
  });
});

describe("portable runtime package scripts", () => {
  it("wires manifest checks into package and publish gates", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));

    expect(scripts["check:portable-manifest"]).toContain("check-portable-runtime-manifest.mjs");
    expect(scripts["portable:stage"]).toContain("stage-portable-runtime.mjs");
    expect(scripts["portable:verify-signing"]).toContain("verify-portable-runtime-signing.mjs");
    for (const scriptName of ["prepack", "prepublishOnly"]) {
      const script = scripts[scriptName];
      expect(script.indexOf("npm run check:publish-manifests")).toBeLessThan(
        script.indexOf("npm run check:portable-manifest"),
      );
      expect(script.indexOf("npm run check:portable-manifest")).toBeLessThan(
        script.indexOf("npm run check:release-impact"),
      );
    }
  });

  it("packs the prepared package surface without recursively running lifecycle scripts", () => {
    const source = readFileSync("scripts/stage-portable-runtime.mjs", "utf8");

    expect(source).toContain('"--ignore-scripts"');
    expect(source).toContain('"--pack-destination"');
    expect(source).toContain('["run", "check:package-surface"]');
    expect(
      source.indexOf("(hooks.preparePackageSurface ?? preparePackageSurface)();"),
    ).toBeLessThan(source.indexOf("const tarball = packRoot(dirname(paths.extractRoot));"));
    expect(source).toContain("await assemblePortableStage(options);");
    expect(source).not.toContain('["install"');
  });

  it("validates the staged app package surface before archive assembly", () => {
    const dir = tempDir();
    const appRoot = join(dir, "app");
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(appRoot, "package.json"), JSON.stringify({ name: "@oscharko-dev/keiko" }));

    expect(appSurfaceFailures(appRoot)).toContain("dist/cli/index.js is required");
    expect(appSurfaceFailures(appRoot)).toContain("package.json version must match root");
  });
});

describe("verify-portable-runtime-signing", () => {
  it("fails closed for production artifacts when Windows publisher-chain verification fails", () => {
    const dir = tempDir();
    const candidate = manifest();
    const { manifestPath } = writeManifestFixture(candidate, dir);
    const verificationInput = writeVerificationInput(dir, {
      reasonCodes: ["credential-unavailable"],
      verificationChecks: {
        publisherChainVerified: false,
        timestampVerified: true,
      },
    });

    const result = runSigningVerify([
      "--manifest",
      manifestPath,
      "--policy",
      "production",
      "--verification-input",
      verificationInput,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("portable-signing verify failed");
    expect(result.stderr).toContain("windows-publisher-chain-unverified");
    const manifestAfter = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifestAfter.security.verificationStatus).toBe("verification-failed");
    expect(manifestAfter.security.verificationReasonCodes).toContain(
      "windows-publisher-chain-unverified",
    );
    expect(
      manifestAfter.updateEligibility.requiredPredicates.platformSignatureLocallyVerified,
    ).toBe(false);
  });

  it("allows unsigned pull-request artifacts but marks them as non-production", () => {
    const dir = tempDir();
    const candidate = manifest();
    const { manifestPath, stageRoot } = writeManifestFixture(candidate, dir);

    const result = runSigningVerify(["--manifest", manifestPath, "--policy", "pull-request"]);

    expect(result.status).toBe(0);
    const manifestAfter = JSON.parse(readFileSync(manifestPath, "utf8"));
    const summary = JSON.parse(
      readFileSync(join(stageRoot, "evidence", "signing-verification.json"), "utf8"),
    );
    expect(manifestAfter.security.verificationPolicy).toBe("pull-request");
    expect(manifestAfter.security.verificationStatus).toBe("unsigned-non-production");
    expect(manifestAfter.security.verificationReasonCodes).toEqual([
      "non-production-artifact",
      "non-production-unsigned-allowed",
      "windows-publisher-chain-unverified",
      "windows-timestamp-unverified",
    ]);
    expect(summary.status).toBe("unsigned-non-production");
    expect(summary.policy).toBe("pull-request");
    expect(summary.platformSignatureLocallyVerified).toBe(false);
  });

  it("rejects verification input that tries to persist certificate internals or raw logs", () => {
    const dir = tempDir();
    const candidate = manifest();
    const { manifestPath } = writeManifestFixture(candidate, dir);
    const verificationInput = writeVerificationInput(dir, {
      rawLog: "codesign output",
      verificationChecks: {
        publisherChainVerified: true,
        timestampVerified: true,
      },
    });

    const result = runSigningVerify([
      "--manifest",
      manifestPath,
      "--policy",
      "production",
      "--verification-input",
      verificationInput,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported verification input key: rawLog");
  });

  it("applies the same production notarization checks to both macOS architectures", () => {
    for (const platformTarget of ["macos-arm64", "macos-x64"]) {
      const dir = tempDir();
      const candidate = manifest();
      setManifestTarget(candidate, platformTarget);
      const { manifestPath } = writeManifestFixture(candidate, dir);
      const verificationInput = writeVerificationInput(dir, {
        verificationChecks: {
          developerIdVerified: true,
          notarizationVerified: true,
          stapleVerified: false,
          assessmentVerified: true,
        },
      });

      const result = runSigningVerify([
        "--manifest",
        manifestPath,
        "--policy",
        "production",
        "--verification-input",
        verificationInput,
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("macos-staple-unverified");
      const manifestAfter = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifestAfter.security.verificationStatus).toBe("verification-failed");
      expect(manifestAfter.security.verificationChecks).toEqual({
        assessmentVerified: true,
        developerIdVerified: true,
        notarizationVerified: true,
        stapleVerified: false,
      });
    }
  });
});

describe("stage-portable-runtime", () => {
  it("stages macOS resources under the app bundle and binds the sidecar manifest to ZIP bytes", async () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "macos-arm64");
    const sidecarSpec = createSidecarFixture(dir, "macos-arm64");
    const outDir = join(dir, "out");

    await assembleStageForTest("macos-arm64", nodeArchive, outDir, dir, [sidecarSpec]);
    const root = join(outDir, "macos-arm64");
    const assetPath = join(root, "keiko-macos-arm64.zip");
    const manifestPath = join(root, "manifest", "portable-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(manifest.artifact.sha256).toBe(await sha256File(assetPath));
    expect(manifest.artifact.sizeBytes).toBe(statSync(assetPath).size);
    expect(manifest.runtime.nodeVersion).toBe(NODE_VERSION);
    expect(manifest.releaseImpact.reviewedBinding.nodeRuntimeIdentity).toBe(
      `node-v${NODE_VERSION}-darwin-arm64`,
    );
    expect(manifest.sidecarRuntimes).toHaveLength(1);
    expect(manifest.sidecarRuntimes[0]).toMatchObject({
      name: "opencode-compatible",
      kind: "coding-runtime",
      platformTarget: "macos-arm64",
      payloadRootPath: "runtime/sidecars/opencode-compatible",
      executablePath: "runtime/sidecars/opencode-compatible/bin/opencode",
    });
    expect(manifest.sidecarRuntimes[0].sourceRoot).toBeUndefined();
    expect(manifest.releaseImpact.reviewedBinding.sidecarRuntimes).toEqual(
      manifest.sidecarRuntimes,
    );
    expect(manifest.security.signatureVerified).toBe(false);
    expect(manifest.security.notarizationVerified).toBe(false);
    expect(manifest.security.verificationPolicy).toBe("staging");
    expect(manifest.security.verificationStatus).toBe("unverified-staging");
    expect(manifest.security.verificationReasonCodes).toEqual(["staging-unverified"]);
    expect(manifest.security.verificationChecks).toEqual({
      assessmentVerified: false,
      developerIdVerified: false,
      notarizationVerified: false,
      stapleVerified: false,
    });
    expect(manifest.artifact.assetId).toBe(0);
    expect(manifest.releaseImpact.reviewedBinding.assetId).toBe(0);
    expect(manifest.releaseImpact.entryId).toBe(
      "2026-07-05-keiko-0.2.11-portable-runtime-staging-contract",
    );
    expect(manifest.updateEligibility.requiredPredicates.platformSignatureLocallyVerified).toBe(
      false,
    );
    expect(readFileSync(join(root, "evidence", "SHA256SUMS.txt"), "utf8")).toContain(
      `${manifest.artifact.sha256}  keiko-macos-arm64.zip`,
    );
    expect(
      JSON.parse(readFileSync(join(root, "evidence", "signing-verification.json"), "utf8")).status,
    ).toBe("unverified-staging");
    expect(
      JSON.parse(readFileSync(join(root, "evidence", "signing-verification.json"), "utf8"))
        .sidecarRuntimes[0].signingStatus,
    ).toBe("unverified-staging");
    expect(
      JSON.parse(readFileSync(join(root, "evidence", "signing-verification.json"), "utf8")).policy,
    ).toBe("staging");
    expect(
      existsSync(join(root, "payload", "Keiko", "Keiko.app", "Contents", "Resources", "app")),
    ).toBe(true);
    expect(
      existsSync(
        join(
          root,
          "payload",
          "Keiko",
          "Keiko.app",
          "Contents",
          "Resources",
          "app",
          "dist",
          "cli",
          "index.js",
        ),
      ),
    ).toBe(true);
    const catalog = JSON.parse(
      readFileSync(
        join(
          root,
          "payload",
          "Keiko",
          "Keiko.app",
          "Contents",
          "Resources",
          "app",
          "release-impact.catalog.json",
        ),
        "utf8",
      ),
    );
    const releaseImpactEntry = catalog.entries.find(
      (entry) => entry.id === manifest.releaseImpact.entryId,
    );
    expect(releaseImpactEntry?.portableRuntimeArtifactContract).toEqual({
      programEpic: 1944,
      parentEpic: 1942,
      issue: 1948,
      stagingOnly: true,
      targets: ["windows-x64", "macos-arm64", "macos-x64"],
    });
    expect(
      existsSync(join(root, "payload", "Keiko", "Keiko.app", "Contents", "Resources", "runtime")),
    ).toBe(true);
    expect(
      existsSync(
        join(
          root,
          "payload",
          "Keiko",
          "Keiko.app",
          "Contents",
          "Resources",
          "runtime",
          "sidecars",
          "opencode-compatible",
          "bin",
          "opencode",
        ),
      ),
    ).toBe(true);
    const setupManifest = JSON.parse(
      readFileSync(
        join(
          root,
          "payload",
          "Keiko",
          "Keiko.app",
          "Contents",
          "Resources",
          ".portable",
          "setup-manifest.json",
        ),
        "utf8",
      ),
    );
    expect(setupManifest).toMatchObject({
      schemaVersion: 1,
      platformTarget: "macos-arm64",
      packageName: "@oscharko-dev/keiko",
      packageVersion: "0.2.11",
      primaryLauncher: "Keiko.app",
      bootstrapUpdateEligible: false,
    });
    expect(
      existsSync(
        join(
          root,
          "payload",
          "Keiko",
          "Keiko.app",
          "Contents",
          "Resources",
          "runtime",
          "node",
          "bin",
          "node",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          root,
          "payload",
          "Keiko",
          "Keiko.app",
          "Contents",
          "Resources",
          "runtime",
          "node",
          "LICENSE",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          root,
          "payload",
          "Keiko",
          "Keiko.app",
          "Contents",
          "Resources",
          "runtime",
          "node",
          "NOTICE",
        ),
      ),
    ).toBe(true);
    const supportScript = readFileSync(
      join(root, "payload", "Keiko", "support", "keiko-support.sh"),
      "utf8",
    );
    expect(supportScript).toContain('SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)');
    expect(supportScript).toContain('exec "$SCRIPT_DIR/../Keiko.app/Contents/MacOS/Keiko" "$@"');
    expect(existsSync(join(root, "payload", "Keiko", "app"))).toBe(false);
  }, 360_000);

  it("stages Windows resources with an extracted bundled Node runtime", async () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "windows-x64");
    const sidecarSpec = createSidecarFixture(dir, "windows-x64");
    const outDir = join(dir, "out");

    await assembleStageForTest("windows-x64", nodeArchive, outDir, dir, [sidecarSpec]);

    const runtimeRoot = join(outDir, "windows-x64", "payload", "Keiko", "runtime", "node");
    const sidecarRoot = join(
      outDir,
      "windows-x64",
      "payload",
      "Keiko",
      "runtime",
      "sidecars",
      "opencode-compatible",
    );
    expect(existsSync(join(runtimeRoot, "node.exe"))).toBe(true);
    expect(existsSync(join(runtimeRoot, "LICENSE"))).toBe(true);
    expect(existsSync(join(runtimeRoot, "NOTICE"))).toBe(true);
    expect(existsSync(join(sidecarRoot, "opencode.cmd"))).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(outDir, "windows-x64", "payload", "Keiko", ".portable", "setup-manifest.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      platformTarget: "windows-x64",
      primaryLauncher: "Keiko.exe",
      runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
    });
    const supportScript = readFileSync(
      join(outDir, "windows-x64", "payload", "Keiko", "support", "keiko-support.cmd"),
      "utf8",
    );
    expect(supportScript).toContain('set "SCRIPT_DIR=%~dp0"');
    expect(supportScript).toContain('"%SCRIPT_DIR%..\\Keiko.exe" %*');
    const manifestPath = join(outDir, "windows-x64", "manifest", "portable-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.security.verificationChecks).toEqual({
      publisherChainVerified: false,
      timestampVerified: false,
    });
    expect(manifest.sidecarRuntimes[0]).toMatchObject({
      platformTarget: "windows-x64",
      executablePath: "runtime/sidecars/opencode-compatible/opencode.cmd",
      signing: {
        signatureKind: "authenticode",
        signatureVerified: false,
      },
    });
  }, 360_000);

  it("stages an OpenCode-compatible sidecar fixture for macOS x64", async () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "macos-x64");
    const sidecarSpec = createSidecarFixture(dir, "macos-x64");
    const outDir = join(dir, "out");

    await assembleStageForTest("macos-x64", nodeArchive, outDir, dir, [sidecarSpec]);

    const manifest = JSON.parse(
      readFileSync(join(outDir, "macos-x64", "manifest", "portable-manifest.json"), "utf8"),
    );
    expect(manifest.sidecarRuntimes[0]).toMatchObject({
      platformTarget: "macos-x64",
      executablePath: "runtime/sidecars/opencode-compatible/bin/opencode",
      signing: {
        signatureKind: "developer-id-notarized",
        notarizationRequired: true,
      },
    });
  }, 360_000);

  it("fails closed when a sidecar spec points at the wrong platform", () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "windows-x64");
    const sidecarSpec = createSidecarFixture(dir, "macos-arm64");

    const result = runStage(stageArgs(dir, "windows-x64", nodeArchive, sidecarSpec));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sidecar platformTarget must match --target");
  });

  it("fails closed when a sidecar executable path traverses out of the source root", () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "windows-x64");
    const sidecarSpec = createSidecarFixture(dir, "windows-x64", {
      executablePath: "../opencode.cmd",
    });

    const result = runStage(stageArgs(dir, "windows-x64", nodeArchive, sidecarSpec));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sidecar executablePath must be a contained relative path");
  });

  it("fails closed when a sidecar executable is missing", () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "windows-x64");
    const sidecarSpec = createSidecarFixture(dir, "windows-x64", {
      executablePath: "missing-opencode.cmd",
    });

    const result = runStage(stageArgs(dir, "windows-x64", nodeArchive, sidecarSpec));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sidecar executablePath is missing");
  });

  it("fails closed when a sidecar expected digest does not match the payload", () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "windows-x64");
    const sidecarSpec = createSidecarFixture(dir, "windows-x64", {
      expectedPayloadSha256: DIGEST_A,
    });

    const result = runStage(stageArgs(dir, "windows-x64", nodeArchive, sidecarSpec));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sidecar expected digest does not match payload");
  });

  it("fails closed when sidecar license or SBOM evidence is incomplete", () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "windows-x64");
    const sidecarSpec = createSidecarFixture(dir, "windows-x64", {
      sbomEvidencePath: "evidence/missing-sbom.cdx.json",
    });

    const result = runStage(stageArgs(dir, "windows-x64", nodeArchive, sidecarSpec));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sidecar sbomEvidencePath is missing");
  });

  it("fails closed when a sidecar source tree contains forbidden Keiko state paths", () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "windows-x64");
    const sidecarSpec = createSidecarFixture(dir, "windows-x64");
    mkdirSync(join(sidecarSpec.sourceRoot, ".keiko"), { recursive: true });
    writeFileSync(join(sidecarSpec.sourceRoot, ".keiko", "memory.db"), "forbidden\n");

    const result = runStage(stageArgs(dir, "windows-x64", nodeArchive, sidecarSpec));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("forbidden portable payload paths");
  });

  it("fails closed when a local Node archive name does not match the target runtime", () => {
    const dir = tempDir();
    const nodeArchive = join(dir, `node-v${NODE_VERSION}-darwin-arm64.tar.gz`);
    const nodeBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
    writeFileSync(nodeArchive, nodeBytes);

    const result = runStage([
      "--target",
      "windows-x64",
      "--node-archive",
      nodeArchive,
      "--node-sha256",
      digestBuffer(nodeBytes),
      "--node-version",
      NODE_VERSION,
      "--commit-sha",
      COMMIT_SHA,
      "--release-id",
      "123456789",
      "--release-tag",
      "v0.2.11",
      "--node-cache-dir",
      join(dir, "cache"),
      "--out-dir",
      join(dir, "out"),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Node archive must be named node-v${NODE_VERSION}-win-x64.zip`);
  });

  it("fails closed when a correctly named Node archive has the wrong byte signature", () => {
    const dir = tempDir();
    const nodeArchive = join(dir, `node-v${NODE_VERSION}-win-x64.zip`);
    const nodeBytes = Buffer.from("not-a-zip-archive");
    writeFileSync(nodeArchive, nodeBytes);

    const result = runStage([
      "--target",
      "windows-x64",
      "--node-archive",
      nodeArchive,
      "--node-sha256",
      digestBuffer(nodeBytes),
      "--node-version",
      NODE_VERSION,
      "--commit-sha",
      COMMIT_SHA,
      "--release-id",
      "123456789",
      "--release-tag",
      "v0.2.11",
      "--node-cache-dir",
      join(dir, "cache"),
      "--out-dir",
      join(dir, "out"),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Node archive bytes do not match zip");
  });

  it("fails closed when the Node archive contains an escaping symlink", () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "macos-arm64", {
      unsafeSymlinkTarget: "/etc/passwd",
    });

    const result = runStage([
      "--target",
      "macos-arm64",
      "--node-archive",
      nodeArchive.path,
      "--node-sha256",
      nodeArchive.sha256,
      "--node-version",
      NODE_VERSION,
      "--commit-sha",
      COMMIT_SHA,
      "--release-id",
      "123456789",
      "--release-tag",
      "v0.2.11",
      "--node-cache-dir",
      join(dir, "cache"),
      "--out-dir",
      join(dir, "out"),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("archive symlink target escapes expected root");
  }, 120_000);

  it("fails closed when a ZIP Node archive stores a symlink entry", () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "windows-x64", {
      preserveSymlinks: true,
      unsafeSymlinkTarget: "/etc/passwd",
    });

    const result = runStage([
      "--target",
      "windows-x64",
      "--node-archive",
      nodeArchive.path,
      "--node-sha256",
      nodeArchive.sha256,
      "--node-version",
      NODE_VERSION,
      "--commit-sha",
      COMMIT_SHA,
      "--release-id",
      "123456789",
      "--release-tag",
      "v0.2.11",
      "--node-cache-dir",
      join(dir, "cache"),
      "--out-dir",
      join(dir, "out"),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("archive contains unsupported special-file entries");
  }, 120_000);

  it("fails closed when the release tag is not the stable package version", () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "windows-x64");

    const result = runStage([
      "--target",
      "windows-x64",
      "--node-archive",
      nodeArchive.path,
      "--node-sha256",
      nodeArchive.sha256,
      "--node-version",
      NODE_VERSION,
      "--commit-sha",
      COMMIT_SHA,
      "--release-id",
      "123456789",
      "--release-tag",
      "v0.2.11-beta.1",
      "--node-cache-dir",
      join(dir, "cache"),
      "--out-dir",
      join(dir, "out"),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--release-tag must match the stable package version");
  });
});
