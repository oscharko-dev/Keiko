import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
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
import { basename, dirname, join, posix, resolve } from "node:path";
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
const releaseImpactCatalog = JSON.parse(
  readFileSync(join(repoRoot, "release-impact.catalog.json"), "utf8"),
);
const ALLOWED_NODE_ARCHIVE_HOSTS = new Set(["nodejs.org", "dist.nodejs.org"]);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const NODE_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const NODE_ARCHIVE_TIMEOUT_MS = 300_000;
const NODE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const STAGING_ASSET_ID_UNAVAILABLE = 0;
const REQUIRED_APP_SURFACE_FILES = Object.freeze([
  "package.json",
  "dist/index.js",
  "dist/cli/index.js",
  "release-impact.catalog.json",
  "LICENSE",
  "NOTICE",
]);
const TAR_LINK_POLICY_SKIP_SAFE = "skip-safe";
const PORTABLE_RELEASE_IMPACT_CONTRACT = Object.freeze({
  issue: 1948,
  parentEpic: 1942,
  programEpic: 1944,
  stagingOnly: true,
  targets: Object.freeze(["windows-x64", "macos-arm64", "macos-x64"]),
});

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
    nodeVersion: undefined,
    outDir: join(repoRoot, ".portable-runtime", "staging"),
    releaseId: Number(process.env.GITHUB_RUN_ID ?? 0),
    releaseTag: `v${rootPackage.version}`,
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
  if (options.nodeArchive !== undefined) {
    assertNodeArchiveIdentity(options.nodeArchive, target, options.nodeVersion);
  }
  return options;
}

function applyArg(argv, index, options) {
  const arg = argv[index];
  if (arg === "--dry-run") {
    options.dryRun = true;
    return index;
  }
  const fields = new Map([
    ["--commit-sha", "commitSha"],
    ["--node-archive", "nodeArchive"],
    ["--node-archive-url", "nodeArchiveUrl"],
    ["--node-cache-dir", "nodeCacheDir"],
    ["--node-sha256", "nodeSha256"],
    ["--node-version", "nodeVersion"],
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
  if (typeof options.nodeVersion !== "string" || !NODE_VERSION_PATTERN.test(options.nodeVersion)) {
    fail("--node-version is required and must identify the bundled Node.js runtime");
  }
  validateNodeDownloadEnvironment(options);
}

function validateNodeDownloadEnvironment(options) {
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
  if (rootPackage.version.includes("-") || options.releaseTag !== `v${rootPackage.version}`) {
    fail("--release-tag must match the stable package version for portable v1");
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

function preparePackageSurface() {
  run("npm", ["run", "build"]);
  run("npm", ["run", "build:ui"]);
  run("npm", ["run", "prepare:bin"]);
  run("npm", ["run", "prune:package-build-artifacts"]);
  run("npm", ["run", "prune:package-native-optionals"]);
  run("npm", ["run", "check:package-surface"]);
}

function stagePackedPackage(tarball, extractRoot, stageRoot) {
  const appRoot = join(stageRoot, "app");
  extractArchiveRoot(tarball, "tar.gz", "package", extractRoot, appRoot, {
    tarLinkPolicy: TAR_LINK_POLICY_SKIP_SAFE,
  });
  validateStagedAppSurface(appRoot);
}

async function stageNodeRuntime(options, target, stageRoot) {
  const runtimeRoot = join(stageRoot, "runtime", "node");
  mkdirSync(runtimeRoot, { recursive: true });
  const archive = await resolveNodeArchive(options, target);
  extractNodeRuntime(archive.path, target, options.nodeVersion, runtimeRoot);
  ensureRuntimeNotice(runtimeRoot, archive);
  validateExtractedNodeRuntime(target, runtimeRoot);
  writeFileSync(
    join(runtimeRoot, "NODE_RUNTIME_SOURCE.json"),
    JSON.stringify(
      {
        fileName: archive.fileName,
        nodeVersion: options.nodeVersion,
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

function extractNodeRuntime(archivePath, target, nodeVersion, runtimeRoot) {
  const extractRoot = join(runtimeRoot, ".extract");
  try {
    extractArchiveRoot(
      archivePath,
      target.nodeArchiveExtension,
      expectedNodeArchiveRootName(target, nodeVersion),
      extractRoot,
      runtimeRoot,
      { tarLinkPolicy: TAR_LINK_POLICY_SKIP_SAFE },
    );
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

function extractArchiveRoot(
  archivePath,
  archiveKind,
  expectedRoot,
  extractRoot,
  destinationRoot,
  policy,
) {
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  const entries = safeExtractionEntries(archivePath, archiveKind, expectedRoot, policy);
  extractArchive(archivePath, archiveKind, extractRoot, entries);
  copySafeTreeContents(join(extractRoot, expectedRoot), destinationRoot);
}

function extractArchive(archivePath, archiveKind, extractRoot, entries) {
  if (archiveKind === "zip") {
    run("unzip", ["-q", archivePath, "-d", extractRoot]);
    return;
  }
  const includeFile = join(extractRoot, "portable-runtime-tar-include.txt");
  writeFileSync(includeFile, `${entries.join("\n")}\n`);
  run("tar", ["-xzf", archivePath, "-C", extractRoot, "-T", includeFile]);
  rmSync(includeFile, { force: true });
}

function safeExtractionEntries(archivePath, archiveKind, expectedRoot, policy) {
  const entries = archiveEntries(archivePath, archiveKind);
  if (!entries.some((entry) => archiveEntryInsideRoot(entry, expectedRoot))) {
    fail(`archive must contain ${expectedRoot}`);
  }
  for (const entry of entries) {
    if (!archiveEntryInsideRoot(entry, expectedRoot)) fail(`archive entry escapes ${expectedRoot}`);
  }
  if (archiveKind === "zip") {
    assertZipEntryTypesSafe(archivePath);
    return entries;
  }
  return tarExtractionEntries(archivePath, entries, expectedRoot, policy.tarLinkPolicy);
}

function archiveEntries(archivePath, archiveKind) {
  const result =
    archiveKind === "zip" ? run("unzip", ["-Z1", archivePath]) : run("tar", ["-tzf", archivePath]);
  return result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function archiveEntryInsideRoot(entry, expectedRoot) {
  const normalized = normalizeArchiveEntry(entry);
  return normalized === expectedRoot || normalized.startsWith(`${expectedRoot}/`);
}

function normalizeArchiveEntry(entry) {
  const normalized = entry.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    return "";
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return "";
  return normalized;
}

function tarExtractionEntries(archivePath, entries, expectedRoot, linkPolicy) {
  const lines = run("tar", ["-tvzf", archivePath]).stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== entries.length) fail("tar archive listing is inconsistent");
  const extractable = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const entry = entries[index];
    const type = line[0];
    if (type === "-") {
      extractable.push(entry);
    } else if (type === "d") {
      continue;
    } else if (type === "l" && linkPolicy === TAR_LINK_POLICY_SKIP_SAFE) {
      assertTarSymlinkTargetSafe(entry, line, expectedRoot);
    } else {
      fail("archive contains unsupported link or special-file entries");
    }
  }
  return extractable;
}

function assertTarSymlinkTargetSafe(entry, line, expectedRoot) {
  const marker = " -> ";
  const markerIndex = line.lastIndexOf(marker);
  if (markerIndex === -1) fail("tar symlink entry is missing target");
  const target = line.slice(markerIndex + marker.length);
  if (target.startsWith("/") || /^[A-Za-z]:/u.test(target)) {
    fail("archive symlink target escapes expected root");
  }
  const normalizedTarget = normalizeArchiveEntry(posix.join(posix.dirname(entry), target));
  if (!archiveEntryInsideRoot(normalizedTarget, expectedRoot)) {
    fail("archive symlink target escapes expected root");
  }
}

function assertZipEntryTypesSafe(archivePath) {
  for (const line of run("unzip", ["-Z", "-l", archivePath])
    .stdout.split(/\r?\n/u)
    .filter(Boolean)) {
    if (!/^[dl-][rwx-]/u.test(line)) continue;
    const type = line[0];
    if (type === "d" || type === "-") continue;
    fail("archive contains unsupported special-file entries");
  }
}

function copySafeTreeContents(sourceRoot, destinationRoot) {
  if (!existsSync(sourceRoot)) fail(`archive root not found at ${basename(sourceRoot)}`);
  mkdirSync(destinationRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot)) {
    copySafeEntry(join(sourceRoot, entry), join(destinationRoot, entry));
  }
}

function copySafeEntry(sourcePath, destinationPath) {
  const entry = lstatSync(sourcePath);
  if (entry.isDirectory()) {
    copySafeDirectory(sourcePath, destinationPath);
    return;
  }
  if (entry.isFile()) {
    copySafeFile(sourcePath, destinationPath, entry.nlink);
    return;
  }
  fail("archive contains unsupported special-file entries");
}

function copySafeDirectory(sourcePath, destinationPath) {
  mkdirSync(destinationPath, { recursive: true });
  for (const entry of readdirSync(sourcePath)) {
    copySafeEntry(join(sourcePath, entry), join(destinationPath, entry));
  }
}

function copySafeFile(sourcePath, destinationPath, linkCount) {
  if (linkCount > 1) fail("archive contains hardlinked file entries");
  mkdirSync(dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
}

function validateExtractedNodeRuntime(target, runtimeRoot) {
  const launcherPath = target.nodePlatform === "win32" ? "node.exe" : "bin/node";
  requireRuntimeFile(runtimeRoot, launcherPath);
  requireRuntimeFile(runtimeRoot, "LICENSE");
  requireRuntimeFile(runtimeRoot, "NOTICE");
}

function requireRuntimeFile(runtimeRoot, relativePath) {
  const path = join(runtimeRoot, relativePath);
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`Node runtime must include ${relativePath}`);
  }
}

function validateStagedAppSurface(appRoot) {
  const failures = appSurfaceFailures(appRoot);
  if (failures.length > 0)
    fail(`packed app surface is incomplete:\n  - ${failures.join("\n  - ")}`);
}

export function appSurfaceFailures(appRoot) {
  const failures = [];
  for (const file of REQUIRED_APP_SURFACE_FILES) {
    if (!existsSync(join(appRoot, file)) || !statSync(join(appRoot, file)).isFile()) {
      failures.push(`${file} is required`);
    }
  }
  validateStagedPackageJson(appRoot, failures);
  return failures;
}

function validateStagedPackageJson(appRoot, failures) {
  const packagePath = join(appRoot, "package.json");
  if (!existsSync(packagePath)) return;
  const stagedPackage = JSON.parse(readFileSync(packagePath, "utf8"));
  if (stagedPackage.name !== rootPackage.name) failures.push("package.json name must match root");
  if (stagedPackage.version !== rootPackage.version) {
    failures.push("package.json version must match root");
  }
}

function ensureRuntimeNotice(runtimeRoot, archive) {
  const noticePath = join(runtimeRoot, "NOTICE");
  if (existsSync(noticePath)) return;
  writeFileSync(
    noticePath,
    [
      "Keiko bundled Node.js runtime notice.",
      `Source archive: ${archive.fileName}`,
      `Source archive SHA-256: ${archive.sha256}`,
      "The upstream Node.js runtime license is included in LICENSE.",
      "",
    ].join("\n"),
  );
}

function payloadResourceRoot(target, payloadRoot) {
  if (target.nodePlatform === "darwin") {
    return join(payloadRoot, "Keiko.app", "Contents", "Resources");
  }
  return payloadRoot;
}

function payloadSupportRoot(payloadRoot) {
  return join(payloadRoot, "support");
}

async function resolveNodeArchive(options, target) {
  if (options.nodeArchive !== undefined) {
    return cacheLocalNodeArchive(options, target);
  }
  return downloadNodeArchive(options, target);
}

async function cacheLocalNodeArchive(options, target) {
  const { nodeArchive: path, nodeCacheDir: cacheDir, nodeSha256: sha256 } = options;
  assertNodeArchiveIdentity(path, target, options.nodeVersion);
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

async function downloadNodeArchive(options, target) {
  const { nodeArchiveUrl: rawUrl, nodeCacheDir: cacheDir, nodeSha256: sha256 } = options;
  const url = validateNodeArchiveUrl(rawUrl, target, options.nodeVersion);
  const cachePath = cacheArchivePath(cacheDir, sha256, basename(url.pathname));
  if (existsSync(cachePath)) {
    assertNodeArchiveIdentity(cachePath, target, options.nodeVersion);
    await verifySha256File(cachePath, sha256);
    return {
      fileName: basename(cachePath),
      path: cachePath,
      sha256,
      source: "official-nodejs-url",
    };
  }
  await downloadVerifiedArchive(url, sha256, cachePath, target, options.nodeVersion);
  return { fileName: basename(cachePath), path: cachePath, sha256, source: "official-nodejs-url" };
}

async function downloadVerifiedArchive(url, sha256, cachePath, target, nodeVersion) {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${String(process.pid)}.tmp`;
  const response = await globalThis.fetch(url, {
    signal: globalThis.AbortSignal.timeout(NODE_ARCHIVE_TIMEOUT_MS),
  });
  await writeBoundedResponse(response, url.toString(), tempPath, target, nodeVersion);
  assertNodeArchiveIdentity(tempPath, target, nodeVersion, basename(cachePath));
  await verifySha256File(tempPath, sha256);
  renameSync(tempPath, cachePath);
}

async function writeBoundedResponse(response, requestedUrl, path, target, nodeVersion) {
  validateDownloadResponse(response, requestedUrl, target, nodeVersion);
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

function validateNodeArchiveUrl(rawUrl, target, nodeVersion) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") fail("--node-archive-url must use https");
  if (url.username.length > 0 || url.password.length > 0) {
    fail("--node-archive-url must not contain credentials");
  }
  if (!ALLOWED_NODE_ARCHIVE_HOSTS.has(url.hostname)) {
    fail("--node-archive-url must point to an official nodejs.org distribution host");
  }
  assertNodeArchiveName(basename(url.pathname), target, nodeVersion);
  return url;
}

function validateDownloadResponse(response, requestedUrl, target, nodeVersion) {
  if (!response.ok) {
    fail(`Node archive download failed for ${requestedUrl}: HTTP ${String(response.status)}`);
  }
  if (response.url !== requestedUrl) validateNodeArchiveUrl(response.url, target, nodeVersion);
}

function assertNodeArchiveIdentity(path, target, nodeVersion, fileName = basename(path)) {
  assertNodeArchiveName(fileName, target, nodeVersion);
  const size = statSync(path).size;
  if (size <= 0 || size > NODE_ARCHIVE_MAX_BYTES) fail("Node archive size is outside limits");
  assertNodeArchiveMagic(path, target);
}

function assertNodeArchiveName(fileName, target, nodeVersion) {
  const safeName = safeNodeArchiveFileName(fileName);
  const expected = expectedNodeArchiveFileName(target, nodeVersion);
  if (safeName !== expected) fail(`Node archive must be named ${expected}`);
}

function expectedNodeArchiveFileName(target, nodeVersion) {
  return `${expectedNodeArchiveRootName(target, nodeVersion)}.${target.nodeArchiveExtension}`;
}

function expectedNodeArchiveRootName(target, nodeVersion) {
  return `node-v${nodeVersion}-${target.nodeArchiveTarget}`;
}

function assertNodeArchiveMagic(path, target) {
  const header = readFileSync(path).subarray(0, 4);
  if (target.nodeArchiveExtension === "zip" && header[0] === 0x50 && header[1] === 0x4b) return;
  if (target.nodeArchiveExtension === "tar.gz" && header[0] === 0x1f && header[1] === 0x8b) return;
  fail(`Node archive bytes do not match ${target.nodeArchiveExtension}`);
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
        status: "unverified-staging",
        target: manifest.artifact.platformTarget,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(evidenceRoot, "provenance.intoto.jsonl"), provenanceStatement);
}

function writeManifest(stageRoot, manifest) {
  mkdirSync(join(stageRoot, "manifest"), { recursive: true });
  writeFileSync(
    join(stageRoot, "manifest", "portable-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
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

function createZipArchive(payloadContainer, assetName, outRoot) {
  const assetPath = join(outRoot, assetName);
  run("zip", ["-qr", assetPath, "Keiko"], { cwd: payloadContainer });
  if (!existsSync(assetPath)) fail(`expected ZIP asset at ${assetPath}`);
  return assetPath;
}

function launcherPath(target, stageRoot) {
  if (target.primaryLauncher === "Keiko.exe") return join(stageRoot, "Keiko.exe");
  return join(stageRoot, "Keiko.app", "Contents", "MacOS", "Keiko");
}

function stageLauncher(target, stageRoot) {
  const path = launcherPath(target, stageRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `Portable launcher placeholder for ${target.platformTarget}.\n`);
  if (target.nodePlatform === "darwin") {
    writeFileSync(join(stageRoot, "Keiko.app", "Contents", "Info.plist"), macInfoPlist(target));
  }
  stageSupportLauncher(target, stageRoot);
}

function stageSupportLauncher(target, stageRoot) {
  const supportRoot = payloadSupportRoot(stageRoot);
  mkdirSync(supportRoot, { recursive: true });
  if (target.nodePlatform === "win32") {
    writeFileSync(join(supportRoot, "keiko-support.cmd"), "@echo off\r\nKeiko.exe %*\r\n");
    return;
  }
  writeFileSync(
    join(supportRoot, "keiko-support.sh"),
    '#!/bin/sh\nexec ../Keiko.app/Contents/MacOS/Keiko "$@"\n',
  );
}

function macInfoPlist(target) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleExecutable</key>",
    "  <string>Keiko</string>",
    "  <key>CFBundleIdentifier</key>",
    `  <string>dev.oscharko.keiko.${target.platformTarget}</string>`,
    "  <key>CFBundleName</key>",
    "  <string>Keiko</string>",
    "  <key>CFBundlePackageType</key>",
    "  <string>APPL</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
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
    assetId: STAGING_ASSET_ID_UNAVAILABLE,
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

function manifestRuntime(options, target, digests) {
  return {
    nodeVersion: options.nodeVersion,
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

function manifestSecurity(target) {
  return {
    signatureKind: target.signatureKind,
    signatureVerified: false,
    notarizationRequired: target.nodePlatform === "darwin",
    notarizationVerified: false,
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
    assetId: STAGING_ASSET_ID_UNAVAILABLE,
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

function manifestReleaseImpact(
  options,
  target,
  digests,
  nodeIdentity,
  security,
  releaseImpactEntry,
) {
  return {
    catalogPath: "app/release-impact.catalog.json",
    entryId: releaseImpactEntry.id,
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
  };
}

function manifestFor(options, target, digests) {
  const assetSha = digests.assetSha256;
  const nodeIdentity = `node-v${options.nodeVersion}-${target.runtimeTarget}`;
  const security = manifestSecurity(target);
  const releaseImpactEntry = reviewedReleaseImpactEntry(options);
  return {
    schemaVersion: 1,
    product: manifestProduct(),
    release: manifestRelease(options),
    artifact: manifestArtifact(options, target, { ...digests, assetSha256: assetSha }),
    provenance: manifestProvenance(options, digests),
    runtime: manifestRuntime(options, target, digests),
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
      releaseImpactEntry,
    ),
    updateEligibility: manifestUpdateEligibility(),
  };
}

function reviewedReleaseImpactEntry(options) {
  const entries = Array.isArray(releaseImpactCatalog.entries) ? releaseImpactCatalog.entries : [];
  const matches = entries.filter((candidate) => releaseImpactEntryMatches(candidate, options));
  if (matches.length !== 1) {
    fail("release-impact catalog must contain exactly one reviewed portable runtime staging entry");
  }
  return matches[0];
}

function releaseImpactEntryMatches(entry, options) {
  return (
    entry.packageName === rootPackage.name &&
    entry.packageVersion === rootPackage.version &&
    entry.releaseTag === options.releaseTag &&
    entry.review?.status === "reviewed" &&
    entry.review?.humanApproved === true &&
    portableRuntimeContractMatches(entry.portableRuntimeArtifactContract)
  );
}

function portableRuntimeContractMatches(contract) {
  return (
    contract !== null &&
    typeof contract === "object" &&
    contract.issue === PORTABLE_RELEASE_IMPACT_CONTRACT.issue &&
    contract.parentEpic === PORTABLE_RELEASE_IMPACT_CONTRACT.parentEpic &&
    contract.programEpic === PORTABLE_RELEASE_IMPACT_CONTRACT.programEpic &&
    contract.stagingOnly === PORTABLE_RELEASE_IMPACT_CONTRACT.stagingOnly &&
    sameStringSet(contract.targets, PORTABLE_RELEASE_IMPACT_CONTRACT.targets)
  );
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  return actualSet.size === expected.length && expected.every((value) => actualSet.has(value));
}

async function assemble(options) {
  const target = portableTargetByName(options.target);
  const tmp = mkdtempSync(join(tmpdir(), "keiko-portable-stage-"));
  const finalRoot = resolve(options.outDir, target.platformTarget);
  rmSync(finalRoot, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const extractRoot = join(tmp, "extract");
    const stageRoot = join(tmp, "stage", target.platformTarget);
    const payloadContainer = join(stageRoot, "payload");
    const payloadRoot = join(payloadContainer, "Keiko");
    const resourceRoot = payloadResourceRoot(target, payloadRoot);
    mkdirSync(extractRoot, { recursive: true });
    mkdirSync(resourceRoot, { recursive: true });
    const nodeArchiveSha256 = await stageNodeRuntime(options, target, resourceRoot);
    preparePackageSurface();
    const tarball = packRoot(tmp);
    stagePackedPackage(tarball, extractRoot, resourceRoot);
    stageLauncher(target, payloadRoot);
    const appTreeSha256 = hashDirectoryTree(join(resourceRoot, "app"));
    const tarballSha256 = await sha256File(tarball);
    const assetPath = createZipArchive(payloadContainer, target.assetName, stageRoot);
    const assetSha256 = await sha256File(assetPath);
    const sizeBytes = statSync(assetPath).size;
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
    writeManifest(stageRoot, manifest);
    const failures = validatePortableManifest(manifest, { allowUnverified: true });
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
