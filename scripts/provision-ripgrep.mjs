// Provision the pinned ripgrep runtime for development, CI and portable staging (Epic #3897).
//
// OpenCode's glob/grep tools need ripgrep. Left alone, the runtime downloads it from GitHub at first
// use, which a firewalled customer, the loopback-only runtime lane and an offline CI runner all
// forbid. Keiko pins the identical upstream release instead, exactly like the USearch runtime
// (scripts/provision-usearch.mjs): this script downloads the one approved archive for the host,
// verifies its SHA-256, extracts ONLY the approved executable and the MIT license into a fresh
// private directory, verifies both again, and installs them under
// `.ripgrep/<version>/<target>/`. It touches nothing else. The product repeats the executable check
// at every launch through the same `verifyPinnedRuntimeFile` this script uses to accept its own
// output, so the provisioner and the loader cannot disagree about what "verified" means.
//
// The approval table lives in packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts and is
// loaded here through Node's type stripping, so this script needs no build and no installed
// dependency; CI runs it as a setup step.

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
import { arch, platform } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RIPGREP_LICENSE_MAX_BYTES,
  RIPGREP_RUNTIME_MANIFEST,
  ripgrepProvisionedDirectory,
  ripgrepRuntimeApproval,
  ripgrepRuntimeTargetKey,
  verifyPinnedRuntimeFile,
} from "../packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts";
import { sha256File } from "./lib/digest.mjs";
import { download, systemBinariesFor, systemBinary } from "./provision-usearch.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYSTEM_BINARIES = systemBinariesFor(platform, process.env.SystemRoot);

export function fail(message, { error = console.error, exit = process.exit } = {}) {
  error(`provision-ripgrep: ${message}`);
  exit(1);
}

function verify(path, expected, label, failWith) {
  const actual = sha256File(path);
  if (actual !== expected) {
    failWith(`${label} checksum mismatch: expected ${expected}, got ${actual}`);
  }
}

// An extracted entry must be a regular file the archive itself created. A link would let a member
// name resolve to bytes outside the private staging directory before they are hashed.
function requireExtractedRegularFile(path, label, failWith) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined || entry.isSymbolicLink() || !entry.isFile()) {
    failWith(`extracted ${label} is not a regular file`);
  }
}

export function memberPath(staging, member) {
  return join(staging, ...member.split("/"));
}

export function extractApprovedFiles(
  archive,
  staging,
  approval,
  { binaries = SYSTEM_BINARIES, execute = execFileSync, exists = existsSync } = {},
) {
  // bsdtar (macOS, Windows System32) reads both formats; GNU tar reads the tar.gz archives that are
  // the only ones a Linux host is ever offered. Only the two approved members are named, so
  // nothing else in the archive is extracted.
  const extract = approval.archiveKind === "zip" ? "-xf" : "-xzf";
  execute(
    systemBinary("tar", binaries, { exists }),
    [extract, archive, "-C", staging, approval.binaryMember, approval.licenseMember],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

function writeProvenance(targetDir, approval) {
  const path = join(targetDir, "PROVENANCE.txt");
  writeFileSync(
    path,
    [
      `version=${approval.version}`,
      `sourceCommit=${approval.sourceCommit}`,
      `target=${approval.targetKey}`,
      `archiveUrl=${approval.archiveUrl}`,
      `archiveSha256=${approval.archiveSha256}`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o644);
}

export function isTrustedProvisionedRipgrep(binaryPath, licensePath, approval) {
  return (
    verifyPinnedRuntimeFile(binaryPath, [approval.binarySha256]).ok &&
    verifyPinnedRuntimeFile(licensePath, [approval.licenseSha256], {
      maxBytes: RIPGREP_LICENSE_MAX_BYTES,
    }).ok
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
    runtimeManifest: RIPGREP_RUNTIME_MANIFEST,
    trustFile: isTrustedProvisionedRipgrep,
    ...input,
  };
}

function verifyExtracted(staging, approval, failWith) {
  const binary = memberPath(staging, approval.binaryMember);
  const license = memberPath(staging, approval.licenseMember);
  requireExtractedRegularFile(binary, "executable", failWith);
  requireExtractedRegularFile(license, "license", failWith);
  verify(binary, approval.binarySha256, "executable", failWith);
  verify(license, approval.licenseSha256, "license", failWith);
  if (lstatSync(binary).size !== approval.binarySizeBytes) {
    failWith("executable size does not match the approval");
  }
  return { binary, license };
}

function installFiles(extracted, targetDir, binaryPath, licensePath) {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  chmodSync(targetDir, 0o755);
  copyFileSync(extracted.binary, binaryPath);
  copyFileSync(extracted.license, licensePath);
  chmodSync(binaryPath, 0o755);
  chmodSync(licensePath, 0o644);
}

function installRipgrepRuntime(options, approval, targetDir, binaryPath, licensePath) {
  const { downloadFile, extractFiles, failWith, log, trustFile } = options;
  const staging = mkdtempSync(join(tmpdir(), "keiko-ripgrep-provision-"));
  try {
    const archive = join(staging, `ripgrep-${approval.version}.${approval.archiveKind}`);
    downloadFile(archive, { tarballUrl: approval.archiveUrl }, { failWith });
    verify(archive, approval.archiveSha256, "archive", failWith);
    extractFiles(archive, staging, approval);
    installFiles(verifyExtracted(staging, approval, failWith), targetDir, binaryPath, licensePath);
    writeProvenance(targetDir, approval);
    if (!trustFile(binaryPath, licensePath, approval)) {
      failWith("provisioned runtime ownership, permissions, or digest verification failed");
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  log(`provision-ripgrep: verified and extracted to ${binaryPath}`);
  return binaryPath;
}

export function provisionRipgrep(input = {}) {
  const options = provisionOptions(input);
  const { hostArchitecture, hostPlatform, log, root, runtimeManifest, trustFile } = options;
  const targetKey = ripgrepRuntimeTargetKey(hostPlatform, hostArchitecture);
  const approval = ripgrepRuntimeApproval(targetKey, runtimeManifest);
  if (targetKey === undefined || approval === undefined) {
    log(
      `provision-ripgrep: no approved runtime for ${hostPlatform}-${hostArchitecture}; skipping.`,
    );
    return undefined;
  }
  const targetDir = ripgrepProvisionedDirectory(root, targetKey, runtimeManifest);
  const binaryPath = join(targetDir, approval.binaryName);
  const licensePath = join(targetDir, approval.licenseFileName);
  if (trustFile(binaryPath, licensePath, approval)) {
    log(`provision-ripgrep: already verified at ${binaryPath}`);
    return binaryPath;
  }
  return installRipgrepRuntime(options, approval, targetDir, binaryPath, licensePath);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  provisionRipgrep();
}
