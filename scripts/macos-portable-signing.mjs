#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  boundedMacSigningFail as fail,
  BoundedMacSigningError,
  hasUnsafeText,
  inventoryMacPortableCode,
  macPortableInventoriesMatch as inventoriesMatch,
  readMacPortableInventory as readInventory,
} from "./macos-portable-inventory.mjs";
import { portableTargetByName } from "./portable-runtime.mjs";
import {
  PortableVerificationInputError,
  readPortableVerificationInput,
} from "./portable-verification-input.mjs";
import { rebindExistingSignedArchive, rebindSignedPayload } from "./portable-signed-archive.mjs";

const TEAM_PATTERN = /^[A-Z0-9]{10}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

export { inventoryMacPortableCode } from "./macos-portable-inventory.mjs";

export function validateAppleSigningConfig(env) {
  const names = [
    "APPLE_DEVELOPER_ID_IDENTITY",
    "APPLE_TEAM_ID",
    "APPLE_NOTARY_KEY_ID",
    "APPLE_NOTARY_ISSUER_ID",
    "APPLE_DEVELOPER_ID_CERT_P12_BASE64",
    "APPLE_DEVELOPER_ID_CERT_PASSWORD",
    "APPLE_NOTARY_KEY_P8_BASE64",
  ];
  if (names.some((name) => typeof env[name] !== "string" || env[name].trim().length === 0))
    fail("protected Apple configuration is incomplete");
  validateCredentialText(env);
  if (!TEAM_PATTERN.test(env.APPLE_TEAM_ID) || !UUID_PATTERN.test(env.APPLE_NOTARY_ISSUER_ID))
    fail("protected Apple identifier is invalid");
  if (!/^[A-Z0-9]{10}$/u.test(env.APPLE_NOTARY_KEY_ID))
    fail("protected Apple key identifier is invalid");
  if (
    !env.APPLE_DEVELOPER_ID_IDENTITY.startsWith("Developer ID Application: ") ||
    !env.APPLE_DEVELOPER_ID_IDENTITY.endsWith(`(${env.APPLE_TEAM_ID})`)
  ) {
    fail("Developer ID identity alias does not match the configured team");
  }
  validateBase64Reference(env.APPLE_DEVELOPER_ID_CERT_P12_BASE64, 256, 2 * 1024 * 1024, false);
  validateBase64Reference(env.APPLE_NOTARY_KEY_P8_BASE64, 64, 64 * 1024, true);
}

function validateCredentialText(env) {
  const invalidIdentity =
    env.APPLE_DEVELOPER_ID_IDENTITY.length > 256 || hasUnsafeText(env.APPLE_DEVELOPER_ID_IDENTITY);
  const invalidPassword =
    env.APPLE_DEVELOPER_ID_CERT_PASSWORD.length > 1024 ||
    hasUnsafeText(env.APPLE_DEVELOPER_ID_CERT_PASSWORD);
  if (invalidIdentity || invalidPassword) fail("protected Apple configuration is invalid");
}

function validateBase64Reference(value, minimum, maximum, requirePem) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    fail("protected Apple credential encoding is invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < minimum || decoded.length > maximum) {
    fail("protected Apple credential size is invalid");
  }
  if (requirePem && !decoded.toString("utf8").startsWith("-----BEGIN PRIVATE KEY-----")) {
    fail("protected Apple notary key encoding is invalid");
  }
  if (!requirePem && decoded[0] !== 0x30) fail("protected Apple certificate encoding is invalid");
}

function checksVerified(checks) {
  return (
    checks?.developerIdVerified === true &&
    checks?.notarizationVerified === true &&
    checks?.stapleVerified === true &&
    checks?.assessmentVerified === true
  );
}

function assertProductionInput(path, manifest) {
  const target = portableTargetByName(manifest.artifact?.platformTarget);
  const sidecars = Array.isArray(manifest.sidecarRuntimes) ? manifest.sidecarRuntimes : [];
  let input;
  try {
    input = readPortableVerificationInput(path, target, "production", sidecars);
  } catch (error) {
    if (error instanceof PortableVerificationInputError) fail(error.message);
    throw error;
  }
  if (
    !checksVerified(input.verificationChecks) ||
    input.reasonCodes.length > 0 ||
    input.sidecarRuntimes.some(
      (entry) => !checksVerified(entry.verificationChecks) || entry.reasonCodes.length > 0,
    )
  ) {
    fail("native macOS verification did not succeed");
  }
}

export function assertAcceptedNotaryResult(path) {
  let result;
  try {
    if (statSync(path).size > 65_536) fail("notarization result was not accepted");
    result = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof BoundedMacSigningError) throw error;
    fail("notarization result was not accepted");
  }
  if (result?.status !== "Accepted") fail("notarization result was not accepted");
}

function parse(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined)
      fail("invalid command arguments");
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return { command, options };
}

function required(options, name) {
  if (typeof options[name] !== "string" || options[name].length === 0)
    fail(`--${name} is required`);
  return options[name];
}

function inventoryCommand(options) {
  const stage = resolve(required(options, "stage-root"));
  const inventory = inventoryMacPortableCode(
    join(stage, "payload", "Keiko"),
    required(options, "target"),
  );
  const manifest = JSON.parse(
    readFileSync(join(stage, "manifest", "portable-manifest.json"), "utf8"),
  );
  const paths = new Set(inventory.codeObjects.map((entry) => entry.relativePath));
  for (const sidecar of manifest.sidecarRuntimes ?? []) {
    const executable = `Keiko.app/Contents/Resources/${sidecar.executablePath}`;
    if (!paths.has(executable))
      fail("manifest sidecar executable is missing from the Mach-O inventory");
  }
  if (!Array.isArray(manifest.nativeHelpers) || manifest.nativeHelpers.length !== 2) {
    fail("manifest must contain the complete native helper set");
  }
  for (const helper of manifest.nativeHelpers) {
    const helperExecutable = `Keiko.app/Contents/Resources/${helper.executablePath}`;
    if (!paths.has(helperExecutable)) {
      fail("manifest native helper is missing from the Mach-O inventory");
    }
  }
  writeFileSync(
    resolve(required(options, "inventory")),
    `${JSON.stringify(inventory, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    `macos-portable-signing: inventoried ${String(inventory.codeObjects.length)} Mach-O files`,
  );
}

function inventoryRootCommand(options) {
  const inventory = inventoryMacPortableCode(
    resolve(required(options, "payload-root")),
    required(options, "target"),
  );
  writeFileSync(
    resolve(required(options, "inventory")),
    `${JSON.stringify(inventory, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

function compareCommand(options, includeHashes) {
  const expected = readInventory(required(options, "expected-inventory"));
  const actual = readInventory(required(options, "actual-inventory"));
  if (!inventoriesMatch(expected, actual, includeHashes))
    fail("macOS code inventory changed unexpectedly");
}

function rebindPayloadCommand(options) {
  const stage = resolve(required(options, "stage-root"));
  const target = required(options, "target");
  const manifestPath = join(stage, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.artifact?.platformTarget !== target) {
    fail("manifest target does not match signed payload");
  }
  rebindSignedPayload(stage, manifest, target);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function markMacosProductionState(manifest) {
  const state = {
    verificationPolicy: "production",
    verificationStatus: "verified-production",
    verificationReasonCodes: [],
    signatureKind: "developer-id-notarized",
    signatureVerified: true,
    notarizationRequired: true,
    notarizationVerified: true,
    verificationChecks: {
      developerIdVerified: true,
      notarizationVerified: true,
      stapleVerified: true,
      assessmentVerified: true,
    },
  };
  manifest.security = { ...manifest.security, ...state };
  manifest.sidecarRuntimes = (manifest.sidecarRuntimes ?? []).map((sidecar) => ({
    ...sidecar,
    signing: { ...sidecar.signing, ...state },
  }));
  manifest.releaseImpact.reviewedBinding = {
    ...manifest.releaseImpact.reviewedBinding,
    ...state,
    platformSignatureLocallyVerified: true,
    sidecarRuntimes: globalThis.structuredClone(manifest.sidecarRuntimes),
  };
  manifest.updateEligibility.requiredPredicates.platformSignatureLocallyVerified = true;
}

function prepareQualifiedPayloadCommand(options) {
  const stage = resolve(required(options, "stage-root"));
  const target = required(options, "target");
  const manifestPath = join(stage, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.artifact?.platformTarget !== target || !target.startsWith("macos-")) {
    fail("manifest target does not match the macOS payload");
  }
  markMacosProductionState(manifest);
  markNativeHelpersVerified(manifest);
  rebindSignedPayload(stage, manifest, target);
  manifest.runtimeActivation.trustAnchor = "developer-id-app-resource-seal";
  manifest.releaseImpact.reviewedBinding.nativeHelpers = globalThis.structuredClone(
    manifest.nativeHelpers,
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function markNativeHelpersVerified(manifest) {
  if (manifest.nativeHelpers?.length !== 2)
    fail("manifest must contain the complete native helper set");
  for (const helper of manifest.nativeHelpers) {
    helper.signing = {
      signatureKind: "developer-id-notarized",
      verificationStatus: "verified-production",
      signatureVerified: true,
      notarizationRequired: true,
      notarizationVerified: true,
    };
  }
  manifest.releaseImpact.reviewedBinding.nativeHelpers = globalThis.structuredClone(
    manifest.nativeHelpers,
  );
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function bindRuntimeQualification(stage, manifest) {
  const resourceRoot = join(stage, "payload", "Keiko", "Keiko.app", "Contents", "Resources");
  const path = join(resourceRoot, ".portable", "runtime-qualification.json");
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  const activationPath = join(resourceRoot, ".portable", "runtime-activation.json");
  const helpers = new Map(manifest.nativeHelpers.map((helper) => [helper.name, helper]));
  const sidecar = manifest.sidecarRuntimes?.[0];
  const expected = {
    schemaVersion: 1,
    suiteVersion: "runtime-tree-qualification-v1",
    platformTarget: manifest.artifact.platformTarget,
    sourceCommitSha: manifest.release.commitSha,
    activationManifestSha256: sha256(activationPath),
    supervisorSha256: helpers.get("keiko-runtime-supervisor")?.shippedSha256,
    secureReadSha256: helpers.get("keiko-secure-workspace-read")?.shippedSha256,
    sidecars: [{ name: "opencode-compatible", sha256: sidecar?.payloadSha256 }],
    backend: "macos-endpoint-security",
    result: "passed",
  };
  if (!isDeepStrictEqual(receipt, expected)) {
    fail("macOS runtime qualification receipt is stale or invalid");
  }
  manifest.runtimeQualification = {
    schemaVersion: 1,
    path: ".portable/runtime-qualification.json",
    sha256: sha256(path),
    backend: "macos-endpoint-security",
  };
  manifest.releaseImpact.reviewedBinding.runtimeQualification = globalThis.structuredClone(
    manifest.runtimeQualification,
  );
}

function validateRuntimeQualificationCommand(options) {
  const stage = resolve(required(options, "stage-root"));
  const target = required(options, "target");
  const manifest = JSON.parse(
    readFileSync(join(stage, "manifest", "portable-manifest.json"), "utf8"),
  );
  if (manifest.artifact?.platformTarget !== target || !target.startsWith("macos-")) {
    fail("manifest target does not match the macOS qualification");
  }
  bindRuntimeQualification(stage, globalThis.structuredClone(manifest));
}

async function finalize(options) {
  const stage = resolve(required(options, "stage-root"));
  const expected = readInventory(required(options, "expected-inventory"));
  const actual = inventoryMacPortableCode(join(stage, "payload", "Keiko"), expected.target);
  if (!inventoriesMatch(expected, actual, true))
    fail("verified macOS code bytes changed before finalization");
  const manifestPath = join(stage, "manifest", "portable-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.artifact?.platformTarget !== expected.target)
    fail("manifest target does not match the verified inventory");
  const inputPath = resolve(required(options, "verification-input"));
  assertProductionInput(inputPath, manifest);
  markMacosProductionState(manifest);
  markNativeHelpersVerified(manifest);
  bindRuntimeQualification(stage, manifest);
  manifest.runtimeActivation.trustAnchor = "developer-id-app-resource-seal";
  const archivePath = join(stage, manifest.artifact.assetName);
  if (!existsSync(archivePath)) fail("final ditto archive is missing");
  await rebindExistingSignedArchive(stage, manifest, archivePath, expected.target, {
    payloadAlreadyRebound: true,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    [
      "scripts/verify-portable-runtime-signing.mjs",
      "--manifest",
      manifestPath,
      "--policy",
      "production",
      "--verification-input",
      inputPath,
    ],
    { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter((text) => typeof text === "string" && text.trim().length > 0)
      .join("\n")
      .trim();
    if (output.length > 0) console.error(output);
    fail("production verifier rejected the macOS artifact");
  }
  const verified = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (verified.security?.verificationStatus !== "verified-production")
    fail("macOS manifest did not reach verified production");
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  if (command === "finalize") {
    await finalize(options);
    return;
  }
  const handlers = synchronousCommandHandlers(options);
  if (!Object.hasOwn(handlers, command)) fail("unsupported command");
  handlers[command]();
}

function synchronousCommandHandlers(options) {
  return {
    "compare-bytes": () => compareCommand(options, true),
    "compare-paths": () => compareCommand(options, false),
    inventory: () => inventoryCommand(options),
    "inventory-root": () => inventoryRootCommand(options),
    "notary-result": () => assertAcceptedNotaryResult(resolve(required(options, "result"))),
    "prepare-qualified-payload": () => prepareQualifiedPayloadCommand(options),
    "rebind-payload": () => rebindPayloadCommand(options),
    "validate-config": () => validateAppleSigningConfig(process.env),
    "validate-runtime-qualification": () => validateRuntimeQualificationCommand(options),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof BoundedMacSigningError
        ? error.message
        : "macos-portable-signing: redacted failure",
    );
    process.exit(1);
  }
}
