#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { URL } from "node:url";

import {
  PORTABLE_PAYLOAD_MAX_DEPTH as MAX_DEPTH,
  PORTABLE_PAYLOAD_MAX_FILES as MAX_FILES,
  portablePayloadRelativePath as portablePath,
  validatePortableCandidateManifest,
  WINDOWS_GENERATION_STAGING_RELATIVE_PATH,
  WINDOWS_PORTABLE_MANIFEST_SCHEMA_VERSION,
  WINDOWS_PORTABLE_SETUP_ASSET_NAME,
} from "./portable-runtime.mjs";
import {
  portableResourceRoot,
  rebindExistingSignedArchive,
  rebindSignedPayload,
} from "./portable-signed-archive.mjs";
import {
  buildWindowsGenerationLauncher,
  createPortableZipAdapter,
  stageWindowsPortableRootFiles,
} from "./stage-portable-runtime.mjs";
import { validateWindowsRootSetupManifest } from "./build-windows-portable-setup.mjs";
import {
  assertWindowsProductionVerificationInput,
  WindowsVerificationInputError,
} from "./windows-portable-verification-input.mjs";
import { sha256 } from "./lib/digest.mjs";
import {
  hashPortableHandoffTree,
  PORTABLE_HANDOFF_TREE_HASH_SCHEMA,
} from "../packages/keiko-server/src/update-portable-handoff-tree.ts";

const MAX_PE_FILES = 4_096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const ARTIFACT_SIGNING_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.codesigning\.azure\.net$/u;
const WINDOWS_TARGET = "windows-x64";
const RUNTIME_ATTESTATION_PATH = "runtime/native/keiko-runtime-attestation.exe";
const GENERATION_HASH_TIMEOUT_MS = 5 * 60_000;

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
    !/^1\.3\.6\.1\.4\.1\.311\.97\.\d+(?:\.\d+)*$/u.test(env.AZURE_ARTIFACT_SIGNING_IDENTITY_EKU)
  ) {
    fail("subscriber identity EKU is invalid");
  }
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
  for (const name of readdirSync(current).sort((left, right) => left.localeCompare(right))) {
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
  if (isPe) state.peFiles.push({ relativePath, sha256: sha256(readFileSync(path)) });
}

function inventoryPeFiles(rootPath) {
  const root = resolve(rootPath);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) fail("payload root is missing");
  const state = { fileCount: 0, peFiles: [] };
  walkFiles(root, root, 0, state);
  state.peFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (state.peFiles.length === 0 || state.peFiles.length > MAX_PE_FILES) {
    fail("PE inventory is empty or exceeds its bound");
  }
  return { schemaVersion: 1, target: WINDOWS_TARGET, files: state.peFiles };
}

function assertCoreWindowsPeInventory(inventory) {
  const paths = new Set(inventory.files.map((file) => file.relativePath.toLowerCase()));
  if (!paths.has("runtime/node/node.exe")) {
    fail("bundled Node executable is missing from the PE inventory");
  }
  if (!paths.has("runtime/native/keiko-secure-workspace-read.exe")) {
    fail("secure workspace read helper is missing from the PE inventory");
  }
  if (!paths.has("runtime/native/keiko-runtime-supervisor.exe")) {
    fail("runtime supervisor is missing from the PE inventory");
  }
  return inventory;
}

export function inventoryWindowsPortableCorePeFiles(payloadRoot) {
  return assertCoreWindowsPeInventory(inventoryPeFiles(payloadRoot));
}

export function inventoryWindowsPortablePeFiles(payloadRoot) {
  const inventory = inventoryPeFiles(payloadRoot);
  const paths = new Set(inventory.files.map((file) => file.relativePath.toLowerCase()));
  if (!paths.has("keiko.exe")) fail("primary Keiko.exe is missing from the PE inventory");
  return assertCoreWindowsPeInventory(inventory);
}

export function inventoryWindowsPortableStagePeFiles(stageRoot) {
  return inventoryPeFiles(stageRoot);
}

export function inventoryAddsOnlySetupCompanion(expectedPayload, actualStage) {
  if (actualStage.files.length !== expectedPayload.files.length + 1) return false;
  const actualByPath = new Map(
    actualStage.files.map((file) => [file.relativePath.toLowerCase(), file.sha256]),
  );
  const payloadMatches = expectedPayload.files.every(
    (file) => actualByPath.get(`payload/keiko/${file.relativePath.toLowerCase()}`) === file.sha256,
  );
  const setupDigest = actualByPath.get(WINDOWS_PORTABLE_SETUP_ASSET_NAME.toLowerCase());
  return payloadMatches && typeof setupDigest === "string" && SHA256_PATTERN.test(setupDigest);
}

export function readWindowsPortablePeInventory(path) {
  return parseWindowsPortablePeInventory(readFileSync(path));
}

function parseWindowsPortablePeInventory(bytes) {
  const inventory = JSON.parse(bytes.toString("utf8"));
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

function catalogPathForFile(file, prefix) {
  return `${prefix}/${file.relativePath}`;
}

export function inventoryAddsOnlyRuntimeAttestation(expected, actual) {
  const expectedPaths = expected.files.map((file) => file.relativePath);
  const actualPaths = actual.files.map((file) => file.relativePath);
  return (
    actualPaths.includes(RUNTIME_ATTESTATION_PATH) &&
    actualPaths.length === expectedPaths.length + 1 &&
    expectedPaths.every((path) => actualPaths.includes(path)) &&
    actualPaths.every((path) => path === RUNTIME_ATTESTATION_PATH || expectedPaths.includes(path))
  );
}

export function catalogForInventory(inventory, prefix = "payload/Keiko") {
  return `${inventory.files.map((file) => catalogPathForFile(file, prefix)).join("\n")}\n`;
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

// KEIKO-0658: parallel the macOS assertManifestCodeObjects cross-check. The Windows PE
// inventory step previously wrote the inventory + catalog without verifying that every
// manifest.sidecarRuntimes[].executablePath entry is actually PRESENT among the inventoried
// PE files. A future manifest that names a sidecar the payload does not carry would then be
// signed and shipped anyway, and the divergence would only be caught downstream — or never.
// Read portable-manifest.json (matching macOS's inventoryCommand at scripts/macos-portable-
// signing.mjs:168-172) and assert set membership before writing the inventory artifact.
function assertWindowsManifestSidecarInventory(manifest, paths) {
  for (const sidecar of manifest.sidecarRuntimes ?? []) {
    if (typeof sidecar?.executablePath !== "string") continue;
    if (!paths.has(sidecar.executablePath)) {
      fail(
        `manifest sidecar executable is missing from the Windows PE inventory: ${sidecar.executablePath}`,
      );
    }
  }
}

function inventoryCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  const inventoryPath = resolve(required(options, "inventory"));
  const catalogPath = resolve(required(options, "catalog"));
  const payloadRoot = join(stageRoot, "payload", "Keiko");
  if (!existsSync(payloadRoot) || !lstatSync(payloadRoot).isDirectory())
    fail("payload root is missing");
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const resourceRoot = portableResourceRoot(stageRoot, WINDOWS_TARGET, manifest);
  const inventory = inventoryWindowsPortableCorePeFiles(resourceRoot);
  const paths = new Set(inventory.files.map((entry) => entry.relativePath ?? entry.path ?? entry));
  assertWindowsManifestSidecarInventory(manifest, paths);
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  const catalogPrefix = relative(stageRoot, resourceRoot).replaceAll("\\", "/");
  writeFileSync(catalogPath, catalogForInventory(inventory, catalogPrefix), { mode: 0o600 });
  console.log(`windows-portable-signing: inventoried ${String(inventory.files.length)} PE files`);
}

function verifyInventoryCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  const expected = readWindowsPortablePeInventory(required(options, "expected-inventory"));
  const manifest = JSON.parse(
    readFileSync(join(stageRoot, "manifest", "portable-manifest.json"), "utf8"),
  );
  const actual = inventoryWindowsPortableCorePeFiles(
    portableResourceRoot(stageRoot, WINDOWS_TARGET, manifest),
  );
  if (!inventoriesMatch(expected, actual)) fail("verified PE inventory no longer matches payload");
}

function comparePathsCommand(options) {
  const expected = readWindowsPortablePeInventory(required(options, "expected-inventory"));
  const actual = readWindowsPortablePeInventory(required(options, "actual-inventory"));
  if (!inventoryPathsMatch(expected, actual)) fail("PE inventory changed during signing");
}

function compareWithAttestationCommand(options) {
  const expected = readWindowsPortablePeInventory(required(options, "expected-inventory"));
  const actual = readWindowsPortablePeInventory(required(options, "actual-inventory"));
  if (!inventoryAddsOnlyRuntimeAttestation(expected, actual)) {
    fail("PE inventory changed outside the runtime attestation carrier");
  }
}

function verifySetupScopeCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  const expected = readWindowsPortablePeInventory(required(options, "expected-inventory"));
  const actual = inventoryWindowsPortableStagePeFiles(stageRoot);
  if (!inventoryAddsOnlySetupCompanion(expected, actual)) {
    fail("stage PE inventory changed outside the Windows setup companion");
  }
  console.log(
    `windows-portable-signing: setup companion is the only added stage PE (${String(actual.files.length)} total)`,
  );
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

export async function rebindArchive(stageRoot, manifest, archiveAdapter = windowsZipAdapter()) {
  const payloadContainer = join(stageRoot, "payload");
  const archivePath = join(stageRoot, manifest.artifact.assetName);
  rebindSignedPayload(stageRoot, manifest, WINDOWS_TARGET);
  rmSync(archivePath, { force: true });
  archiveAdapter.create(payloadContainer, "Keiko", archivePath);
  await rebindExistingSignedArchive(stageRoot, manifest, archivePath, WINDOWS_TARGET, {
    payloadAlreadyRebound: true,
  });
}

function markNativeHelpersVerified(manifest) {
  if (!Array.isArray(manifest.nativeHelpers) || manifest.nativeHelpers.length !== 2) {
    fail("manifest must contain the complete native helper set");
  }
  for (const helper of manifest.nativeHelpers) {
    helper.signing = {
      signatureKind: "authenticode",
      verificationStatus: "verified-production",
      signatureVerified: true,
      notarizationRequired: false,
      notarizationVerified: false,
    };
  }
  manifest.releaseImpact.reviewedBinding.nativeHelpers = globalThis.structuredClone(
    manifest.nativeHelpers,
  );
}

function applyWindowsProductionState(manifest, input) {
  const state = {
    verificationPolicy: "production",
    verificationStatus: "verified-production",
    verificationReasonCodes: [],
    signatureKind: "authenticode",
    signatureVerified: true,
    notarizationRequired: false,
    notarizationVerified: false,
  };
  manifest.security = {
    ...manifest.security,
    ...state,
    verificationChecks: globalThis.structuredClone(input.verificationChecks),
  };
  const inputsByName = new Map(input.sidecarRuntimes.map((entry) => [entry.name, entry]));
  manifest.sidecarRuntimes = (manifest.sidecarRuntimes ?? []).map((sidecar) => {
    const sidecarInput = inputsByName.get(sidecar.name);
    if (sidecarInput === undefined) fail("sidecar verification input is incomplete");
    return {
      ...sidecar,
      signing: {
        ...sidecar.signing,
        ...state,
        verificationChecks: globalThis.structuredClone(sidecarInput.verificationChecks),
      },
    };
  });
  manifest.releaseImpact.reviewedBinding = {
    ...manifest.releaseImpact.reviewedBinding,
    ...state,
    platformSignatureLocallyVerified: true,
    verificationChecks: globalThis.structuredClone(input.verificationChecks),
    sidecarRuntimes: globalThis.structuredClone(manifest.sidecarRuntimes),
  };
  manifest.updateEligibility.requiredPredicates.platformSignatureLocallyVerified = true;
}

function authenticatedVerificationInventory(options, input) {
  const path = resolve(required(options, "expected-inventory"));
  const bytes = readFileSync(path);
  if (sha256(bytes) !== input.peInventorySha256) {
    fail("verification input does not bind the exact PE inventory document");
  }
  return parseWindowsPortablePeInventory(bytes);
}

function prepareQualifiedPayloadCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  verifyInventoryCommand(options);
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const input = assertWindowsProductionVerificationInput(
    resolve(required(options, "verification-input")),
    manifest,
  );
  authenticatedVerificationInventory(options, input);
  applyWindowsProductionState(manifest, input);
  markNativeHelpersVerified(manifest);
  rebindSignedPayload(stageRoot, manifest, WINDOWS_TARGET);
  manifest.runtimeActivation.trustAnchor = "authenticode-attestor";
  manifest.releaseImpact.reviewedBinding.sidecarRuntimes = globalThis.structuredClone(
    manifest.sidecarRuntimes,
  );
  manifest.releaseImpact.reviewedBinding.nativeHelpers = globalThis.structuredClone(
    manifest.nativeHelpers,
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function bindRuntimeAttestation(stageRoot, manifest) {
  const attestation = manifest.runtimeAttestation;
  if (
    attestation?.carrierKind !== "authenticode-executable" ||
    attestation.executablePath !== "runtime/native/keiko-runtime-attestation.exe"
  ) {
    fail("runtime attestation carrier is missing");
  }
  const path = join(
    portableResourceRoot(stageRoot, WINDOWS_TARGET, manifest),
    ...attestation.executablePath.split("/"),
  );
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    fail("runtime attestation carrier is invalid");
  }
  attestation.shippedSha256 = sha256(readFileSync(path));
  attestation.sizeBytes = entry.size;
  attestation.signing = {
    signatureKind: "authenticode",
    verificationStatus: "verified-production",
    signatureVerified: true,
    notarizationRequired: false,
    notarizationVerified: false,
  };
  if (!Array.isArray(manifest.nativeAddons) || manifest.nativeAddons.length !== 1) {
    fail("manifest must contain exactly one native addon");
  }
  manifest.nativeAddons[0].signing = {
    signatureKind: "authenticode",
    verificationStatus: "verified-production",
    signatureVerified: true,
    notarizationRequired: false,
    notarizationVerified: false,
  };
  manifest.releaseImpact.reviewedBinding.nativeAddons = globalThis.structuredClone(
    manifest.nativeAddons,
  );
  bindRuntimeAttestationSbom(stageRoot, manifest, attestation);
  manifest.releaseImpact.reviewedBinding.runtimeAttestation =
    globalThis.structuredClone(attestation);
}

function bindRuntimeAttestationSbom(stageRoot, manifest, attestation) {
  const path = join(stageRoot, "evidence", "sbom.cdx.json");
  const sbom = JSON.parse(readFileSync(path, "utf8"));
  const bomRef = `pkg:generic/keiko-runtime-attestation@${manifest.product.packageVersion}?platform=windows-x64`;
  const components = Array.isArray(sbom.components) ? sbom.components : [];
  sbom.components = [
    ...components.filter((component) => component?.["bom-ref"] !== bomRef),
    {
      type: "application",
      "bom-ref": bomRef,
      name: "keiko-runtime-attestation",
      version: manifest.product.packageVersion,
      licenses: [{ license: { id: "Apache-2.0" } }],
      hashes: [{ alg: "SHA-256", content: attestation.shippedSha256 }],
      properties: [
        { name: "keiko:platform-target", value: "windows-x64" },
        { name: "keiko:executable-path", value: attestation.executablePath },
      ],
    },
  ];
  writeFileSync(path, `${JSON.stringify(sbom, null, 2)}\n`);
}

function generationStagingRoot(stageRoot) {
  return join(
    stageRoot,
    "payload",
    "Keiko",
    ...WINDOWS_GENERATION_STAGING_RELATIVE_PATH.split("/"),
  );
}

function generationRoot(stageRoot, generationId) {
  return join(stageRoot, "payload", "Keiko", ".portable", "generations", generationId);
}

function assertQualifiedActivationUnchanged(stageRoot, manifest) {
  const path = join(
    portableResourceRoot(stageRoot, WINDOWS_TARGET, manifest),
    ...manifest.runtimeActivation.path.split("/"),
  );
  if (sha256(readFileSync(path)) !== manifest.runtimeActivation.sha256) {
    fail("qualified runtime activation changed before generation closure");
  }
}

function assertGenerationId(value) {
  if (!SHA256_PATTERN.test(value)) fail("Windows generation ID is invalid");
  return value;
}

function writeExclusive(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function assertDirectoryEntry(path, label) {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`${label} is invalid`);
}

function assertRegularSingleLink(path, label) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) fail(`${label} is invalid`);
}

function assertWindowsGenerationLayout(stageRoot, generationId) {
  const payloadRoot = join(resolve(stageRoot), "payload", "Keiko");
  const payloadEntries = readdirSync(payloadRoot).sort((left, right) =>
    left.localeCompare(right, "en-US"),
  );
  const allowedPayloadEntries = new Set([".portable", "Keiko.exe", "support"]);
  if (
    !payloadEntries.includes(".portable") ||
    !payloadEntries.includes("Keiko.exe") ||
    payloadEntries.some((name) => !allowedPayloadEntries.has(name))
  ) {
    fail("complete Windows payload contains an unexpected flat-layout entry");
  }
  assertRegularSingleLink(join(payloadRoot, "Keiko.exe"), "primary Keiko.exe");
  const portableRoot = join(payloadRoot, ".portable");
  assertDirectoryEntry(portableRoot, "Windows portable metadata root");
  const portableEntries = readdirSync(portableRoot).sort((left, right) =>
    left.localeCompare(right, "en-US"),
  );
  const allowedPortableEntries = new Set(["generations", "setup-manifest.json"]);
  if (
    !portableEntries.includes("generations") ||
    portableEntries.some((name) => !allowedPortableEntries.has(name))
  ) {
    fail("complete Windows portable metadata contains an unexpected entry");
  }
  const generationsRoot = join(portableRoot, "generations");
  assertDirectoryEntry(generationsRoot, "Windows generations root");
  if (readdirSync(generationsRoot).join("\0") !== generationId) {
    fail("complete Windows payload must contain exactly its bound generation");
  }
  assertDirectoryEntry(generationRoot(stageRoot, generationId), "bound Windows generation");
  if (portableEntries.includes("setup-manifest.json")) {
    assertRegularSingleLink(join(portableRoot, "setup-manifest.json"), "Windows setup manifest");
  }
  if (payloadEntries.includes("support")) {
    const supportRoot = join(payloadRoot, "support");
    assertDirectoryEntry(supportRoot, "Windows support launcher root");
    if (readdirSync(supportRoot).join("\0") !== "keiko-support.cmd") {
      fail("Windows support launcher root contains an unexpected entry");
    }
    assertRegularSingleLink(join(supportRoot, "keiko-support.cmd"), "Windows support launcher");
  }
}

export async function closeWindowsGenerationDirectory(
  stageRoot,
  { hashTree = hashPortableHandoffTree } = {},
) {
  const stagingRoot = generationStagingRoot(stageRoot);
  const hashOptions = { deadline: Date.now() + GENERATION_HASH_TIMEOUT_MS };
  const generationId = await hashTree(stagingRoot, hashOptions);
  assertGenerationId(generationId);
  const destination = generationRoot(stageRoot, generationId);
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) fail("Windows generation destination already exists");
  renameSync(stagingRoot, destination);
  if ((await hashTree(destination, hashOptions)) !== generationId) {
    fail("Windows generation changed after relocation");
  }
  return generationId;
}

export function inventoryWindowsPortableCompletePeFiles(stageRoot, generationId) {
  const payloadRoot = join(resolve(stageRoot), "payload", "Keiko");
  assertWindowsGenerationLayout(stageRoot, assertGenerationId(generationId));
  const inventory = inventoryPeFiles(payloadRoot);
  const prefix = `.portable/generations/${generationId}/`;
  const paths = inventory.files.map((file) => file.relativePath);
  if (!paths.includes("Keiko.exe")) fail("primary Keiko.exe is missing from the PE inventory");
  if (paths.some((path) => path !== "Keiko.exe" && !path.startsWith(prefix))) {
    fail("complete Windows PE inventory escapes the generation and root launcher");
  }
  return inventory;
}

export function completeInventoryMatchesGeneration(expected, actual, generationId, launcherSha256) {
  const prefix = `.portable/generations/${generationId}/`;
  if (actual.files.length !== expected.files.length + 1 || !SHA256_PATTERN.test(launcherSha256)) {
    return false;
  }
  const actualByPath = new Map(actual.files.map((file) => [file.relativePath, file.sha256]));
  return (
    actualByPath.get("Keiko.exe") === launcherSha256 &&
    expected.files.every(
      (file) => actualByPath.get(`${prefix}${file.relativePath}`) === file.sha256,
    )
  );
}

async function closeGenerationCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  verifyInventoryCommand(options);
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const verificationInputPath = resolve(required(options, "verification-input"));
  const input = assertWindowsProductionVerificationInput(verificationInputPath, manifest);
  const expected = authenticatedVerificationInventory(options, input);
  applyWindowsProductionState(manifest, input);
  markNativeHelpersVerified(manifest);
  bindRuntimeAttestation(stageRoot, manifest);
  assertQualifiedActivationUnchanged(stageRoot, manifest);
  if (
    !inventoriesMatch(
      expected,
      inventoryWindowsPortableCorePeFiles(generationStagingRoot(stageRoot)),
    )
  ) {
    fail("generation PE inventory changed during final binding");
  }
  const generationId = await closeWindowsGenerationDirectory(stageRoot);
  buildWindowsGenerationLauncher(join(stageRoot, "payload", "Keiko", "Keiko.exe"), generationId);
  writeExclusive(resolve(required(options, "launcher-catalog")), "payload/Keiko/Keiko.exe\n");
  writeExclusive(resolve(required(options, "generation-output")), `${generationId}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`windows-portable-signing: closed generation ${generationId}`);
}

function completeInventoryCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  const generationId = assertGenerationId(required(options, "generation-id"));
  const expected = readWindowsPortablePeInventory(required(options, "expected-inventory"));
  const actual = inventoryWindowsPortableCompletePeFiles(stageRoot, generationId);
  const manifest = JSON.parse(
    readFileSync(join(stageRoot, "manifest", "portable-manifest.json"), "utf8"),
  );
  const launcherSha256 =
    manifest.windowsGeneration?.launcherSha256 ?? required(options, "launcher-sha256");
  if (!completeInventoryMatchesGeneration(expected, actual, generationId, launcherSha256)) {
    fail("complete Windows PE inventory does not match the closed generation");
  }
  writeFileSync(resolve(required(options, "inventory")), `${JSON.stringify(actual, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function verifyClosedWindowsGeneration(stageRootValue, manifest) {
  const stageRoot = resolve(stageRootValue);
  const binding = manifest.windowsGeneration;
  const resourceRoot = portableResourceRoot(stageRoot, WINDOWS_TARGET, manifest);
  assertWindowsGenerationLayout(stageRoot, binding.treeSha256);
  const digest = await hashPortableHandoffTree(resourceRoot, {
    deadline: Date.now() + GENERATION_HASH_TIMEOUT_MS,
  });
  if (digest !== binding.treeSha256) fail("closed Windows generation digest mismatch");
  const launcherPath = join(stageRoot, "payload", "Keiko", binding.launcherPath);
  assertRegularSingleLink(launcherPath, "primary Keiko.exe");
  if (sha256(readFileSync(launcherPath)) !== binding.launcherSha256) {
    fail("root Windows launcher digest does not match the generation binding");
  }
  const setupManifestPath = join(stageRoot, "payload", "Keiko", ".portable", "setup-manifest.json");
  assertRegularSingleLink(setupManifestPath, "Windows setup manifest");
  let setupManifest;
  try {
    setupManifest = JSON.parse(readFileSync(setupManifestPath, "utf8"));
    validateWindowsRootSetupManifest(setupManifest, manifest);
  } catch {
    fail("root Windows setup manifest does not match the generation binding");
  }
}

async function verifyGenerationCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  const manifest = JSON.parse(
    readFileSync(join(stageRoot, "manifest", "portable-manifest.json"), "utf8"),
  );
  await verifyClosedWindowsGeneration(stageRoot, manifest);
}

async function assertClosedGeneration(stageRoot, generationId) {
  const root = generationRoot(stageRoot, generationId);
  if (!existsSync(root) || existsSync(generationStagingRoot(stageRoot))) {
    fail("closed Windows generation layout is invalid");
  }
  const digest = await hashPortableHandoffTree(root, {
    deadline: Date.now() + GENERATION_HASH_TIMEOUT_MS,
  });
  if (digest !== generationId) fail("closed Windows generation digest mismatch");
  return root;
}

function windowsGenerationBinding(generationId, launcherSha256) {
  return {
    schemaVersion: 1,
    resourceRoot: `.portable/generations/${generationId}`,
    treeHashSchema: PORTABLE_HANDOFF_TREE_HASH_SCHEMA,
    treeSha256: generationId,
    launcherPath: "Keiko.exe",
    launcherSha256,
  };
}

function bindWindowsGenerationManifest(stageRoot, manifest, generationId, inventory) {
  const launcher = inventory.files.find((file) => file.relativePath === "Keiko.exe");
  if (launcher === undefined) fail("signed root launcher is missing");
  manifest.schemaVersion = WINDOWS_PORTABLE_MANIFEST_SCHEMA_VERSION;
  manifest.windowsGeneration = windowsGenerationBinding(generationId, launcher.sha256);
  manifest.provenance.windowsGeneration = globalThis.structuredClone(manifest.windowsGeneration);
  manifest.releaseImpact.reviewedBinding.windowsGeneration = globalThis.structuredClone(
    manifest.windowsGeneration,
  );
  stageWindowsPortableRootFiles(join(stageRoot, "payload", "Keiko"), manifest.windowsGeneration);
}

async function archiveClosedWindowsStage(stageRoot, manifest) {
  const archivePath = join(stageRoot, manifest.artifact.assetName);
  rmSync(archivePath, { force: true });
  windowsZipAdapter().create(join(stageRoot, "payload"), "Keiko", archivePath);
  await rebindExistingSignedArchive(stageRoot, manifest, archivePath, WINDOWS_TARGET, {
    payloadAlreadyRebound: true,
  });
}

function assertFinalWindowsManifest(manifest) {
  const failures = validatePortableCandidateManifest(manifest);
  if (
    failures.length > 0 ||
    manifest.schemaVersion !== WINDOWS_PORTABLE_MANIFEST_SCHEMA_VERSION ||
    manifest.security.verificationStatus !== "verified-production" ||
    manifest.updateEligibility.requiredPredicates.platformSignatureLocallyVerified !== true
  ) {
    fail("production manifest did not reach the verified state");
  }
}

async function finalizeCommand(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.artifact?.platformTarget !== WINDOWS_TARGET)
    fail("manifest target is not Windows x64");
  const verificationInputPath = resolve(required(options, "verification-input"));
  const input = assertWindowsProductionVerificationInput(verificationInputPath, manifest);
  const expected = authenticatedVerificationInventory(options, input);
  const generationId = assertGenerationId(required(options, "generation-id"));
  await assertClosedGeneration(stageRoot, generationId);
  const actual = inventoryWindowsPortableCompletePeFiles(stageRoot, generationId);
  if (!inventoriesMatch(expected, actual)) fail("verified PE inventory no longer matches payload");
  applyWindowsProductionState(manifest, input);
  markNativeHelpersVerified(manifest);
  bindWindowsGenerationManifest(stageRoot, manifest, generationId, actual);
  await assertClosedGeneration(stageRoot, generationId);
  await archiveClosedWindowsStage(stageRoot, manifest);
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
  assertFinalWindowsManifest(finalManifest);
  console.log("windows-portable-signing: verified production archive finalized");
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  const syncCommands = new Map([
    ["validate-config", () => validateAzureArtifactSigningConfig(process.env)],
    ["inventory", inventoryCommand],
    ["verify-inventory", verifyInventoryCommand],
    ["compare-paths", comparePathsCommand],
    ["compare-with-attestation", compareWithAttestationCommand],
    ["inventory-complete", completeInventoryCommand],
    ["verify-setup-scope", verifySetupScopeCommand],
    ["prepare-qualified-payload", prepareQualifiedPayloadCommand],
  ]);
  const syncCommand = syncCommands.get(command);
  if (syncCommand !== undefined) return syncCommand(options);
  if (command === "close-generation") return closeGenerationCommand(options);
  if (command === "verify-generation") return verifyGenerationCommand(options);
  if (command === "finalize") return finalizeCommand(options);
  fail(
    "command must be validate-config, inventory, compare-paths, compare-with-attestation, close-generation, inventory-complete, verify-generation, verify-inventory, verify-setup-scope, prepare-qualified-payload, or finalize",
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
