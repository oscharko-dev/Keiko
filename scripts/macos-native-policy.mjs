#!/usr/bin/env node

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TARGETS = new Set(["macos-arm64", "macos-x64"]);
const CREDENTIAL_ENV = [
  "APPLE_DEVELOPER_ID_CERT_P12_BASE64",
  "APPLE_DEVELOPER_ID_CERT_PASSWORD",
  "APPLE_DEVELOPER_ID_IDENTITY",
  "APPLE_NOTARY_ISSUER_ID",
  "APPLE_NOTARY_KEY_ID",
  "APPLE_NOTARY_KEY_P8_BASE64",
  "APPLE_TEAM_ID",
  "KEIKO_KEYCHAIN_PASSWORD",
  "KEIKO_KEYCHAIN_PATH",
  "KEIKO_NOTARY_KEY_PATH",
  "KEIKO_P12_PATH",
  "KEIKO_SIGNING_TEMP_ROOT",
];
export const MAC_NATIVE_FIELDS = Object.freeze([
  "architectureVerified",
  "archiveVerified",
  "configValidated",
  "entitlementsVerified",
  "gatekeeperAccepted",
  "hardenedRuntimeVerified",
  "identityVerified",
  "importSucceeded",
  "inventoryVerified",
  "notarizationAccepted",
  "setupSucceeded",
  "signScopeVerified",
  "stapleVerified",
  "teamVerified",
  "timestampVerified",
]);
const RESULT_KEYS = Object.freeze(
  [
    ...MAC_NATIVE_FIELDS,
    "cleanupSucceeded",
    "finalizerSucceeded",
    "payloadSmokeVerified",
    "schemaVersion",
    "target",
  ].sort(),
);

export class MacNativePolicyError extends Error {}

function fail(message) {
  throw new MacNativePolicyError(`macos-native-policy: ${message}`);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
  );
}

function parseArgs(argv) {
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

function assertTarget(target) {
  if (!TARGETS.has(target)) fail("target is invalid");
}

function initialResult(target) {
  return Object.fromEntries([
    ...MAC_NATIVE_FIELDS.map((name) => [name, false]),
    ["cleanupSucceeded", false],
    ["finalizerSucceeded", false],
    ["payloadSmokeVerified", false],
    ["schemaVersion", 1],
    ["target", target],
  ]);
}

export function readMacNativeResult(path, expectedTarget) {
  let value;
  try {
    if (statSync(path).size > 16_384) fail("native result is invalid");
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof MacNativePolicyError) throw error;
    fail("native result is invalid");
  }
  if (!exactKeys(value, RESULT_KEYS)) fail("native result is invalid");
  if (value.schemaVersion !== 1 || value.target !== expectedTarget)
    fail("native result is invalid");
  for (const name of [
    ...MAC_NATIVE_FIELDS,
    "cleanupSucceeded",
    "finalizerSucceeded",
    "payloadSmokeVerified",
  ]) {
    if (typeof value[name] !== "boolean") fail("native result is invalid");
  }
  return value;
}

function nativeSucceeded(result) {
  return MAC_NATIVE_FIELDS.every((name) => result[name] === true);
}

export function verificationChecksForNativeResult(result) {
  return {
    assessmentVerified: result.gatekeeperAccepted === true,
    developerIdVerified:
      result.architectureVerified === true &&
      result.entitlementsVerified === true &&
      result.hardenedRuntimeVerified === true &&
      result.identityVerified === true &&
      result.signScopeVerified === true &&
      result.teamVerified === true &&
      result.timestampVerified === true,
    notarizationVerified: result.notarizationAccepted === true,
    stapleVerified: result.stapleVerified === true,
  };
}

export function macNativeControlFlow(result, production = true) {
  const cleanupRuns = production;
  const payloadSmokeRuns =
    production && nativeSucceeded(result) && result.cleanupSucceeded === true;
  const finalizeRuns = payloadSmokeRuns && result.payloadSmokeVerified === true;
  const uploadRuns = finalizeRuns && result.finalizerSucceeded === true;
  return { cleanupRuns, finalizeRuns, payloadSmokeRuns, uploadRuns };
}

export function assertSigningCredentialsCleared(env) {
  if (CREDENTIAL_ENV.some((name) => typeof env[name] === "string" && env[name].length > 0))
    fail("signing credentials were not cleared before payload execution");
}

function writeResult(path, result) {
  writeFileSync(resolve(path), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}

function credentialsSuccess(options) {
  const target = required(options, "target");
  assertTarget(target);
  const result = initialResult(target);
  result.configValidated = true;
  result.importSucceeded = true;
  result.setupSucceeded = true;
  writeResult(required(options, "output"), result);
}

function staticSuccess(options) {
  const target = required(options, "target");
  assertTarget(target);
  const input = resolve(required(options, "input"));
  const result = readMacNativeResult(input, target);
  if (!result.configValidated || !result.importSucceeded || !result.setupSucceeded)
    fail("credential phase did not succeed");
  for (const name of MAC_NATIVE_FIELDS) result[name] = true;
  writeResult(required(options, "output"), result);
}

function cleanupSuccess(options) {
  const target = required(options, "target");
  assertTarget(target);
  const input = resolve(required(options, "input"));
  const result = readMacNativeResult(input, target);
  result.cleanupSucceeded = true;
  writeResult(required(options, "output"), result);
}

function verificationInput(manifest, checks) {
  return {
    reasonCodes: [],
    verificationChecks: checks,
    sidecarRuntimes: (manifest.sidecarRuntimes ?? []).map((sidecar) => ({
      name: sidecar.name,
      reasonCodes: [],
      verificationChecks: checks,
    })),
  };
}

function complete(options) {
  const target = required(options, "target");
  assertTarget(target);
  assertSigningCredentialsCleared(process.env);
  const input = resolve(required(options, "input"));
  const result = readMacNativeResult(input, target);
  if (!nativeSucceeded(result) || result.cleanupSucceeded !== true)
    fail("native verification or cleanup did not succeed");
  result.payloadSmokeVerified = true;
  writeResult(input, result);
  const stage = resolve(required(options, "stage-root"));
  const manifest = JSON.parse(
    readFileSync(join(stage, "manifest", "portable-manifest.json"), "utf8"),
  );
  if (manifest.artifact?.platformTarget !== target) fail("manifest target is invalid");
  const checks = verificationChecksForNativeResult(result);
  writeFileSync(
    resolve(required(options, "output")),
    `${JSON.stringify(verificationInput(manifest, checks), null, 2)}\n`,
    { mode: 0o600 },
  );
}

function finalizerSuccess(options) {
  const target = required(options, "target");
  assertTarget(target);
  const input = resolve(required(options, "input"));
  const result = readMacNativeResult(input, target);
  if (!nativeSucceeded(result) || !result.cleanupSucceeded || !result.payloadSmokeVerified)
    fail("prior production phases did not succeed");
  result.finalizerSucceeded = true;
  writeResult(input, result);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === "credentials-success") credentialsSuccess(options);
  else if (command === "static-success") staticSuccess(options);
  else if (command === "cleanup-success") cleanupSuccess(options);
  else if (command === "complete") complete(options);
  else if (command === "finalizer-success") finalizerSuccess(options);
  else fail("unsupported command");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof MacNativePolicyError
        ? error.message
        : "macos-native-policy: redacted failure",
    );
    process.exit(1);
  }
}
