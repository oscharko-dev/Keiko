#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { hashDirectoryTree, isSafePortableRelativePath } from "./portable-runtime.mjs";
import {
  RUNTIME_ACTIVATION_RELATIVE_PATH,
  RUNTIME_QUALIFICATION_SUITE,
} from "./runtime-activation-manifest.mjs";
import {
  inventoriesMatch,
  inventoryWindowsPortablePeFiles,
  readWindowsPortablePeInventory,
} from "./windows-portable-signing.mjs";
import { assertWindowsProductionVerificationInput } from "./windows-portable-verification-input.mjs";
import { sha256File } from "./lib/digest.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const WINDOWS_TARGET = "windows-x64";

export class WindowsRuntimeQualificationError extends Error {}

function fail(message) {
  throw new WindowsRuntimeQualificationError(`windows-runtime-qualification: ${message}`);
}

function readJson(path, label) {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 262_144) {
      fail(`${label} is invalid`);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof WindowsRuntimeQualificationError) throw error;
    fail(`${label} is invalid`);
  }
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function helperByName(activation, name) {
  const matches = Array.isArray(activation.nativeHelpers)
    ? activation.nativeHelpers.filter((helper) => helper?.name === name)
    : [];
  if (matches.length !== 1) fail("activation helper set is invalid");
  const helper = matches[0];
  const expectedPath = `runtime/native/${name}.exe`;
  if (
    helper?.platformTarget !== WINDOWS_TARGET ||
    helper.executablePath !== expectedPath ||
    !Number.isSafeInteger(helper.sizeBytes) ||
    helper.sizeBytes <= 0 ||
    !SHA256.test(helper.shippedSha256)
  ) {
    fail("activation helper set is invalid");
  }
  return helper;
}

function validateActivation(activation, sourceCommitSha) {
  if (
    !activationIdentityIsValid(activation, sourceCommitSha) ||
    !activationRuntimeIsValid(activation)
  ) {
    fail("activation manifest is invalid");
  }
  helperByName(activation, "keiko-runtime-supervisor");
  helperByName(activation, "keiko-secure-workspace-read");
  if (!activationSidecarIsValid(activation)) fail("activation OpenCode binding is invalid");
}

function activationIdentityIsValid(activation, sourceCommitSha) {
  return (
    exactKeys(activation, [
      "schemaVersion",
      "suiteVersion",
      "product",
      "sourceCommitSha",
      "platformTarget",
      "artifact",
      "runtime",
      "security",
      "nativeHelpers",
      "sidecarRuntimes",
      "releaseImpact",
    ]) &&
    activation.schemaVersion === 1 &&
    activation.suiteVersion === RUNTIME_QUALIFICATION_SUITE &&
    activation.platformTarget === WINDOWS_TARGET &&
    activation.sourceCommitSha === sourceCommitSha &&
    COMMIT.test(activation.sourceCommitSha)
  );
}

function activationRuntimeIsValid(activation) {
  return (
    activation.artifact?.platformTarget === WINDOWS_TARGET &&
    activation.runtime?.nodePlatform === "win32" &&
    activation.runtime?.nodeArchitecture === "x64" &&
    activation.security?.verificationStatus === "verified-production"
  );
}

function activationSidecarIsValid(activation) {
  const sidecar = activation.sidecarRuntimes?.[0];
  return (
    Array.isArray(activation.sidecarRuntimes) &&
    activation.sidecarRuntimes.length === 1 &&
    sidecar?.name === "opencode-compatible" &&
    sidecar.platformTarget === WINDOWS_TARGET &&
    isSafePortableRelativePath(sidecar.payloadRootPath) &&
    SHA256.test(sidecar.payloadSha256)
  );
}

function authenticatedInventoryEntry(inventory, relativePath) {
  const matches = inventory.files.filter((entry) => entry.relativePath === relativePath);
  if (matches.length !== 1) fail("authenticated PE inventory binding is incomplete");
  return matches[0];
}

function componentDigest(resourceRoot, helper, inventory) {
  const path = join(resourceRoot, ...helper.executablePath.split("/"));
  const entry = lstatSync(path);
  const inventoryEntry = authenticatedInventoryEntry(inventory, helper.executablePath);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.size !== helper.sizeBytes ||
    sha256File(path) !== helper.shippedSha256 ||
    inventoryEntry.sha256 !== helper.shippedSha256
  ) {
    fail("activation helper bytes are invalid");
  }
  return helper.shippedSha256;
}

function authenticatedQualificationInputs(input, activation) {
  const expectedInventory = readWindowsPortablePeInventory(input.expectedInventoryPath);
  const actualInventory = inventoryWindowsPortablePeFiles(input.resourceRoot);
  const verification = assertWindowsProductionVerificationInput(
    input.verificationInputPath,
    activation,
  );
  if (
    !inventoriesMatch(expectedInventory, actualInventory) ||
    sha256File(input.expectedInventoryPath) !== verification.peInventorySha256
  ) {
    fail("authenticated PE inventory no longer matches the qualified payload");
  }
  const sidecar = activation.sidecarRuntimes[0];
  const sidecarVerification = verification.sidecarRuntimes.find(
    (entry) => entry.name === sidecar.name,
  );
  const sidecarDigest = hashDirectoryTree(
    join(input.resourceRoot, ...sidecar.payloadRootPath.split("/")),
  );
  if (
    sidecarVerification === undefined ||
    sidecarVerification.payloadSha256 !== sidecarDigest ||
    sidecar.payloadSha256 !== sidecarDigest
  ) {
    fail("authenticated OpenCode payload binding is invalid");
  }
  return { expectedInventory, sidecarDigest };
}

export function qualificationReceiptFor(input) {
  const activation = readJson(input.activationPath, "activation manifest");
  validateActivation(activation, input.sourceCommitSha);
  const authenticated = authenticatedQualificationInputs(input, activation);
  const supervisor = helperByName(activation, "keiko-runtime-supervisor");
  const secureRead = helperByName(activation, "keiko-secure-workspace-read");
  return {
    schemaVersion: 1,
    suiteVersion: RUNTIME_QUALIFICATION_SUITE,
    platformTarget: WINDOWS_TARGET,
    sourceCommitSha: input.sourceCommitSha,
    activationManifestSha256: sha256File(input.activationPath),
    supervisorSha256: componentDigest(
      input.resourceRoot,
      supervisor,
      authenticated.expectedInventory,
    ),
    secureReadSha256: componentDigest(
      input.resourceRoot,
      secureRead,
      authenticated.expectedInventory,
    ),
    sidecars: activation.sidecarRuntimes.map((sidecar) => ({
      name: sidecar.name,
      sha256: authenticated.sidecarDigest,
    })),
    backend: "windows-job-object",
    result: "passed",
  };
}

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("invalid arguments");
    options[key.slice(2)] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) fail(`--${name} is required`);
  return value;
}

// #3390 audit F8: mirrors qualify-macos-runtime-release.mjs's evidence bridge -- translates this
// script's own real qualification receipt into the `<scenarioId>.receipt.json` + `.artifact` pair
// the #3390 checker and manifest producer already read, so a real, passing Windows qualification
// becomes evidence with no separate step. While #2198/#2951 remain open this mode is never invoked
// for the packaged-reference scenario; its manifest row carries the descriptor's own closed
// `blocked` reason instead -- never a fabricated receipt.
export function writeQualificationEvidenceReceipt({
  receiptsDir,
  scenarioId,
  receipt,
  recordedAt,
  provenance = "real-model",
}) {
  writeFileSync(
    join(receiptsDir, `${scenarioId}.artifact`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(receiptsDir, `${scenarioId}.receipt.json`),
    `${JSON.stringify(
      {
        scenarioId,
        commitSha: receipt.sourceCommitSha,
        platform: receipt.platformTarget,
        testStatus: receipt.result === "passed" ? "passed" : "failed",
        recordedAt,
        provenance,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function maybeWriteQualificationEvidence(options, receipt) {
  const receiptsDir = options["qualification-receipts"];
  if (receiptsDir === undefined) return;
  writeQualificationEvidenceReceipt({
    receiptsDir: resolve(receiptsDir),
    scenarioId: required(options, "scenario-id"),
    receipt,
    recordedAt: new Date().toISOString(),
  });
}

export function qualifyWindowsRuntimeRelease(
  options,
  { platform = process.platform, spawnSyncImpl = spawnSync } = {},
) {
  if (platform !== "win32") fail("qualification requires Windows");
  const stageRoot = resolve(required(options, "stage-root"));
  const sourceCommitSha = required(options, "source-commit-sha");
  if (!COMMIT.test(sourceCommitSha)) fail("source commit is invalid");
  const resourceRoot = join(stageRoot, "payload", "Keiko");
  const helper = join(resourceRoot, "runtime", "native", "keiko-runtime-supervisor.exe");
  const result = spawnSyncImpl(
    process.execPath,
    ["native/runtime-supervisor/test-protocol.mjs", "--helper", helper],
    {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot ?? String.raw`C:\Windows` },
      timeout: 60_000,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    fail("exact shipped supervisor did not pass qualification");
  }
  const activationPath = join(resourceRoot, ...RUNTIME_ACTIVATION_RELATIVE_PATH.split("/"));
  const receipt = qualificationReceiptFor({
    activationPath,
    expectedInventoryPath: resolve(required(options, "expected-inventory")),
    resourceRoot,
    sourceCommitSha,
    verificationInputPath: resolve(required(options, "verification-input")),
  });
  const output = resolve(required(options, "output"));
  if (dirname(output) === output) fail("output path is invalid");
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  maybeWriteQualificationEvidence(options, receipt);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    qualifyWindowsRuntimeRelease(parse(process.argv.slice(2)));
  } catch (error) {
    console.error(
      error instanceof WindowsRuntimeQualificationError
        ? error.message
        : "windows-runtime-qualification: redacted failure",
    );
    process.exit(1);
  }
}
