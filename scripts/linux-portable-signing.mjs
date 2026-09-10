#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { verifyLinuxQualificationBundle } from "../packages/keiko-server/src/coding-runtime/linuxPortableSigstore.ts";
import { discoverQualifiedPortableOpenCode } from "../packages/keiko-server/src/coding-runtime/productionPortableCodingRuntime.ts";
import { readZipArchiveEntryNames, writeZipArchiveFromDirectory } from "./lib/zip-archive.mjs";
import { qualificationReceiptFor } from "./qualify-linux-runtime-release.mjs";
import {
  portableVerificationSummaryForManifest,
  validatePortableCandidateManifest,
} from "./portable-runtime.mjs";
import { rebindExistingSignedArchive, rebindSignedPayload } from "./portable-signed-archive.mjs";

const TARGET = "linux-x64";
const RECEIPT_PATH = ".portable/runtime-qualification.json";
const BUNDLE_PATH = ".portable/runtime-qualification.sigstore.json";
const MAX_METADATA_BYTES = 262_144;

export class LinuxPortableSigningError extends Error {}

function fail(message) {
  throw new LinuxPortableSigningError(`linux-portable-signing: ${message}`);
}

/** @internal Exported only for deterministic CLI-boundary tests. */
export function parseLinuxPortableSigningArgs(argv) {
  const [command, ...args] = argv;
  if (command !== "prepare" && command !== "finalize" && command !== "verify") {
    fail("unsupported command");
  }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("invalid arguments");
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) fail(`--${name} is required`);
  return value;
}

function stageFiles(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  const manifestPath = join(stageRoot, "manifest", "portable-manifest.json");
  const manifest = readBoundedJson(manifestPath, "manifest");
  if (manifest.artifact?.platformTarget !== TARGET) fail("manifest target is not Linux x64");
  return {
    stageRoot,
    manifestPath,
    manifest,
    resourceRoot: join(stageRoot, "payload", "Keiko"),
  };
}

function readBoundedJson(path, label) {
  try {
    const entry = lstatSync(path);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1 ||
      entry.size <= 0 ||
      entry.size > MAX_METADATA_BYTES
    ) {
      fail(`${label} is invalid`);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof LinuxPortableSigningError) throw error;
    return fail(`${label} is invalid`);
  }
}

function productionState() {
  return {
    verificationPolicy: "production",
    verificationStatus: "verified-production",
    verificationReasonCodes: [],
    signatureKind: "github-oidc-attested",
    signatureVerified: true,
    notarizationRequired: false,
    notarizationVerified: false,
    verificationChecks: { provenanceVerified: true },
  };
}

function helperProductionState() {
  const state = productionState();
  return {
    signatureKind: state.signatureKind,
    verificationStatus: state.verificationStatus,
    signatureVerified: state.signatureVerified,
    notarizationRequired: false,
    notarizationVerified: false,
  };
}

function assertProductionComponentSet(manifest) {
  if (
    !Array.isArray(manifest.sidecarRuntimes) ||
    manifest.sidecarRuntimes.length !== 1 ||
    !Array.isArray(manifest.nativeHelpers) ||
    manifest.nativeHelpers.length !== 2 ||
    !Array.isArray(manifest.nativeAddons) ||
    manifest.nativeAddons.length !== 1
  ) {
    fail("manifest production component set is invalid");
  }
}

function markProduction(manifest) {
  assertProductionComponentSet(manifest);
  const state = productionState();
  manifest.security = { ...manifest.security, ...state };
  manifest.sidecarRuntimes = manifest.sidecarRuntimes.map((sidecar) => ({
    ...sidecar,
    signing: { ...sidecar.signing, ...state },
  }));
  const helperState = helperProductionState();
  for (const helper of manifest.nativeHelpers) helper.signing = { ...helperState };
  for (const addon of manifest.nativeAddons) addon.signing = { ...helperState };
  manifest.releaseImpact.reviewedBinding = {
    ...manifest.releaseImpact.reviewedBinding,
    ...state,
    platformSignatureLocallyVerified: true,
  };
  manifest.updateEligibility.requiredPredicates.platformSignatureLocallyVerified = true;
}

function syncReviewedPayloads(manifest) {
  const binding = manifest.releaseImpact.reviewedBinding;
  binding.sidecarRuntimes = structuredClone(manifest.sidecarRuntimes);
  binding.nativeHelpers = structuredClone(manifest.nativeHelpers);
  binding.nativeAddons = structuredClone(manifest.nativeAddons);
}

export function prepareLinuxQualifiedPayload(options, dependencies = {}) {
  const files = stageFiles(options);
  markProduction(files.manifest);
  (dependencies.rebindSignedPayload ?? rebindSignedPayload)(
    files.stageRoot,
    files.manifest,
    TARGET,
  );
  files.manifest.runtimeActivation.trustAnchor = "sigstore-qualification-receipt";
  syncReviewedPayloads(files.manifest);
  writeFileSync(files.manifestPath, `${JSON.stringify(files.manifest, null, 2)}\n`);
}

function boundQualification(files, sourceCommitSha, dependencies) {
  const receiptPath = join(files.resourceRoot, ...RECEIPT_PATH.split("/"));
  const bundlePath = join(files.resourceRoot, ...BUNDLE_PATH.split("/"));
  const receiptBytes = readBoundedBytes(receiptPath, "qualification receipt");
  const bundle = readBoundedJson(bundlePath, "qualification bundle");
  (dependencies.verifyQualificationBundle ?? verifyLinuxQualificationBundle)(receiptBytes, bundle);
  const actual = JSON.parse(receiptBytes.toString("utf8"));
  const expected = (dependencies.qualificationReceiptFor ?? qualificationReceiptFor)({
    activationPath: join(files.resourceRoot, ".portable", "runtime-activation.json"),
    resourceRoot: files.resourceRoot,
    sourceCommitSha,
  });
  if (!isDeepStrictEqual(actual, expected)) fail("qualification receipt binding is invalid");
  return { receiptPath, receipt: expected };
}

function readBoundedBytes(path, label) {
  const entry = lstatSync(path);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.size <= 0 ||
    entry.size > MAX_METADATA_BYTES
  ) {
    fail(`${label} is invalid`);
  }
  return readFileSync(path);
}

function bindQualification(manifest, receiptPath) {
  manifest.runtimeQualification = {
    schemaVersion: 1,
    path: RECEIPT_PATH,
    sha256: sha256File(receiptPath),
    backend: "linux-namespace-gateway",
  };
  manifest.releaseImpact.reviewedBinding.runtimeQualification = structuredClone(
    manifest.runtimeQualification,
  );
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function rebuildArchive(files) {
  const archivePath = join(files.stageRoot, files.manifest.artifact.assetName);
  const resourceRoot = join(files.stageRoot, "payload", "Keiko");
  rmSync(archivePath, { force: true });
  writeZipArchiveFromDirectory(resourceRoot, archivePath, {
    containmentRoot: resourceRoot,
    followSymlinks: true,
    rootName: "Keiko",
  });
  if (!existsSync(archivePath) || statSync(archivePath).size <= 0) fail("Linux archive is missing");
  return archivePath;
}

function writeVerificationSummary(files) {
  writeFileSync(
    join(files.stageRoot, "evidence", "signing-verification.json"),
    `${JSON.stringify(portableVerificationSummaryForManifest(files.manifest), null, 2)}\n`,
  );
}

function assertArchive(files) {
  const archivePath = join(files.stageRoot, files.manifest.artifact.assetName);
  const entry = lstatSync(archivePath);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.size !== files.manifest.artifact.sizeBytes ||
    sha256File(archivePath) !== files.manifest.artifact.sha256
  ) {
    fail("production archive binding is invalid");
  }
  const entries = new Set(readZipArchiveEntryNames(archivePath));
  for (const path of [RECEIPT_PATH, BUNDLE_PATH, ".portable/setup-manifest.json"]) {
    if (!entries.has(`Keiko/${path}`)) fail("production archive evidence is incomplete");
  }
}

function assertProductionDiscovery(files, discover = discoverQualifiedPortableOpenCode) {
  const runtime = discover({
    env: {},
    platform: "linux",
    arch: "x64",
    installRoot: files.resourceRoot,
  });
  if (
    runtime?.target !== TARGET ||
    runtime.platformAssurance !== "release-qualified" ||
    runtime.qualification.backend !== "linux-namespace-gateway"
  ) {
    fail("production runtime discovery is unavailable");
  }
}

export function verifyLinuxQualifiedPayload(options, dependencies = {}) {
  const files = stageFiles(options);
  const sourceCommitSha = required(options, "source-commit-sha");
  const qualification = boundQualification(files, sourceCommitSha, dependencies);
  if (
    files.manifest.runtimeQualification?.path !== RECEIPT_PATH ||
    files.manifest.runtimeQualification?.sha256 !== sha256File(qualification.receiptPath) ||
    files.manifest.runtimeQualification?.backend !== "linux-namespace-gateway"
  ) {
    fail("qualification manifest binding is invalid");
  }
  const failures = (dependencies.validateManifest ?? validatePortableCandidateManifest)(
    files.manifest,
  );
  if (failures.length > 0) fail(`production manifest is invalid: ${failures.join("; ")}`);
  assertArchive(files);
  assertProductionDiscovery(files, dependencies.discoverQualifiedRuntime);
  return files;
}

export async function finalizeLinuxQualifiedPayload(options, dependencies = {}) {
  const files = stageFiles(options);
  const sourceCommitSha = required(options, "source-commit-sha");
  const qualification = boundQualification(files, sourceCommitSha, dependencies);
  bindQualification(files.manifest, qualification.receiptPath);
  const archivePath = rebuildArchive(files);
  await (dependencies.rebindExistingSignedArchive ?? rebindExistingSignedArchive)(
    files.stageRoot,
    files.manifest,
    archivePath,
    TARGET,
    { payloadAlreadyRebound: true },
  );
  writeVerificationSummary(files);
  writeFileSync(files.manifestPath, `${JSON.stringify(files.manifest, null, 2)}\n`);
  verifyLinuxQualifiedPayload(options, dependencies);
  process.stdout.write(
    `Linux portable signing: PASS ${basename(archivePath)} ${qualification.receipt.result}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const input = parseLinuxPortableSigningArgs(process.argv.slice(2));
    if (input.command === "prepare") prepareLinuxQualifiedPayload(input.options);
    else if (input.command === "finalize") await finalizeLinuxQualifiedPayload(input.options);
    else {
      verifyLinuxQualifiedPayload(input.options);
      process.stdout.write("Linux portable qualification verification: PASS\n");
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof LinuxPortableSigningError ? error.message : "linux-portable-signing: redacted failure"}\n`,
    );
    process.exitCode = 1;
  }
}
