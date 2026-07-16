#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { measureEditorOwnCode as measureProductionEditorOwnCode } from "./editor-bundle-size.mjs";
import { measureReleaseEvidence as measureProductionReleaseEvidence } from "./editor-release-evidence.mjs";
import {
  computeD12BundleMeasurementSha256,
  computePerformanceSubjectDigest,
} from "./check-perf-evidence.mjs";
import {
  computeD12MeasurementToolchainDigest,
  D12_MEASUREMENT_TOOLCHAIN_PATHS,
} from "./d12-measurement-toolchain.mjs";
import { compareStrings } from "./lib/compare-strings.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { createD12RuntimeEnvironment } from "./d12-runtime-environment.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const SHA_256 = /^[0-9a-f]{64}$/u;
const DEPENDENCY_PROVISIONING = Object.freeze({ command: "npm", args: ["ci", "--ignore-scripts"] });
const VALUE_OPTIONS = new Set(["--output", "--root"]);
const PRODUCER_ROOT = resolve(import.meta.dirname, "..");

function fail(message) {
  throw new Error(`D12 bundle input: ${message}`);
}

export { computeD12BundleMeasurementSha256 };

export function assertD12BundleMeasurementFingerprint(input) {
  const actual = input?.measurementSha256;
  const expected = computeD12BundleMeasurementSha256(input);
  if (!SHA_256.test(actual ?? "") || actual !== expected) {
    fail("measurementSha256 does not match measurements and producer bindings");
  }
}

function assertCommit(commit) {
  if (!FULL_COMMIT.test(commit ?? "")) fail("checkout HEAD must be a full lowercase commit SHA");
}

function normalizeDependencyProvisioning(value) {
  if (
    value?.command !== DEPENDENCY_PROVISIONING.command ||
    JSON.stringify(value.args) !== JSON.stringify(DEPENDENCY_PROVISIONING.args) ||
    !SHA_256.test(value.lockfileSha256 ?? "")
  ) {
    fail(
      "dependencyProvisioning must bind npm ci --ignore-scripts and a lowercase lockfile SHA-256",
    );
  }
  return {
    args: [...value.args],
    command: value.command,
    lockfileSha256: value.lockfileSha256,
  };
}

function normalizeBundleRuntime(value) {
  const expectedKeys = [
    "architecture",
    "nodeVersion",
    "npmVersion",
    "osRelease",
    "platform",
    "zlibVersion",
  ];
  if (
    typeof value !== "object" ||
    value === null ||
    !isDeepStrictEqual(Object.keys(value).sort(compareStrings), expectedKeys)
  ) {
    fail("runtime must contain only the canonical bundle-runtime fields");
  }
  if (value.platform !== "linux") fail("runtime platform must be linux");
  if (value.nodeVersion !== "24.18.0") fail("runtime Node.js version must be 24.18.0");
  if (value.npmVersion !== "11.16.0") fail("runtime npm version must be 11.16.0");
  for (const field of ["architecture", "osRelease", "zlibVersion"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      fail(`runtime ${field} must be a non-empty string`);
    }
  }
  return { ...value };
}

function bundleBudgetMeasurements(releaseEvidence, ownCode) {
  return {
    b1: {
      monacoMarkersInFirstLoad: releaseEvidence.b1.monacoMarkersInFirstLoad,
      ok: releaseEvidence.b1.ok,
    },
    b2: { shipsTotalBytes: releaseEvidence.b2.shipsTotalBytes, ok: releaseEvidence.b2.ok },
    b3: {
      largestWorkerBytes: releaseEvidence.b3.largestWorkerBytes,
      ok: releaseEvidence.b3.ok,
    },
    b10: {
      ceilingBytes: ownCode.ceilingBytes,
      fileCount: ownCode.fileCount,
      ok: ownCode.ok,
      totalGzipBytes: ownCode.totalGzipBytes,
    },
  };
}

export function buildD12BundleInput({
  commit,
  dependencyProvisioning,
  measurementHarnessSha256,
  ownCode,
  producerCommit,
  releaseEvidence,
  runtime,
  sourceTreeSha256,
}) {
  assertCommit(commit);
  assertCommit(producerCommit);
  if (!SHA_256.test(sourceTreeSha256) || !SHA_256.test(measurementHarnessSha256)) {
    fail("sourceTreeSha256 and measurementHarnessSha256 must be lowercase SHA-256 digests");
  }
  const budgets = bundleBudgetMeasurements(releaseEvidence, ownCode);
  const measurement = {
    ...budgets,
    commit,
    dependencyProvisioning: normalizeDependencyProvisioning(dependencyProvisioning),
    measurementHarnessSha256,
    producerCommit,
    runtime: normalizeBundleRuntime(runtime),
    sourceTreeSha256,
  };
  return {
    ...budgets,
    commit: measurement.commit,
    dependencyProvisioning: measurement.dependencyProvisioning,
    measurementHarnessSha256: measurement.measurementHarnessSha256,
    measurementSha256: computeD12BundleMeasurementSha256(measurement),
    producerCommit: measurement.producerCommit,
    runtime: measurement.runtime,
    sourceTreeSha256: measurement.sourceTreeSha256,
  };
}

function hostExecFileSync(command, args, options) {
  return execFileSync(resolveHostExecutable(command), args, options);
}

function checkoutCommit(root) {
  return execFileSync(resolveHostExecutable("git"), ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function measurementHarnessSha256(root) {
  return computeD12MeasurementToolchainDigest(
    (path) => readFileSync(resolve(root, path)),
    D12_MEASUREMENT_TOOLCHAIN_PATHS,
  );
}

function listDirtyPaths(root) {
  return execFileSync(
    resolveHostExecutable("git"),
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));
}

export function prepareProductionBundle(root, execute = hostExecFileSync) {
  const environment = createD12RuntimeEnvironment();
  execute("npm", ["ci", "--ignore-scripts"], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  for (const script of ["clean", "build", "build:ui"]) {
    execute("npm", ["run", script], { cwd: root, env: environment, stdio: "inherit" });
  }
}

function bundleRuntimeProvenance(execute = hostExecFileSync) {
  const environment = createD12RuntimeEnvironment();
  const npmVersion = execute("npm", ["--version"], {
    encoding: "utf8",
    env: environment,
  }).trim();
  return {
    architecture: arch(),
    nodeVersion: process.version.replace(/^v/u, ""),
    npmVersion,
    osRelease: release(),
    platform: platform(),
    zlibVersion: process.versions.zlib ?? "",
  };
}

function lockfileSha256(root) {
  return createHash("sha256")
    .update(readFileSync(resolve(root, "package-lock.json")))
    .digest("hex");
}

function assertCleanCheckout(root, getDirtyPaths) {
  const dirtyPaths = getDirtyPaths(root);
  if (dirtyPaths.length > 0) fail(`checkout is dirty: ${dirtyPaths.join(", ")}`);
}

function assertStableCheckout(root, commit, getCheckoutCommit, getDirtyPaths) {
  if (getCheckoutCommit(root) !== commit) fail("checkout HEAD changed during bundle measurement");
  assertCleanCheckout(root, getDirtyPaths);
}

function optionValue(argv, index, argument) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${argument} requires a value`);
  return value;
}

function parseArguments(argv) {
  const options = { root: process.cwd() };
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    if (!VALUE_OPTIONS.has(argument)) fail(`unexpected argument ${String(argument)}`);
    options[argument.slice(2)] = optionValue(argv, index, argument);
  }
  if (options.output === undefined) fail("--output is required");
  return options;
}

function resolveProducerDependencies(dependencies) {
  const resolved = {
    computeLockfileSha256: lockfileSha256,
    computeMeasurementHarnessSha256: measurementHarnessSha256,
    computeSourceTreeSha256: computePerformanceSubjectDigest,
    getCheckoutCommit: checkoutCommit,
    getProducerCommit: checkoutCommit,
    getRuntimeProvenance: bundleRuntimeProvenance,
    listDirtyPaths,
    measureEditorOwnCode: measureProductionEditorOwnCode,
    measureReleaseEvidence: measureProductionReleaseEvidence,
    prepareProductionBundle,
    ...dependencies,
  };
  return {
    getCheckoutCommit: resolved.getCheckoutCommit,
    getDirtyPaths: resolved.listDirtyPaths,
    getHarnessSha256: resolved.computeMeasurementHarnessSha256,
    getLockfileSha256: resolved.computeLockfileSha256,
    getProducerCommit: resolved.getProducerCommit,
    getRuntimeProvenance: resolved.getRuntimeProvenance,
    getSourceTreeSha256: resolved.computeSourceTreeSha256,
    measureEditorOwnCode: resolved.measureEditorOwnCode,
    measureReleaseEvidence: resolved.measureReleaseEvidence,
    prepareBundle: resolved.prepareProductionBundle,
  };
}

export function runD12BundleInputProducer(argv, dependencies = {}) {
  const options = parseArguments(argv);
  const root = resolve(options.root);
  const resolved = resolveProducerDependencies(dependencies);
  const { getCheckoutCommit, getDirtyPaths, getLockfileSha256, prepareBundle } = resolved;
  const commit = getCheckoutCommit(root);
  const producerCommit = resolved.getProducerCommit(PRODUCER_ROOT);
  const sourceTreeSha256 = resolved.getSourceTreeSha256({ root });
  const harnessSha256 = resolved.getHarnessSha256(PRODUCER_ROOT);
  const expectedLockfileSha256 = getLockfileSha256(root);
  const runtime = normalizeBundleRuntime(resolved.getRuntimeProvenance());
  assertCommit(commit);
  assertCleanCheckout(root, getDirtyPaths);
  prepareBundle(root);
  if (getLockfileSha256(root) !== expectedLockfileSha256) {
    fail("package-lock.json changed during exact dependency provisioning");
  }
  if (!isDeepStrictEqual(normalizeBundleRuntime(resolved.getRuntimeProvenance()), runtime)) {
    fail("bundle runtime changed during exact dependency provisioning or production build");
  }
  assertStableCheckout(root, commit, getCheckoutCommit, getDirtyPaths);
  const releaseEvidence = resolved.measureReleaseEvidence(root);
  const ownCode = resolved.measureEditorOwnCode(root);
  assertStableCheckout(root, commit, getCheckoutCommit, getDirtyPaths);
  const input = buildD12BundleInput({
    commit,
    dependencyProvisioning: {
      args: [...DEPENDENCY_PROVISIONING.args],
      command: DEPENDENCY_PROVISIONING.command,
      lockfileSha256: expectedLockfileSha256,
    },
    measurementHarnessSha256: harnessSha256,
    ownCode,
    producerCommit,
    releaseEvidence,
    runtime,
    sourceTreeSha256,
  });
  const output = resolve(options.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  return input;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const input = runD12BundleInputProducer(process.argv.slice(2));
    console.log(
      `Wrote D12 bundle input for ${input.commit} with measurement ${input.measurementSha256}`,
    );
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
