#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { join, posix, resolve } from "node:path";
import { URL } from "node:url";

import {
  PORTABLE_PAYLOAD_MAX_DEPTH as MAX_DEPTH,
  PORTABLE_PAYLOAD_MAX_FILES as MAX_FILES,
  portablePayloadRelativePath as portablePath,
  validatePortableCandidateManifest,
} from "./portable-runtime.mjs";
import { rebindExistingSignedArchive, rebindSignedPayload } from "./portable-signed-archive.mjs";
import { createPortableZipAdapter } from "./stage-portable-runtime.mjs";
import {
  assertWindowsProductionVerificationInput,
  WindowsVerificationInputError,
} from "./windows-portable-verification-input.mjs";

const MAX_PE_FILES = 4_096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const ARTIFACT_SIGNING_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.codesigning\.azure\.net$/u;
const WINDOWS_TARGET = "windows-x64";

export class BoundedWindowsSigningError extends Error {}

function fail(message) {
  throw new BoundedWindowsSigningError(`windows-portable-signing: ${message}`);
}

export function redactedWindowsSigningError(error) {
  return error instanceof BoundedWindowsSigningError ||
    error instanceof WindowsVerificationInputError
    ? error.message
    : "windows-portable-signing: redacted failure";
}

export function validateAzureArtifactSigningConfig(env) {
  const names = [
    "AZURE_CLIENT_ID",
    "AZURE_TENANT_ID",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_ARTIFACT_SIGNING_ENDPOINT",
    "AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME",
    "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE_NAME",
    "AZURE_ARTIFACT_SIGNING_IDENTITY_EKU",
  ];
  if (names.some((name) => typeof env[name] !== "string" || env[name].trim().length === 0)) {
    fail("protected configuration is incomplete");
  }
  for (const name of ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID"]) {
    if (!GUID_PATTERN.test(env[name])) fail("protected identifier is invalid");
  }
  let endpoint;
  try {
    endpoint = new URL(env.AZURE_ARTIFACT_SIGNING_ENDPOINT);
  } catch {
    fail("service endpoint is invalid");
  }
  const canonical = `https://${endpoint.hostname}/`;
  if (
    env.AZURE_ARTIFACT_SIGNING_ENDPOINT !== canonical ||
    !ARTIFACT_SIGNING_HOST_PATTERN.test(endpoint.hostname)
  ) {
    fail("service endpoint is invalid");
  }
  if (
    !/^1\.3\.6\.1\.4\.1\.311\.97\.[0-9]+(?:\.[0-9]+)*$/u.test(
      env.AZURE_ARTIFACT_SIGNING_IDENTITY_EKU,
    )
  ) {
    fail("subscriber identity EKU is invalid");
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function run(command, args, cwd, { surfaceOutputOnFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    if (surfaceOutputOnFailure) {
      const output = [result.stdout, result.stderr]
        .filter((text) => typeof text === "string" && text.trim().length > 0)
        .join("\n")
        .trim();
      if (output.length > 0) console.error(output);
    }
    fail("archive finalization failed");
  }
}

function windowsZipAdapter() {
  return createPortableZipAdapter("win32", (command, args, options = {}) => {
    run(command, args, options.cwd);
    return { stdout: "" };
  });
}

export async function rebindPortableSignedArchive(
  stageRoot,
  manifest,
  archiveAdapter = windowsZipAdapter(),
) {
  const payloadContainer = join(stageRoot, "payload");
  const archivePath = join(stageRoot, manifest.artifact.assetName);
  rebindSignedPayload(stageRoot, manifest, WINDOWS_TARGET);
  rmSync(archivePath, { force: true });
  archiveAdapter.create(payloadContainer, "Keiko", archivePath);
  await rebindExistingSignedArchive(stageRoot, manifest, archivePath, WINDOWS_TARGET, {
    payloadAlreadyRebound: true,
  });
}

async function finalizeCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  verifyInventoryCommand(options);
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.artifact?.platformTarget !== WINDOWS_TARGET)
    fail("manifest target is not Windows x64");
  const verificationInputPath = resolve(required(options, "verification-input"));
  assertWindowsProductionVerificationInput(verificationInputPath, manifest);
  await rebindPortableSignedArchive(stageRoot, manifest);
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
      verificationInputPath,
    ],
    resolve(import.meta.dirname, ".."),
    { surfaceOutputOnFailure: true },
  );
  const finalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const failures = validatePortableCandidateManifest(finalManifest);
  if (
    failures.length > 0 ||
    finalManifest.security.verificationStatus !== "verified-production" ||
    finalManifest.updateEligibility.requiredPredicates.platformSignatureLocallyVerified !== true
  ) {
    fail("production manifest did not reach the verified state");
  }
  console.log("windows-portable-signing: verified production archive finalized");
}

export const rebindArchive = rebindPortableSignedArchive;

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === "validate-config") validateAzureArtifactSigningConfig(process.env);
  else if (command === "inventory") inventoryCommand(options);
  else if (command === "verify-inventory") verifyInventoryCommand(options);
  else if (command === "compare-paths") comparePathsCommand(options);
  else if (command === "finalize") await finalizeCommand(options);
  else
    fail(
      "command must be validate-config, inventory, compare-paths, verify-inventory, or finalize",
    );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    await main();
  } catch (error) {
    console.error(redactedWindowsSigningError(error));
    process.exit(1);
  }
}
