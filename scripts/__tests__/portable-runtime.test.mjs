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

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const NODE_VERSION = "24.14.0";

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
    signatureKind: "authenticode",
    signatureVerified: true,
    notarizationRequired: false,
    notarizationVerified: false,
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
      signatureKind: "authenticode",
      signatureVerified: true,
      notarizationRequired: false,
      notarizationVerified: false,
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

function createNodeArchiveFixture(dir, platformTarget) {
  const target = portableTarget(platformTarget);
  const rootName = `node-v${NODE_VERSION}-${target.nodeArchiveTarget}`;
  const sourceParent = join(dir, `node-fixture-${platformTarget}`);
  const sourceRoot = join(sourceParent, rootName);
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "LICENSE"), "Node.js fixture license\n");
  writeFixtureNodeLauncher(target, sourceRoot);
  const archivePath = join(dir, `${rootName}.${target.nodeArchiveExtension}`);
  packNodeFixtureArchive(target, archivePath, sourceParent, rootName);
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

function packNodeFixtureArchive(target, archivePath, sourceParent, rootName) {
  if (target.nodeArchiveExtension === "zip") {
    runFixtureCommand("zip", ["-qr", archivePath, rootName], sourceParent);
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
    timeout: 120_000,
  });
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
    candidate.security.signatureVerified = false;
    candidate.releaseImpact.reviewedBinding.signatureVerified = false;

    const failures = validatePortableManifest(candidate).join("\n");
    expect(failures).toContain("updateEligibility.rollbackSupported: must be false");
    expect(failures).toContain("security.signatureVerified: must be true");
    expect(failures).toContain("platformSignatureLocallyVerified");
  });

  it("accepts unsigned manifests only in explicit unverified staging mode", () => {
    const candidate = manifest();
    candidate.security.signatureVerified = false;
    candidate.releaseImpact.reviewedBinding.signatureVerified = false;
    candidate.updateEligibility.requiredPredicates.platformSignatureLocallyVerified = false;

    expect(validatePortableManifest(candidate).join("\n")).toContain(
      "security.signatureVerified: must be true",
    );
    expect(validatePortableManifest(candidate, { allowUnverified: true })).toEqual([]);
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
    expect(source).not.toContain('["install"');
  });
});

describe("stage-portable-runtime", () => {
  it("stages macOS resources under the app bundle and binds the sidecar manifest to ZIP bytes", async () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "macos-arm64");
    const outDir = join(dir, "out");

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
      outDir,
    ]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
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
    expect(manifest.security.signatureVerified).toBe(false);
    expect(manifest.security.notarizationVerified).toBe(false);
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
      existsSync(join(root, "payload", "Keiko", "Keiko.app", "Contents", "Resources", "app")),
    ).toBe(true);
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
    expect(existsSync(join(root, "payload", "Keiko", "app"))).toBe(false);
  }, 120_000);

  it("stages Windows resources with an extracted bundled Node runtime", () => {
    const dir = tempDir();
    const nodeArchive = createNodeArchiveFixture(dir, "windows-x64");
    const outDir = join(dir, "out");

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
      outDir,
    ]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const runtimeRoot = join(outDir, "windows-x64", "payload", "Keiko", "runtime", "node");
    expect(existsSync(join(runtimeRoot, "node.exe"))).toBe(true);
    expect(existsSync(join(runtimeRoot, "LICENSE"))).toBe(true);
    expect(existsSync(join(runtimeRoot, "NOTICE"))).toBe(true);
  }, 120_000);

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
