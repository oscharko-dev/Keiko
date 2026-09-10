#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { sha256File } from "./lib/digest.mjs";
import {
  RUNTIME_ACTIVATION_RELATIVE_PATH,
  RUNTIME_QUALIFICATION_SUITE,
} from "./runtime-activation-manifest.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TARGET = "linux-x64";
const RECEIPT_PATH = ".portable/runtime-qualification.json";
const RUNTIME_COMPONENTS = Object.freeze([
  { name: "primary-launcher", path: "Keiko" },
  { name: "node-runtime", path: "runtime/node/bin/node" },
]);
const REQUIRED_TEST_TITLES = new Set([
  "permits only the configured gateway and isolates concurrent gateway ports",
  "composes a release-qualified Linux run through the namespace gateway backend",
]);

export class LinuxRuntimeQualificationError extends Error {}

function fail(message) {
  throw new LinuxRuntimeQualificationError(`linux-runtime-qualification: ${message}`);
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) fail(`--${name} is required`);
  return value;
}

function booleanOption(options, name) {
  const value = options[name] ?? "false";
  if (value !== "true" && value !== "false") fail(`--${name} is invalid`);
  return value === "true";
}

/** @internal Exported only for deterministic CLI-boundary tests. */
export function parseQualificationArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("invalid arguments");
    options[key.slice(2)] = value;
  }
  return options;
}

function readJson(path, label) {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 262_144) {
      fail(`${label} is invalid`);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof LinuxRuntimeQualificationError) throw error;
    return fail(`${label} is invalid`);
  }
}

/** @internal Exported only for deterministic checkout-binding tests. */
export function exactCleanHead(sourceCommitSha, execute = execFileSync) {
  const head = execute("/usr/bin/git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const status = execute("/usr/bin/git", ["status", "--porcelain=v1"], {
    encoding: "utf8",
  });
  if (head !== sourceCommitSha || status.length > 0) {
    fail("qualification checkout is not the clean exact source head");
  }
}

function helperByName(activation, name) {
  const matches = Array.isArray(activation.nativeHelpers)
    ? activation.nativeHelpers.filter((helper) => helper?.name === name)
    : [];
  if (matches.length !== 1) fail("activation helper set is invalid");
  const helper = matches[0];
  const expectedPath =
    name === "keiko-runtime-supervisor"
      ? "app/node_modules/@oscharko-dev/keiko-sandbox/dist/runtime.js"
      : "runtime/native/keiko-secure-workspace-read";
  if (
    helper?.platformTarget !== TARGET ||
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
    sha256File(path) !== helper.shippedSha256
  ) {
    fail("activation helper bytes are invalid");
  }
  return helper.shippedSha256;
}

function fileDigest(resourceRoot, relativePath) {
  try {
    const path = join(resourceRoot, ...relativePath.split("/"));
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size <= 0) {
      fail("runtime component bytes are invalid");
    }
    return sha256File(path);
  } catch (error) {
    if (error instanceof LinuxRuntimeQualificationError) throw error;
    return fail("runtime component bytes are invalid");
  }
}

function usearchComponent(activation, resourceRoot) {
  const addons = Array.isArray(activation.nativeAddons) ? activation.nativeAddons : [];
  if (addons.length !== 1) fail("activation native addon set is invalid");
  const addon = addons[0];
  if (
    addon?.name !== "usearch" ||
    addon.platformTarget !== TARGET ||
    addon.executablePath !== "runtime/native/usearch.node" ||
    !Number.isSafeInteger(addon.sizeBytes) ||
    addon.sizeBytes <= 0 ||
    !SHA256.test(addon.shippedSha256)
  ) {
    fail("activation native addon set is invalid");
  }
  return { name: "usearch", sha256: componentDigest(resourceRoot, addon) };
}

function runtimeComponents(activation, resourceRoot) {
  return [
    ...RUNTIME_COMPONENTS.map((component) => ({
      name: component.name,
      sha256: fileDigest(resourceRoot, component.path),
    })),
    usearchComponent(activation, resourceRoot),
  ];
}

function assertValid(condition, message = "activation manifest is invalid") {
  if (!condition) fail(message);
}

function validateActivationIdentity(activation, sourceCommitSha) {
  assertValid(activation.schemaVersion === 1);
  assertValid(activation.suiteVersion === RUNTIME_QUALIFICATION_SUITE);
  assertValid(activation.platformTarget === TARGET);
  assertValid(activation.sourceCommitSha === sourceCommitSha);
  assertValid(activation.artifact?.platformTarget === TARGET);
  assertValid(activation.runtime?.nodePlatform === "linux");
  assertValid(activation.runtime?.nodeArchitecture === "x64");
  assertValid(activation.security?.verificationStatus === "verified-production");
}

function validateActivationSidecar(activation) {
  assertValid(Array.isArray(activation.sidecarRuntimes));
  assertValid(activation.sidecarRuntimes.length === 1);
  const sidecar = activation.sidecarRuntimes[0];
  assertValid(sidecar?.name === "opencode-compatible");
  assertValid(sidecar?.platformTarget === TARGET);
  assertValid(typeof sidecar?.payloadSha256 === "string");
  assertValid(SHA256.test(sidecar?.payloadSha256));
}

function validateActivation(activation, sourceCommitSha) {
  validateActivationIdentity(activation, sourceCommitSha);
  validateActivationSidecar(activation);
}

export function linuxQualificationVitestArgs(reportPath) {
  return [
    resolve("node_modules/vitest/vitest.mjs"),
    "run",
    "packages/keiko-sandbox/src/linux-gateway-launcher.test.ts",
    "packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.test.ts",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ];
}

export function assertQualificationReport(reportPath) {
  const report = readJson(reportPath, "qualification test report");
  const assertions = (report.testResults ?? []).flatMap((result) => result.assertionResults ?? []);
  const passed = new Set(
    assertions.filter((entry) => entry.status === "passed").map((entry) => entry.title),
  );
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    ![...REQUIRED_TEST_TITLES].every((title) => passed.has(title))
  ) {
    fail("Linux gateway qualification proof is incomplete");
  }
}

/** @internal Exported only for deterministic proof-runner tests. */
export function runQualificationTests(reportPath, spawn = spawnSync) {
  const result = spawn(process.execPath, linuxQualificationVitestArgs(reportPath), {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: process.env,
    shell: false,
    timeout: 120_000,
  });
  if (result.error !== undefined || result.status !== 0) fail("Linux gateway tests failed");
  assertQualificationReport(reportPath);
}

export function qualificationReceiptFor(input) {
  const activation = readJson(input.activationPath, "activation manifest");
  validateActivation(activation, input.sourceCommitSha);
  const supervisor = helperByName(activation, "keiko-runtime-supervisor");
  const secureRead = helperByName(activation, "keiko-secure-workspace-read");
  return {
    schemaVersion: 2,
    suiteVersion: RUNTIME_QUALIFICATION_SUITE,
    platformTarget: TARGET,
    sourceCommitSha: input.sourceCommitSha,
    activationManifestSha256: sha256File(input.activationPath),
    supervisorSha256: componentDigest(input.resourceRoot, supervisor),
    secureReadSha256: componentDigest(input.resourceRoot, secureRead),
    runtimeComponents: runtimeComponents(activation, input.resourceRoot),
    sidecars: activation.sidecarRuntimes.map((sidecar) => ({
      name: sidecar.name,
      sha256: sidecar.payloadSha256,
    })),
    backend: "linux-namespace-gateway",
    result: "passed",
  };
}

function persistOrVerifyReceipt(path, receipt, verifyOnly) {
  if (verifyOnly) {
    const existing = readJson(path, "qualification receipt");
    if (!isDeepStrictEqual(existing, receipt)) fail("qualification receipt binding is invalid");
    return;
  }
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

export function qualifyLinuxRuntimeRelease(options, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== "linux") {
    fail("qualification requires Linux");
  }
  const sourceCommitSha = required(options, "source-commit-sha");
  if (!COMMIT.test(sourceCommitSha)) fail("source commit is invalid");
  (dependencies.exactCleanHead ?? exactCleanHead)(sourceCommitSha);
  const stageRoot = resolve(required(options, "stage-root"));
  const resourceRoot = join(stageRoot, "payload", "Keiko");
  const activationPath = join(resourceRoot, ...RUNTIME_ACTIVATION_RELATIVE_PATH.split("/"));
  (dependencies.runQualificationTests ?? runQualificationTests)(
    resolve(required(options, "test-report")),
  );
  const receipt = qualificationReceiptFor({ activationPath, resourceRoot, sourceCommitSha });
  persistOrVerifyReceipt(
    join(resourceRoot, ...RECEIPT_PATH.split("/")),
    receipt,
    booleanOption(options, "verify-only"),
  );
  return receipt;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    qualifyLinuxRuntimeRelease(parseQualificationArgs(process.argv.slice(2)));
    process.stdout.write("Linux runtime qualification passed.\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof LinuxRuntimeQualificationError ? error.message : "linux-runtime-qualification: redacted failure"}\n`,
    );
    process.exitCode = 1;
  }
}
