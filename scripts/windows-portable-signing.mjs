#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, posix, relative, resolve } from "node:path";

import { hashDirectoryTree, sha256File, validatePortableManifest } from "./portable-runtime.mjs";

const MAX_FILES = 50_000;
const MAX_DEPTH = 32;
const MAX_PE_FILES = 4_096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const WINDOWS_TARGET = "windows-x64";

function fail(message) {
  throw new Error(`windows-portable-signing: ${message}`);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

function portablePath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function isPortableExecutable(path) {
  const size = statSync(path).size;
  if (size < 64) return false;
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(64);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
    if (header[0] !== 0x4d || header[1] !== 0x5a) return false;
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > size - 4) return false;
    const signature = Buffer.alloc(4);
    if (readSync(descriptor, signature, 0, signature.length, peOffset) !== signature.length) {
      return false;
    }
    return signature.equals(Buffer.from([0x50, 0x45, 0x00, 0x00]));
  } finally {
    closeSync(descriptor);
  }
}

function walkFiles(root, current, depth, state) {
  if (depth > MAX_DEPTH) fail("payload tree exceeds the bounded directory depth");
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) fail("payload tree contains a link or reparse point");
    if (entry.isDirectory()) {
      walkFiles(root, path, depth + 1, state);
      continue;
    }
    inspectPayloadFile(root, path, name, entry, state);
  }
}

function inspectPayloadFile(root, path, name, entry, state) {
  if (!entry.isFile()) fail("payload tree contains a special file");
  if (entry.nlink !== 1) fail("payload tree contains a hard-linked file");
  state.fileCount += 1;
  if (state.fileCount > MAX_FILES) fail("payload tree exceeds the bounded file count");
  const relativePath = portablePath(root, path);
  if (relativePath.startsWith("../") || posix.isAbsolute(relativePath)) {
    fail("payload file escapes the bounded root");
  }
  const isPe = isPortableExecutable(path);
  if (/\.(?:dll|exe)$/iu.test(name) && !isPe) {
    fail("an executable-named payload file is not valid PE");
  }
  if (isPe) state.peFiles.push({ relativePath, sha256: sha256Bytes(readFileSync(path)) });
}

export function inventoryWindowsPortablePeFiles(payloadRoot) {
  const root = resolve(payloadRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) fail("payload root is missing");
  const state = { fileCount: 0, peFiles: [] };
  walkFiles(root, root, 0, state);
  state.peFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (state.peFiles.length === 0 || state.peFiles.length > MAX_PE_FILES) {
    fail("PE inventory is empty or exceeds its bound");
  }
  const paths = new Set(state.peFiles.map((file) => file.relativePath.toLowerCase()));
  if (!paths.has("keiko.exe")) fail("primary Keiko.exe is missing from the PE inventory");
  if (!paths.has("runtime/node/node.exe")) {
    fail("bundled Node executable is missing from the PE inventory");
  }
  return { schemaVersion: 1, target: WINDOWS_TARGET, files: state.peFiles };
}

function readInventory(path) {
  const inventory = JSON.parse(readFileSync(path, "utf8"));
  assertInventoryDocument(inventory);
  const seen = new Set();
  for (const file of inventory.files) assertInventoryEntry(file, seen);
  return inventory;
}

function assertInventoryDocument(inventory) {
  if (
    inventory?.schemaVersion !== 1 ||
    inventory?.target !== WINDOWS_TARGET ||
    !Array.isArray(inventory.files) ||
    inventory.files.length === 0 ||
    inventory.files.length > MAX_PE_FILES
  ) {
    fail("PE inventory is invalid");
  }
}

function assertInventoryEntry(file, seen) {
  const relativePath = file?.relativePath;
  const digest = file?.sha256;
  if (typeof relativePath !== "string" || !isSafeRelativePath(relativePath)) {
    fail("PE inventory contains an invalid entry");
  }
  if (typeof digest !== "string" || !SHA256_PATTERN.test(digest)) {
    fail("PE inventory contains an invalid entry");
  }
  const key = relativePath.toLowerCase();
  if (seen.has(key)) fail("PE inventory contains a duplicate entry");
  seen.add(key);
}

function isSafeRelativePath(path) {
  return (
    path.length > 0 &&
    path === path.replaceAll("\\", "/") &&
    !posix.isAbsolute(path) &&
    !path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  );
}

export function inventoriesMatch(expected, actual) {
  return JSON.stringify(expected.files) === JSON.stringify(actual.files);
}

export function inventoryPathsMatch(expected, actual) {
  return (
    expected.files.length === actual.files.length &&
    expected.files.every((file, index) => file.relativePath === actual.files[index]?.relativePath)
  );
}

export function catalogForInventory(inventory) {
  return `${inventory.files.map((file) => `payload/Keiko/${file.relativePath}`).join("\n")}\n`;
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("invalid command arguments");
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) fail(`--${name} is required`);
  return value;
}

function inventoryCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  const inventoryPath = resolve(required(options, "inventory"));
  const catalogPath = resolve(required(options, "catalog"));
  const inventory = inventoryWindowsPortablePeFiles(join(stageRoot, "payload", "Keiko"));
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(catalogPath, catalogForInventory(inventory), { mode: 0o600 });
  console.log(`windows-portable-signing: inventoried ${String(inventory.files.length)} PE files`);
}

function verifyInventoryCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  const expected = readInventory(required(options, "expected-inventory"));
  const actual = inventoryWindowsPortablePeFiles(join(stageRoot, "payload", "Keiko"));
  if (!inventoriesMatch(expected, actual)) fail("verified PE inventory no longer matches payload");
}

function comparePathsCommand(options) {
  const expected = readInventory(required(options, "expected-inventory"));
  const actual = readInventory(required(options, "actual-inventory"));
  if (!inventoryPathsMatch(expected, actual)) fail("PE inventory changed during signing");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) fail("archive finalization failed");
}

function treeSize(root) {
  let size = 0;
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const entry = lstatSync(path);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) size += entry.size;
      else fail("signed payload contains an unsupported entry");
    }
  };
  walk(root);
  return size;
}

function rebindSidecars(manifest, payloadRoot) {
  for (const sidecar of manifest.sidecarRuntimes ?? []) {
    const root = resolve(payloadRoot, sidecar.payloadRootPath);
    if (portablePath(payloadRoot, root) !== sidecar.payloadRootPath) {
      fail("sidecar payload root is not canonical");
    }
    sidecar.payloadSha256 = hashDirectoryTree(root);
    sidecar.sizeBytes = treeSize(root);
  }
}

async function rebindArchive(stageRoot, manifest) {
  const payloadContainer = join(stageRoot, "payload");
  const payloadRoot = join(payloadContainer, "Keiko");
  const archivePath = join(stageRoot, manifest.artifact.assetName);
  rmSync(archivePath, { force: true });
  run("zip", ["-qr", archivePath, "Keiko"], payloadContainer);
  const archiveSha256 = await sha256File(archivePath);
  const provenancePath = join(stageRoot, "evidence", "provenance.intoto.jsonl");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  provenance.subjectDigest = archiveSha256;
  const provenanceText = `${JSON.stringify(provenance)}\n`;
  writeFileSync(provenancePath, provenanceText);
  manifest.artifact.sha256 = archiveSha256;
  manifest.artifact.sizeBytes = statSync(archivePath).size;
  manifest.provenance.packagedAppTreeSha256 = hashDirectoryTree(join(payloadRoot, "app"));
  manifest.provenance.provenanceStatementSha256 = sha256Text(provenanceText);
  rebindSidecars(manifest, payloadRoot);
  const binding = manifest.releaseImpact.reviewedBinding;
  binding.archiveSha256 = archiveSha256;
  binding.assetSizeBytes = manifest.artifact.sizeBytes;
  binding.provenanceStatementSha256 = manifest.provenance.provenanceStatementSha256;
  if (manifest.sidecarRuntimes !== undefined) {
    binding.sidecarRuntimes = JSON.parse(JSON.stringify(manifest.sidecarRuntimes));
  }
  writeFileSync(
    join(stageRoot, "evidence", "SHA256SUMS.txt"),
    `${archiveSha256}  ${basename(archivePath)}\n`,
  );
}

async function finalizeCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  verifyInventoryCommand(options);
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.artifact?.platformTarget !== WINDOWS_TARGET)
    fail("manifest target is not Windows x64");
  await rebindArchive(stageRoot, manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run(
    process.execPath,
    [
      "scripts/verify-portable-runtime-signing.mjs",
      "--manifest",
      manifestPath,
      "--policy",
      "production",
      "--verification-input",
      resolve(required(options, "verification-input")),
    ],
    resolve(import.meta.dirname, ".."),
  );
  const finalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const failures = validatePortableManifest(finalManifest);
  if (
    failures.length > 0 ||
    finalManifest.security.verificationStatus !== "verified-production" ||
    finalManifest.updateEligibility.requiredPredicates.platformSignatureLocallyVerified !== true
  ) {
    fail("production manifest did not reach the verified state");
  }
  console.log("windows-portable-signing: verified production archive finalized");
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === "inventory") inventoryCommand(options);
  else if (command === "verify-inventory") verifyInventoryCommand(options);
  else if (command === "compare-paths") comparePathsCommand(options);
  else if (command === "finalize") await finalizeCommand(options);
  else fail("command must be inventory, compare-paths, verify-inventory, or finalize");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "windows-portable-signing: failed");
    process.exit(1);
  }
}
