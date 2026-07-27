#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  RUNTIME_ACTIVATION_RELATIVE_PATH,
  RUNTIME_QUALIFICATION_SUITE,
} from "./runtime-activation-manifest.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const WINDOWS_TARGET = "windows-x64";

export class WindowsRuntimeQualificationError extends Error {}

function fail(message) {
  throw new WindowsRuntimeQualificationError(`windows-runtime-qualification: ${message}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
  return (
    Array.isArray(activation.sidecarRuntimes) &&
    activation.sidecarRuntimes.length === 1 &&
    activation.sidecarRuntimes[0]?.name === "opencode-compatible" &&
    SHA256.test(activation.sidecarRuntimes[0]?.payloadSha256)
  );
}

function componentDigest(resourceRoot, helper) {
  const path = join(resourceRoot, ...helper.executablePath.split("/"));
  const entry = lstatSync(path);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1 ||
    entry.size !== helper.sizeBytes ||
    sha256(path) !== helper.shippedSha256
  ) {
    fail("activation helper bytes are invalid");
  }
  return helper.shippedSha256;
}

export function qualificationReceiptFor(input) {
  const activation = readJson(input.activationPath, "activation manifest");
  validateActivation(activation, input.sourceCommitSha);
  const supervisor = helperByName(activation, "keiko-runtime-supervisor");
  const secureRead = helperByName(activation, "keiko-secure-workspace-read");
  return {
    schemaVersion: 1,
    suiteVersion: RUNTIME_QUALIFICATION_SUITE,
    platformTarget: WINDOWS_TARGET,
    sourceCommitSha: input.sourceCommitSha,
    activationManifestSha256: sha256(input.activationPath),
    supervisorSha256: componentDigest(input.resourceRoot, supervisor),
    secureReadSha256: componentDigest(input.resourceRoot, secureRead),
    sidecars: activation.sidecarRuntimes.map((sidecar) => ({
      name: sidecar.name,
      sha256: sidecar.payloadSha256,
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
    resourceRoot,
    sourceCommitSha,
  });
  const output = resolve(required(options, "output"));
  if (dirname(output) === output) fail("output path is invalid");
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
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
