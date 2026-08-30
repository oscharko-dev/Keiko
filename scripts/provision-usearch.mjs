// Provision the pinned USearch HNSW runtime for local and CI verification (Epic #2556).
//
// USearch's published package declares the invalid SPDX string "Apache 2.0", while its LICENSE is
// Apache-2.0. Keiko therefore does not add it to the npm dependency graph. This script downloads
// the exact upstream npm tarball, verifies the tarball, extracts only the approved host binary and
// license, and verifies both again. Product code repeats the binary check at every native load.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { arch, env, platform } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  USEARCH_RUNTIME_MANIFEST,
  usearchRuntimeApproval,
  usearchRuntimeTargetKey,
} from "../packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts";
import { resolveWindowsSystemDirectory } from "../packages/keiko-security/src/windows-system-directory.ts";
import { sha256File } from "./lib/digest.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_ARCHIVE_PATH = "package/LICENSE";
const DOWNLOAD_CONNECT_TIMEOUT_SECONDS = 10;
const DOWNLOAD_MAX_SECONDS = 300;
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

// IDX55 follow-up (PR #3355 review): this used to read SystemRoot raw (`systemRoot ?? "C:\Windows"`)
// and join it straight onto System32/curl.exe and System32/tar.exe, unvalidated — the same banned
// pattern windows-msvc.mjs carried, missed by trusted-system-root-usage.test.mjs only because that
// pin scans packages/*/src, not scripts/. `resolveWindowsSystemDirectory` adds the canonical-shape
// validation (throws on a hostile override); the existence check stays with `systemBinary()` below,
// which already performs it and fails closed through this script's own `fail()`, not by throwing.
export function systemBinariesFor(hostPlatform, systemRoot) {
  return hostPlatform === "win32"
    ? {
        curl: join(
          resolveWindowsSystemDirectory({ SystemRoot: systemRoot }),
          "System32",
          "curl.exe",
        ),
        tar: join(resolveWindowsSystemDirectory({ SystemRoot: systemRoot }), "System32", "tar.exe"),
      }
    : { curl: "/usr/bin/curl", tar: "/usr/bin/tar" };
}

const SYSTEM_BINARIES = systemBinariesFor(platform, env.SystemRoot);

export function fail(message, { error = console.error, exit = process.exit } = {}) {
  error(`provision-usearch: ${message}`);
  exit(1);
}

function verify(path, expected, failWith = fail) {
  const actual = sha256File(path);
  if (actual !== expected) failWith(`checksum mismatch: expected ${expected}, got ${actual}`);
}

export function trustedPosixOwnerAndMode(entry, currentUid) {
  if (currentUid === undefined) return true;
  return (entry.uid === currentUid || entry.uid === 0) && (entry.mode & 0o022) === 0;
}

function trustedProvisionedEntries(entry, parent, currentUid) {
  return (
    entry.isFile() &&
    !entry.isSymbolicLink() &&
    parent.isDirectory() &&
    !parent.isSymbolicLink() &&
    trustedPosixOwnerAndMode(entry, currentUid) &&
    trustedPosixOwnerAndMode(parent, currentUid)
  );
}

export function isTrustedProvisionedUsearchFile(
  path,
  expectedSha256,
  { currentUid = process.getuid?.() } = {},
) {
  // Same-uid POSIX mutation and Windows ACL evaluation remain outside Node's mode-bit model. This
  // check establishes the portable minimum used by the worker: no symlink, regular bytes, pinned
  // digest, current/root POSIX ownership, and no group/world write authority.
  try {
    const entry = lstatSync(path);
    const parent = lstatSync(dirname(path));
    return (
      trustedProvisionedEntries(entry, parent, currentUid) && sha256File(path) === expectedSha256
    );
  } catch {
    return false;
  }
}

export function systemBinary(
  name,
  binaries = SYSTEM_BINARIES,
  { exists = existsSync, failWith = fail } = {},
) {
  const path = binaries[name];
  if (!exists(path)) failWith(`required system binary not found at ${path}`);
  return path;
}

export function download(
  destination,
  runtimeManifest,
  {
    binaries = SYSTEM_BINARIES,
    execute = execFileSync,
    exists = existsSync,
    failWith = fail,
    inspect = lstatSync,
    remove = rmSync,
  } = {},
) {
  execute(
    systemBinary("curl", binaries, { exists }),
    [
      "--proto",
      "=https",
      "--connect-timeout",
      String(DOWNLOAD_CONNECT_TIMEOUT_SECONDS),
      "--max-time",
      String(DOWNLOAD_MAX_SECONDS),
      "--max-filesize",
      String(DOWNLOAD_MAX_BYTES),
      "-sSfL",
      "-o",
      destination,
      runtimeManifest.tarballUrl,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const downloaded = inspect(destination);
  if (downloaded.isFile() && downloaded.size <= DOWNLOAD_MAX_BYTES) return;
  remove(destination, { force: true });
  failWith(`downloaded archive exceeds the ${String(DOWNLOAD_MAX_BYTES)} byte limit`);
}

export function provisionedUsearchBinaryPath(
  root,
  hostPlatform = platform,
  hostArchitecture = arch,
) {
  const target = usearchRuntimeTargetKey(hostPlatform, hostArchitecture);
  const approval = usearchRuntimeApproval(target);
  return approval === undefined
    ? undefined
    : join(root, ".usearch", approval.version, target, "usearch.node");
}

export function extractApprovedFiles(
  tarball,
  staging,
  archivePath,
  { binaries = SYSTEM_BINARIES, execute = execFileSync, exists = existsSync } = {},
) {
  execute(
    systemBinary("tar", binaries, { exists }),
    ["-xzf", tarball, "-C", staging, archivePath, LICENSE_ARCHIVE_PATH],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

function writeProvenance(targetDir, targetKey, approval) {
  writeFileSync(
    join(targetDir, "PROVENANCE.txt"),
    [
      `version=${approval.version}`,
      `sourceCommit=${approval.sourceCommit}`,
      `target=${targetKey}`,
      `tarballSha256=${approval.tarballSha256}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function provisionOptions(input) {
  return {
    downloadFile: download,
    extractFiles: extractApprovedFiles,
    failWith: fail,
    hostArchitecture: arch,
    hostPlatform: platform,
    log: console.log,
    root: REPO_ROOT,
    runtimeManifest: USEARCH_RUNTIME_MANIFEST,
    trustFile: isTrustedProvisionedUsearchFile,
    ...input,
  };
}

function installUsearchRuntime(options, targetKey, approval, targetDir, binaryPath, licensePath) {
  const { downloadFile, extractFiles, failWith, log, trustFile } = options;
  const staging = mkdtempSync(join(tmpdir(), "keiko-usearch-provision-"));
  try {
    const tarball = join(staging, `usearch-${approval.version}.tgz`);
    downloadFile(tarball, approval);
    verify(tarball, approval.tarballSha256, failWith);
    extractFiles(tarball, staging, approval.archivePath);
    const extractedBinary = join(staging, approval.archivePath);
    const extractedLicense = join(staging, LICENSE_ARCHIVE_PATH);
    verify(extractedBinary, approval.binarySha256, failWith);
    verify(extractedLicense, approval.licenseSha256, failWith);
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true, mode: 0o755 });
    chmodSync(targetDir, 0o755);
    copyFileSync(extractedBinary, binaryPath);
    copyFileSync(extractedLicense, licensePath);
    chmodSync(binaryPath, 0o755);
    chmodSync(licensePath, 0o644);
    writeProvenance(targetDir, targetKey, approval);
    chmodSync(join(targetDir, "PROVENANCE.txt"), 0o644);
    if (
      !trustFile(binaryPath, approval.binarySha256) ||
      !trustFile(licensePath, approval.licenseSha256)
    ) {
      failWith("provisioned runtime ownership, permissions, or digest verification failed");
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  log(`provision-usearch: verified and extracted to ${binaryPath}`);
  return binaryPath;
}

export function provisionUsearch(input = {}) {
  const options = provisionOptions(input);
  const { hostArchitecture, hostPlatform, log, root, runtimeManifest, trustFile } = options;
  const targetKey = usearchRuntimeTargetKey(hostPlatform, hostArchitecture);
  if (targetKey === undefined) {
    log(
      `provision-usearch: no approved runtime for ${hostPlatform}-${hostArchitecture}; skipping.`,
    );
    return undefined;
  }
  const approval = usearchRuntimeApproval(targetKey, runtimeManifest);
  if (approval === undefined) {
    log(`provision-usearch: no approved runtime for ${targetKey}; skipping.`);
    return undefined;
  }
  const targetDir = join(root, ".usearch", approval.version, targetKey);
  const binaryPath = join(targetDir, "usearch.node");
  const licensePath = join(targetDir, "LICENSE");
  if (
    trustFile(binaryPath, approval.binarySha256) &&
    trustFile(licensePath, approval.licenseSha256)
  ) {
    log(`provision-usearch: already verified at ${binaryPath}`);
    return binaryPath;
  }
  return installUsearchRuntime(options, targetKey, approval, targetDir, binaryPath, licensePath);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  provisionUsearch();
}
