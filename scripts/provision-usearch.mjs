// Provision the pinned USearch HNSW runtime for local and CI verification (Epic #2556).
//
// USearch's published package declares the invalid SPDX string "Apache 2.0", while its LICENSE is
// Apache-2.0. Keiko therefore does not add it to the npm dependency graph. This script downloads
// the exact upstream npm tarball, verifies the tarball, extracts only the approved host binary and
// license, and verifies both again. Product code repeats the binary check at every native load.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { arch, env, platform } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  USEARCH_RUNTIME_MANIFEST,
  usearchRuntimeTargetKey,
} from "../packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_ROOT = join(REPO_ROOT, ".usearch", USEARCH_RUNTIME_MANIFEST.version);
const LICENSE_ARCHIVE_PATH = "package/LICENSE";
const SYSTEM_BINARIES =
  platform === "win32"
    ? {
        curl: join(env.SystemRoot ?? String.raw`C:\Windows`, "System32", "curl.exe"),
        tar: join(env.SystemRoot ?? String.raw`C:\Windows`, "System32", "tar.exe"),
      }
    : { curl: "/usr/bin/curl", tar: "/usr/bin/tar" };

function fail(message) {
  console.error(`provision-usearch: ${message}`);
  process.exit(1);
}

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verify(path, expected) {
  const actual = sha256Of(path);
  if (actual !== expected) fail(`checksum mismatch: expected ${expected}, got ${actual}`);
}

function systemBinary(name) {
  const path = SYSTEM_BINARIES[name];
  if (!existsSync(path)) fail(`required system binary not found at ${path}`);
  return path;
}

function download(destination) {
  execFileSync(
    systemBinary("curl"),
    ["--proto", "=https", "-sSfL", "-o", destination, USEARCH_RUNTIME_MANIFEST.tarballUrl],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

export function provisionedUsearchBinaryPath(
  root,
  hostPlatform = platform,
  hostArchitecture = arch,
) {
  const target = usearchRuntimeTargetKey(hostPlatform, hostArchitecture);
  return target === undefined
    ? undefined
    : join(root, ".usearch", USEARCH_RUNTIME_MANIFEST.version, target, "usearch.node");
}

function extractApprovedFiles(tarball, staging, archivePath) {
  execFileSync(
    systemBinary("tar"),
    ["-xzf", tarball, "-C", staging, archivePath, LICENSE_ARCHIVE_PATH],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

function writeProvenance(targetDir, targetKey) {
  writeFileSync(
    join(targetDir, "PROVENANCE.txt"),
    [
      `version=${USEARCH_RUNTIME_MANIFEST.version}`,
      `sourceCommit=${USEARCH_RUNTIME_MANIFEST.sourceCommit}`,
      `target=${targetKey}`,
      `tarballSha256=${USEARCH_RUNTIME_MANIFEST.tarballSha256}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function main() {
  const targetKey = usearchRuntimeTargetKey(platform, arch);
  if (targetKey === undefined) {
    console.log(`provision-usearch: no approved runtime for ${platform}-${arch}; skipping.`);
    return;
  }
  const target = USEARCH_RUNTIME_MANIFEST.targets[targetKey];
  const targetDir = join(TARGET_ROOT, targetKey);
  const binaryPath = join(targetDir, "usearch.node");
  const licensePath = join(targetDir, "LICENSE");
  if (
    existsSync(binaryPath) &&
    existsSync(licensePath) &&
    sha256Of(binaryPath) === target.binarySha256 &&
    sha256Of(licensePath) === USEARCH_RUNTIME_MANIFEST.licenseSha256
  ) {
    console.log(`provision-usearch: already verified at ${binaryPath}`);
    return;
  }

  const staging = mkdtempSync(join(tmpdir(), "keiko-usearch-provision-"));
  try {
    const tarball = join(staging, `usearch-${USEARCH_RUNTIME_MANIFEST.version}.tgz`);
    download(tarball);
    verify(tarball, USEARCH_RUNTIME_MANIFEST.tarballSha256);
    extractApprovedFiles(tarball, staging, target.archivePath);
    const extractedBinary = join(staging, target.archivePath);
    const extractedLicense = join(staging, LICENSE_ARCHIVE_PATH);
    verify(extractedBinary, target.binarySha256);
    verify(extractedLicense, USEARCH_RUNTIME_MANIFEST.licenseSha256);
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(extractedBinary, binaryPath);
    copyFileSync(extractedLicense, licensePath);
    verify(binaryPath, target.binarySha256);
    verify(licensePath, USEARCH_RUNTIME_MANIFEST.licenseSha256);
    chmodSync(binaryPath, 0o755);
    writeProvenance(targetDir, targetKey);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`provision-usearch: verified and extracted to ${binaryPath}`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  main();
}
