import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  hashDirectoryTree,
  portableTargetByName,
  PORTABLE_TARGET_NAMES,
  sha256File,
  validatePortableManifest,
  verifySha256File,
} from "./portable-runtime.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const DEFAULT_NODE_VERSION = process.version.replace(/^v/u, "");
const ALLOWED_NODE_ARCHIVE_HOSTS = new Set(["nodejs.org", "dist.nodejs.org"]);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const NODE_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const NODE_ARCHIVE_TIMEOUT_MS = 300_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function fail(message) {
  console.error(`portable-stage failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    commitSha: process.env.GITHUB_SHA,
    dryRun: false,
    nodeArchive: undefined,
    nodeArchiveUrl: undefined,
    nodeCacheDir: join(repoRoot, ".portable-runtime", "cache", "node"),
    nodeSha256: undefined,
    outDir: join(repoRoot, ".portable-runtime", "staging"),
    releaseId: Number(process.env.GITHUB_RUN_ID ?? 0),
    releaseTag: `v${rootPackage.version}`,
    signatureVerified: false,
    notarizationVerified: false,
    target: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    index = applyArg(argv, index, options);
  }
  if (options.target === undefined) fail(`pass --target ${PORTABLE_TARGET_NAMES.join("|")}`);
  const target = portableTargetByName(options.target);
  if (target === undefined) fail(`unsupported target ${options.target}`);
  validateNodeRuntimeOptions(options);
  validateReleaseOptions(options);
  validateSigningOptions(options, target);
  return options;
}

function applyArg(argv, index, options) {
  const arg = argv[index];
  if (arg === "--dry-run") {
    options.dryRun = true;
    return index;
  }
  if (arg === "--signature-verified") {
    options.signatureVerified = true;
    return index;
  }
  if (arg === "--notarization-verified") {
    options.notarizationVerified = true;
    return index;
  }
  const fields = new Map([
    ["--commit-sha", "commitSha"],
    ["--node-archive", "nodeArchive"],
    ["--node-archive-url", "nodeArchiveUrl"],
    ["--node-cache-dir", "nodeCacheDir"],
    ["--node-sha256", "nodeSha256"],
    ["--out-dir", "outDir"],
    ["--release-id", "releaseId"],
    ["--release-tag", "releaseTag"],
    ["--target", "target"],
  ]);
  const field = fields.get(arg);
  if (field === undefined) fail(`unsupported argument: ${arg}`);
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) fail(`${arg} requires a value`);
  options[field] = field === "releaseId" ? Number(value) : value;
  return index + 1;
}

function validateNodeRuntimeOptions(options) {
  if (options.nodeArchive !== undefined && options.nodeArchiveUrl !== undefined) {
    fail("pass either --node-archive or --node-archive-url, not both");
  }
  if (options.nodeArchive === undefined && options.nodeArchiveUrl === undefined) {
    fail("pass --node-archive or --node-archive-url with --node-sha256");
  }
  if (options.nodeSha256 === undefined) fail("--node-sha256 is required");
  if (!SHA256_PATTERN.test(options.nodeSha256)) fail("--node-sha256 must be a SHA-256 digest");
  if (options.nodeArchiveUrl !== undefined && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    fail("NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed for Node runtime acquisition");
  }
}

function validateReleaseOptions(options) {
  if (typeof options.commitSha !== "string" || !COMMIT_PATTERN.test(options.commitSha)) {
    fail("--commit-sha or GITHUB_SHA must be a 40-hex commit SHA");
  }
  if (!Number.isSafeInteger(options.releaseId) || options.releaseId < 0) {
    fail("--release-id must be a non-negative safe integer");
  }
  if (typeof options.releaseTag !== "string" || options.releaseTag.length === 0) {
    fail("--release-tag must be a non-empty release tag");
  }
}

function validateSigningOptions(options, target) {
  if (!options.signatureVerified) fail("--signature-verified is required for portable manifests");
  if (target.nodePlatform === "darwin" && !options.notarizationVerified) {
    fail("--notarization-verified is required for macOS portable manifests");
  }
  if (target.nodePlatform !== "darwin" && options.notarizationVerified) {
    fail("--notarization-verified is only valid for macOS portable manifests");
  }
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error !== undefined)
    fail(`${cmd} ${args.join(" ")} could not spawn: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${cmd} ${args.join(" ")} exited ${String(result.status)}: ${result.stderr}`);
  return result;
}

function packRoot(packDir) {
  const result = run("npm", [
    "pack",
    "--silent",
    "--ignore-scripts",
    "--pack-destination",
    packDir,
  ]);
  const tarballName = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (tarballName === undefined) fail("npm pack did not report a tarball name");
  const tarball = join(packDir, tarballName);
  if (!existsSync(tarball)) fail(`expected npm pack tarball at ${tarball}`);
  return tarball;
}

function installPackage(tarball, installRoot) {
  run("npm", ["init", "-y"], { cwd: installRoot });
  run(
    "npm",
    ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional"],
    {
      cwd: installRoot,
      timeout: 180_000,
    },
  );
}

function stageInstalledPackage(installRoot, stageRoot) {
  const installed = join(installRoot, "node_modules", "@oscharko-dev", "keiko");
  if (!existsSync(installed)) fail(`installed Keiko package not found at ${installed}`);
  cpSync(installed, join(stageRoot, "app"), { recursive: true, dereference: true });
}

async function stageNodeRuntime(options, target, stageRoot) {
  const runtimeRoot = join(stageRoot, "runtime", "node");
  const archiveRoot = join(runtimeRoot, "archive");
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });
  const archive = await resolveNodeArchive(options);
  copyFileSync(archive.path, join(archiveRoot, archive.fileName));
  writeFileSync(
    join(runtimeRoot, "NODE_RUNTIME_SOURCE.json"),
    JSON.stringify(
      {
        fileName: archive.fileName,
        sha256: archive.sha256,
        source: archive.source,
        target: target.runtimeTarget,
      },
      null,
      2,
    ) + "\n",
  );
  return archive.sha256;
}

async function resolveNodeArchive(options) {
  if (options.nodeArchive !== undefined) {
    return cacheLocalNodeArchive(options.nodeArchive, options.nodeSha256, options.nodeCacheDir);
  }
  return downloadNodeArchive(options.nodeArchiveUrl, options.nodeSha256, options.nodeCacheDir);
}

async function cacheLocalNodeArchive(path, sha256, cacheDir) {
  await verifySha256File(path, sha256);
  const cachePath = cacheArchivePath(cacheDir, sha256, basename(path));
  mkdirSync(dirname(cachePath), { recursive: true });
  copyFileSync(path, cachePath);
  await verifySha256File(cachePath, sha256);
  return {
    fileName: basename(cachePath),
    path: cachePath,
    sha256,
    source: "local-verified-archive",
  };
}

async function downloadNodeArchive(rawUrl, sha256, cacheDir) {
  const url = validateNodeArchiveUrl(rawUrl);
  const cachePath = cacheArchivePath(cacheDir, sha256, basename(url.pathname));
  if (existsSync(cachePath)) {
    await verifySha256File(cachePath, sha256);
    return {
      fileName: basename(cachePath),
      path: cachePath,
      sha256,
      source: "official-nodejs-url",
    };
  }
  await downloadVerifiedArchive(url, sha256, cachePath);
  return { fileName: basename(cachePath), path: cachePath, sha256, source: "official-nodejs-url" };
}

async function downloadVerifiedArchive(url, sha256, cachePath) {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${String(process.pid)}.tmp`;
  const response = await globalThis.fetch(url, {
    signal: globalThis.AbortSignal.timeout(NODE_ARCHIVE_TIMEOUT_MS),
  });
  await writeBoundedResponse(response, url.toString(), tempPath);
  await verifySha256File(tempPath, sha256);
  renameSync(tempPath, cachePath);
}

async function writeBoundedResponse(response, requestedUrl, path) {
  validateDownloadResponse(response, requestedUrl);
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (contentLength > NODE_ARCHIVE_MAX_BYTES) fail("Node archive download exceeds size limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > NODE_ARCHIVE_MAX_BYTES) fail("Node archive download exceeds size limit");
  writeFileSync(path, bytes);
}

function cacheArchivePath(cacheDir, sha256, fileName) {
  return join(resolve(cacheDir), sha256, safeNodeArchiveFileName(fileName));
}

function safeNodeArchiveFileName(fileName) {
  if (fileName.length === 0 || fileName.includes("/") || fileName.includes("\\")) {
    fail("Node archive file name must be contained");
  }
  return fileName;
}

function validateNodeArchiveUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") fail("--node-archive-url must use https");
  if (url.username.length > 0 || url.password.length > 0) {
    fail("--node-archive-url must not contain credentials");
  }
  if (!ALLOWED_NODE_ARCHIVE_HOSTS.has(url.hostname)) {
    fail("--node-archive-url must point to an official nodejs.org distribution host");
  }
  safeNodeArchiveFileName(basename(url.pathname));
  return url;
}

function validateDownloadResponse(response, requestedUrl) {
  if (!response.ok) {
    fail(`Node archive download failed for ${requestedUrl}: HTTP ${String(response.status)}`);
  }
  validateNodeArchiveUrl(response.url);
}

function writeEvidence(stageRoot, manifest, provenanceStatement) {
  const evidenceRoot = join(stageRoot, "evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(
    join(evidenceRoot, "SHA256SUMS.txt"),
    `${manifest.artifact.sha256}  ${manifest.artifact.assetName}\n`,
  );
  writeFileSync(
    join(evidenceRoot, "sbom.cdx.json"),
    JSON.stringify({ bomFormat: "CycloneDX", components: [] }, null, 2) + "\n",
  );
  writeFileSync(
    join(evidenceRoot, "third-party-notices.txt"),
    "Portable runtime notices are assembled by the release pipeline.\n",
  );
  writeFileSync(
    join(evidenceRoot, "signing-verification.json"),
    JSON.stringify(
      {
        notarizationRequired: manifest.security.notarizationRequired,
        notarizationVerified: manifest.security.notarizationVerified,
        signatureKind: manifest.security.signatureKind,
        signatureVerified: manifest.security.signatureVerified,
        status: manifest.security.signatureVerified ? "verified" : "not-verified",
        target: manifest.artifact.platformTarget,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(evidenceRoot, "provenance.intoto.jsonl"), provenanceStatement);
}

function provenanceStatementFor(options, target, digests) {
  return (
    JSON.stringify({
      artifact: target.assetName,
      buildWorkflowRunId: options.releaseId,
      packageVersion: rootPackage.version,
      sourceCommitSha: options.commitSha,
      subjectDigest: digests.assetSha256,
      target: target.platformTarget,
    }) + "\n"
  );
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function directorySizeBytes(root) {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += directorySizeBytes(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

function launcherPath(target, stageRoot) {
  if (target.primaryLauncher === "Keiko.exe") return join(stageRoot, "Keiko.exe");
  return join(stageRoot, "Keiko.app", "Contents", "MacOS", "Keiko");
}

function stageLauncher(target, stageRoot) {
  const path = launcherPath(target, stageRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `Portable launcher placeholder for ${target.platformTarget}.\n`);
}

function manifestProduct() {
  return {
    name: "Keiko",
    packageName: rootPackage.name,
    packageVersion: rootPackage.version,
  };
}

function manifestRelease(options) {
  return {
    releaseId: options.releaseId,
    releaseTag: options.releaseTag,
    stable: !rootPackage.version.includes("-"),
    commitSha: options.commitSha,
  };
}

function manifestArtifact(options, target, digests) {
  return {
    platformTarget: target.platformTarget,
    assetId: options.releaseId,
    assetName: target.assetName,
    archiveFormat: "zip",
    sizeBytes: digests.sizeBytes,
    sha256: digests.assetSha256,
  };
}

function manifestProvenance(options, digests) {
  return {
    sourceCommitSha: options.commitSha,
    rootPackageVersion: rootPackage.version,
    rootPackageTarballSha256: digests.tarballSha256,
    packagedAppTreeSha256: digests.appTreeSha256,
    buildWorkflowRunId: options.releaseId,
    buildWorkflowAttempt: 1,
    provenanceStatementPath: "evidence/provenance.intoto.jsonl",
    provenanceStatementSha256: digests.provenanceSha256,
  };
}

function manifestRuntime(target, digests) {
  return {
    nodeVersion: DEFAULT_NODE_VERSION,
    nodePlatform: target.nodePlatform,
    nodeArchitecture: target.nodeArchitecture,
    nodeDistribution: "official-nodejs-dist",
    nodeArchiveSha256: digests.nodeArchiveSha256,
  };
}

function manifestPackageSurface() {
  return {
    source: "root-npm-package-surface",
    packageSurfaceGate: "npm run check:package-surface",
    publishManifestGate: "npm run check:publish-manifests",
    workspaceSupplyChainGate: "npm run check:workspace-supply-chain",
  };
}

function manifestInstallLayout() {
  return {
    installMode: "portable-managed",
    bootstrapUpdateEligible: false,
    managedRootKind: "user-local-keiko-owned",
    sameVolumeStagingRequired: true,
    stateRootPolicy: "separate-local-runtime-state",
  };
}

function manifestStateExclusion() {
  return {
    excludesDotKeiko: true,
    excludesCustomerData: true,
    excludesSecrets: true,
    excludesRawLogs: true,
    excludesRepositories: true,
  };
}

function manifestSecurity(options, target) {
  return {
    signatureKind: target.signatureKind,
    signatureVerified: options.signatureVerified,
    notarizationRequired: target.nodePlatform === "darwin",
    notarizationVerified: target.nodePlatform === "darwin" && options.notarizationVerified,
    verificationSummaryPath: "evidence/signing-verification.json",
  };
}

function manifestEvidence() {
  return {
    checksumsPath: "evidence/SHA256SUMS.txt",
    sbomPath: "evidence/sbom.cdx.json",
    licenseNoticePath: "evidence/third-party-notices.txt",
  };
}

function manifestReviewedBinding(options, target, digests, nodeIdentity, security) {
  return {
    releaseId: options.releaseId,
    releaseTag: options.releaseTag,
    assetId: options.releaseId,
    assetName: target.assetName,
    assetSizeBytes: digests.sizeBytes,
    platformTarget: target.platformTarget,
    packageVersion: rootPackage.version,
    nodeRuntimeIdentity: nodeIdentity,
    archiveSha256: digests.assetSha256,
    provenanceStatementSha256: digests.provenanceSha256,
    sbomPath: "evidence/sbom.cdx.json",
    licenseNoticePath: "evidence/third-party-notices.txt",
    checksumsPath: "evidence/SHA256SUMS.txt",
    signatureKind: security.signatureKind,
    signatureVerified: security.signatureVerified,
    notarizationRequired: security.notarizationRequired,
    notarizationVerified: security.notarizationVerified,
  };
}

function manifestReleaseImpact(options, target, digests, nodeIdentity, security) {
  return {
    catalogPath: "app/release-impact.catalog.json",
    entryId: `${rootPackage.name}@${rootPackage.version}`,
    entryPackageVersion: rootPackage.version,
    entryReleaseTag: options.releaseTag,
    reviewedBinding: manifestReviewedBinding(options, target, digests, nodeIdentity, security),
  };
}

function manifestUpdateEligibility() {
  return {
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
  };
}

function manifestFor(options, target, digests) {
  const assetSha = digests.assetSha256;
  const nodeIdentity = `node-v${DEFAULT_NODE_VERSION}-${target.runtimeTarget}`;
  const security = manifestSecurity(options, target);
  return {
    schemaVersion: 1,
    product: manifestProduct(),
    release: manifestRelease(options),
    artifact: manifestArtifact(options, target, { ...digests, assetSha256: assetSha }),
    provenance: manifestProvenance(options, digests),
    runtime: manifestRuntime(target, digests),
    packageSurface: manifestPackageSurface(),
    entrypoints: {
      primaryLauncher: target.primaryLauncher,
      supportLaunchers: [],
    },
    installLayout: manifestInstallLayout(),
    stateExclusion: manifestStateExclusion(),
    security,
    evidence: manifestEvidence(),
    releaseImpact: manifestReleaseImpact(
      options,
      target,
      { ...digests, assetSha256: assetSha },
      nodeIdentity,
      security,
    ),
    updateEligibility: manifestUpdateEligibility(),
  };
}

async function assemble(options) {
  const target = portableTargetByName(options.target);
  const tmp = mkdtempSync(join(tmpdir(), "keiko-portable-stage-"));
  const finalRoot = resolve(options.outDir, target.platformTarget);
  rmSync(finalRoot, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const tarball = packRoot(tmp);
    const installRoot = join(tmp, "install");
    const stageRoot = join(tmp, "stage", "Keiko");
    mkdirSync(installRoot, { recursive: true });
    mkdirSync(stageRoot, { recursive: true });
    installPackage(tarball, installRoot);
    stageInstalledPackage(installRoot, stageRoot);
    stageLauncher(target, stageRoot);
    const nodeArchiveSha256 = await stageNodeRuntime(options, target, stageRoot);
    const appTreeSha256 = hashDirectoryTree(join(stageRoot, "app"));
    const tarballSha256 = await sha256File(tarball);
    const assetSha256 = hashDirectoryTree(stageRoot);
    const sizeBytes = directorySizeBytes(stageRoot);
    const provenanceStatement = provenanceStatementFor(options, target, { assetSha256 });
    const provenanceSha256 = sha256Text(provenanceStatement);
    const manifest = manifestFor(options, target, {
      appTreeSha256,
      assetSha256,
      nodeArchiveSha256,
      provenanceSha256,
      sizeBytes,
      tarballSha256,
    });
    writeEvidence(stageRoot, manifest, provenanceStatement);
    mkdirSync(join(stageRoot, "manifest"), { recursive: true });
    writeFileSync(
      join(stageRoot, "manifest", "portable-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    const failures = validatePortableManifest(manifest);
    if (failures.length > 0) fail(`generated manifest is invalid:\n  - ${failures.join("\n  - ")}`);
    if (!options.dryRun) {
      mkdirSync(resolve(options.outDir), { recursive: true });
      renameSync(stageRoot, finalRoot);
    }
    return { finalRoot, manifest, tarball };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runPortableStage(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await assemble(options);
  console.log(
    `portable-stage: PASS ${options.target} staged from ${basename(result.tarball)} at ${result.finalRoot}`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPortableStage();
}
