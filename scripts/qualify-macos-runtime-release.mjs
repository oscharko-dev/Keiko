#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  RUNTIME_ACTIVATION_RELATIVE_PATH,
  RUNTIME_QUALIFICATION_SUITE,
} from "./runtime-activation-manifest.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TARGETS = new Set(["macos-arm64", "macos-x64"]);

export class MacosRuntimeQualificationError extends Error {}

function fail(message) {
  throw new MacosRuntimeQualificationError(`macos-runtime-qualification: ${message}`);
}

export function parseMacosQualificationArgs(argv) {
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

function readJson(path, label) {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 262_144) {
      fail(`${label} is invalid`);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof MacosRuntimeQualificationError) throw error;
    fail(`${label} is invalid`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function helperByName(activation, name) {
  const matches = Array.isArray(activation.nativeHelpers)
    ? activation.nativeHelpers.filter((helper) => helper?.name === name)
    : [];
  if (matches.length !== 1) fail("activation helper set is invalid");
  const helper = matches[0];
  const expectedPath = `runtime/native/${name}`;
  if (
    helper?.platformTarget !== activation.platformTarget ||
    helper.executablePath !== expectedPath ||
    !Number.isSafeInteger(helper.sizeBytes) ||
    helper.sizeBytes <= 0 ||
    !SHA256.test(helper.shippedSha256)
  ) {
    fail("activation helper set is invalid");
  }
  return helper;
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

function validateActivation(activation, target, sourceCommitSha) {
  if (
    !activationIdentityIsValid(activation, target, sourceCommitSha) ||
    !activationRuntimeIsValid(activation, target)
  ) {
    fail("activation manifest is invalid");
  }
  helperByName(activation, "keiko-runtime-supervisor");
  helperByName(activation, "keiko-secure-workspace-read");
  if (!activationSidecarIsValid(activation)) fail("activation OpenCode binding is invalid");
}

function activationIdentityIsValid(activation, target, sourceCommitSha) {
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
    activation.platformTarget === target &&
    activation.sourceCommitSha === sourceCommitSha
  );
}

function activationRuntimeIsValid(activation, target) {
  return (
    activation.artifact?.platformTarget === target &&
    activation.runtime?.nodePlatform === "darwin" &&
    activation.runtime?.nodeArchitecture === (target === "macos-arm64" ? "arm64" : "x64") &&
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

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function qualificationReceiptFor(input) {
  const activation = readJson(input.activationPath, "activation manifest");
  validateActivation(activation, input.target, input.sourceCommitSha);
  return {
    schemaVersion: 1,
    suiteVersion: RUNTIME_QUALIFICATION_SUITE,
    platformTarget: input.target,
    sourceCommitSha: input.sourceCommitSha,
    activationManifestSha256: sha256(input.activationPath),
    supervisorSha256: componentDigest(
      input.resourceRoot,
      helperByName(activation, "keiko-runtime-supervisor"),
    ),
    secureReadSha256: componentDigest(
      input.resourceRoot,
      helperByName(activation, "keiko-secure-workspace-read"),
    ),
    sidecars: activation.sidecarRuntimes.map((sidecar) => ({
      name: sidecar.name,
      sha256: sidecar.payloadSha256,
    })),
    backend: "macos-endpoint-security",
    result: "passed",
  };
}

export function runQualificationCommand(command, args, label, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl(command, args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {},
    shell: false,
    timeout: 120_000,
  });
  if (result.error !== undefined || result.status !== 0 || result.stderr !== "") {
    fail(`${label} failed`);
  }
  return result.stdout.trim();
}

export function runQuietQualificationCommand(command, args, label, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl(command, args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {},
    shell: false,
    timeout: 120_000,
  });
  if (result.error !== undefined || result.status !== 0) fail(`${label} failed`);
}

export function assertSameExecutable(stagedPath, executionPath, label) {
  const staged = lstatSync(stagedPath);
  const execution = lstatSync(executionPath);
  if (
    !staged.isFile() ||
    staged.isSymbolicLink() ||
    staged.nlink !== 1 ||
    !execution.isFile() ||
    execution.isSymbolicLink() ||
    execution.nlink !== 1 ||
    staged.size !== execution.size ||
    sha256(stagedPath) !== sha256(executionPath)
  ) {
    fail(`${label} bytes are invalid`);
  }
}

export function executionAppRoot(options, lstat = lstatSync) {
  const configured = options["execution-app-root"];
  if (configured === undefined) fail("--execution-app-root is required");
  const appRoot = resolve(configured);
  const entry = lstat(appRoot);
  if (
    !/^\/Applications\/KeikoQualification-[A-Za-z0-9._-]+\.app$/u.test(appRoot) ||
    !entry.isDirectory() ||
    entry.isSymbolicLink()
  ) {
    fail("execution app root is invalid");
  }
  return appRoot;
}

function verifyOnly(options) {
  const value = options["verify-only"];
  if (value === undefined || value === "false") return false;
  if (value !== "true") fail("--verify-only is invalid");
  return true;
}

export function qualifyMacosRuntimeRelease(
  options,
  {
    executionAppRootFn = executionAppRoot,
    platform = process.platform,
    runFn = runQualificationCommand,
    runQuietFn = runQuietQualificationCommand,
  } = {},
) {
  if (platform !== "darwin") fail("qualification requires macOS");
  const target = required(options, "target");
  const sourceCommitSha = required(options, "source-commit-sha");
  if (!TARGETS.has(target) || !COMMIT.test(sourceCommitSha))
    fail("qualification identity is invalid");
  const stageRoot = resolve(required(options, "stage-root"));
  const resourceRoot = join(stageRoot, "payload", "Keiko", "Keiko.app", "Contents", "Resources");
  const stagedAppRoot = join(stageRoot, "payload", "Keiko", "Keiko.app");
  const appRoot = executionAppRootFn(options);
  qualifyExecutionApp({ appRoot, resourceRoot, stagedAppRoot }, { runFn, runQuietFn });
  const activationPath = join(resourceRoot, ...RUNTIME_ACTIVATION_RELATIVE_PATH.split("/"));
  const receipt = qualificationReceiptFor({
    activationPath,
    resourceRoot,
    target,
    sourceCommitSha,
  });
  persistQualificationReceipt(resourceRoot, receipt, verifyOnly(options));
}

function qualifyExecutionApp({ appRoot, resourceRoot, stagedAppRoot }, { runFn, runQuietFn }) {
  runQuietFn("/usr/bin/codesign", ["--verify", "--deep", "--strict", appRoot], "app signature");
  runQuietFn("/usr/sbin/spctl", ["-a", "-t", "exec", appRoot], "Gatekeeper assessment");
  const manager = join(appRoot, "Contents", "MacOS", "KeikoSystemExtensionManager");
  assertSameExecutable(
    join(stagedAppRoot, "Contents", "MacOS", "KeikoSystemExtensionManager"),
    manager,
    "system extension manager",
  );
  if (runFn(manager, ["--activate"], "system extension activation") !== "active") {
    fail("system extension requires approval");
  }
  const supervisor = join(
    appRoot,
    "Contents",
    "Resources",
    "runtime",
    "native",
    "keiko-runtime-supervisor",
  );
  assertSameExecutable(
    join(resourceRoot, "runtime", "native", "keiko-runtime-supervisor"),
    supervisor,
    "runtime supervisor",
  );
  runFn(
    process.execPath,
    ["native/runtime-supervisor/macos/test-protocol.mjs", "--helper", supervisor],
    "exact supervisor qualification",
  );
}

function persistQualificationReceipt(resourceRoot, receipt, verify) {
  const receiptPath = join(resourceRoot, ".portable", "runtime-qualification.json");
  if (verify) {
    if (
      JSON.stringify(readJson(receiptPath, "runtime qualification receipt")) !==
      JSON.stringify(receipt)
    ) {
      fail("runtime qualification receipt is stale");
    }
  } else {
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    qualifyMacosRuntimeRelease(parseMacosQualificationArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(
      error instanceof MacosRuntimeQualificationError
        ? error.message
        : "macos-runtime-qualification: redacted failure",
    );
    process.exit(1);
  }
}
