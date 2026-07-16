#!/usr/bin/env node

import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  commitIsAncestor,
  listExactDirtyPerformanceSubjectPaths,
  runD12Builder,
} from "./build-d12-perf-comparison.mjs";
import { computePerformanceSubjectDigest } from "./check-perf-evidence.mjs";
import {
  computeD12MeasurementToolchainDigest,
  D12_MEASUREMENT_TOOLCHAIN_PATHS,
  selectD12MeasurementToolchainPaths,
} from "./d12-measurement-toolchain.mjs";
import { createD12RuntimeEnvironment } from "./d12-runtime-environment.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

export const BASELINE_COMMIT = "18750d079e2a61c7d7044f3f6ec977a104b9884f";
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const SHA_256 = /^[0-9a-f]{64}$/u;
const REVISIONS = ["baseline", "candidate"];
const ARTIFACT_OWNER_FILE = ".keiko-d12-runner-owned";
const ARTIFACT_OWNER_CONTENT = "keiko-d12-performance-runner-v1\n";
const DEPENDENCY_PROVISIONING = {
  command: "npm",
  args: ["ci", "--ignore-scripts"],
};
const VALUE_OPTIONS = new Set([
  "--artifacts-root",
  "--baseline-bundle",
  "--baseline-root",
  "--candidate-bundle",
  "--candidate-root",
  "--output",
]);
const RECORDED_ORDERS = [
  ["baseline", "candidate"],
  ["candidate", "baseline"],
  ["baseline", "candidate"],
];

function parseNullSeparated(value) {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function gitPathList(root, args) {
  return parseNullSeparated(
    execFileSync(resolveHostExecutable("git"), args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

function listDirtyD12MeasurementToolchainPaths(root) {
  const pathspec = [...D12_MEASUREMENT_TOOLCHAIN_PATHS];
  const tracked = gitPathList(root, ["diff", "--name-only", "-z", "HEAD", "--", ...pathspec]);
  const untracked = gitPathList(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...pathspec,
  ]);
  return selectD12MeasurementToolchainPaths([...tracked, ...untracked]);
}

function readCommittedToolchainPath(root, path) {
  return execFileSync(resolveHostExecutable("git"), ["show", `HEAD:${path}`], {
    cwd: root,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function computeCommittedD12MeasurementToolchainDigest(root) {
  return computeD12MeasurementToolchainDigest((path) => readCommittedToolchainPath(root, path));
}

function fail(message) {
  throw new Error(`D12 performance runner: ${message}`);
}

function optionValue(argv, index, argument) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${argument} requires a value`);
  return value;
}

function parseArgument(options, argv, index) {
  const argument = argv[index];
  if (argument === "--self-check") {
    options.selfCheck = true;
    return index;
  }
  if (!VALUE_OPTIONS.has(argument)) fail(`unexpected argument ${argument}`);
  const value = optionValue(argv, index, argument);
  options[argument.slice(2)] = value;
  return index + 1;
}

function parseArguments(argv) {
  const options = { selfCheck: false };
  let index = 0;
  while (index < argv.length) {
    index = parseArgument(options, argv, index) + 1;
  }
  for (const name of [
    "baseline-root",
    "candidate-root",
    "baseline-bundle",
    "candidate-bundle",
    "output",
  ]) {
    if (options[name] === undefined) fail(`--${name} is required`);
  }
  return options;
}

function checkoutHead(root) {
  return execFileSync(resolveHostExecutable("git"), ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function validateCheckout(revision, root, head, dirtyPaths) {
  if (!FULL_COMMIT.test(head)) fail(`${revision} HEAD is not a full lowercase commit SHA`);
  if (revision === "baseline" && head !== BASELINE_COMMIT) {
    fail(`baseline HEAD ${head} does not match pinned baseline ${BASELINE_COMMIT}`);
  }
  if (dirtyPaths.length > 0) {
    fail(`${revision} performance subject is dirty: ${dirtyPaths.join(", ")}`);
  }
  if (!existsSync(join(root, "package-lock.json")))
    fail(`${revision} root has no package-lock.json`);
}

function canonicalPotentialPath(path) {
  let existing = resolve(path);
  const suffix = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) fail(`cannot resolve path ownership for ${path}`);
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function isSameOrAncestor(ancestor, candidate) {
  const path = relative(ancestor, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function assertArtifactsRootSafe(state, outputPath) {
  const artifactsRoot = canonicalPotentialPath(state.artifactsRoot);
  const output = canonicalPotentialPath(resolve(outputPath));
  const outputParent = canonicalPotentialPath(dirname(resolve(outputPath)));
  if (dirname(artifactsRoot) === artifactsRoot) fail("artifacts root cannot be a filesystem root");
  if (artifactsRoot === output) fail("artifacts root cannot equal the comparison output path");
  if (isSameOrAncestor(artifactsRoot, outputParent)) {
    fail("artifacts root cannot be the output parent or one of its ancestors");
  }
  for (const [revision, root] of Object.entries(state.roots)) {
    const checkout = canonicalPotentialPath(root);
    if (isSameOrAncestor(artifactsRoot, checkout) || isSameOrAncestor(checkout, artifactsRoot)) {
      fail(`artifacts root cannot overlap the ${revision} checkout`);
    }
  }
}

function assertOwnedArtifactsRoot(path) {
  const root = lstatSync(path);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    fail("existing artifacts root is not a runner-owned directory");
  }
  const markerPath = join(path, ARTIFACT_OWNER_FILE);
  if (!existsSync(markerPath)) fail("existing artifacts root is not runner-owned");
  const marker = lstatSync(markerPath);
  if (!marker.isFile() || marker.isSymbolicLink()) {
    fail("existing artifacts ownership marker is not a regular file");
  }
  if (readFileSync(markerPath, "utf8") !== ARTIFACT_OWNER_CONTENT) {
    fail("existing artifacts ownership marker is invalid");
  }
}

function resetOwnedArtifactsRoot(path) {
  if (existsSync(path)) {
    assertOwnedArtifactsRoot(path);
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(join(path, "runs"), { recursive: true, mode: 0o700 });
  writeFileSync(join(path, ARTIFACT_OWNER_FILE), ARTIFACT_OWNER_CONTENT, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function lockfileSha256(root) {
  return createHash("sha256")
    .update(readFileSync(join(root, "package-lock.json")))
    .digest("hex");
}

function defaultDependencyProvisioner(plan) {
  const result = spawnSync(resolveHostExecutable(plan.command), plan.args, {
    cwd: plan.root,
    env: createD12RuntimeEnvironment(),
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    fail(`dependency provisioning failed to start: ${String(result.error)}`);
  }
  if (result.status !== 0) {
    fail(`${plan.revision} dependency provisioning exited with status ${String(result.status)}`);
  }
}

function generatedOutputPaths(root) {
  const paths = [join(root, "coverage"), join(root, "dist")];
  const packagesRoot = join(root, "packages");
  if (!existsSync(packagesRoot)) return paths;
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    paths.push(
      join(packagesRoot, entry.name, ".next"),
      join(packagesRoot, entry.name, "dist"),
      join(packagesRoot, entry.name, "out"),
    );
  }
  return paths;
}

function defaultCheckoutCleaner(plan) {
  const result = spawnSync(resolveHostExecutable("npm"), ["run", "clean"], {
    cwd: plan.root,
    env: createD12RuntimeEnvironment(),
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    fail(`${plan.revision} checkout clean failed to start: ${String(result.error)}`);
  }
  if (result.status !== 0) {
    fail(`${plan.revision} checkout clean exited with status ${String(result.status)}`);
  }
  const remaining = generatedOutputPaths(plan.root).filter((path) => existsSync(path));
  if (remaining.length > 0) {
    fail(`${plan.revision} checkout clean retained generated outputs: ${remaining.join(", ")}`);
  }
}

function provisionDependencies(state, provision) {
  for (const revision of REVISIONS) {
    provision({
      ...DEPENDENCY_PROVISIONING,
      args: [...DEPENDENCY_PROVISIONING.args],
      revision,
      root: state.roots[revision],
    });
    if (lockfileSha256(state.roots[revision]) !== state.dependencyLockfileSha256) {
      fail(`${revision} package-lock.json changed during dependency provisioning`);
    }
  }
}

function cleanCheckouts(state, cleanCheckout) {
  for (const revision of REVISIONS) {
    cleanCheckout({ revision, root: state.roots[revision] });
  }
}

function readArtifact(path) {
  if (!existsSync(path)) fail(`browser harness did not write ${path}`);
  const contents = readFileSync(path);
  let raw;
  try {
    raw = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    fail(`browser artifact is not valid JSON: ${path} (${String(error)})`);
  }
  return {
    contents,
    raw,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function defaultProvisioningCreator({ adapterFixturePath, candidateRoot, stateDir }) {
  const helperUrl = pathToFileURL(
    join(candidateRoot, "tests", "e2e", "support", "dapOperatorProvisioning.ts"),
  ).href;
  const expression = [
    `const module = await import(${JSON.stringify(helperUrl)});`,
    "const value = module.createE2eDapOperatorProvisioning(",
    JSON.stringify({ adapterFixturePath, stateDir }),
    ");",
    "process.stdout.write(value);",
  ].join("\n");
  return execFileSync(process.execPath, ["--input-type=module", "--eval", expression], {
    encoding: "utf8",
    env: createD12RuntimeEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
  });
}

function runtimePreparationPaths(root, stateDir) {
  const fixtureConfigPath = join(root, "tests", "e2e", "fixtures", "keiko.e2e.config.json");
  const runtimeConfigPath = join(stateDir, "keiko.e2e.config.json");
  return { fixtureConfigPath, runtimeConfigPath };
}

function runConfigSettings(kind) {
  if (kind === "cap") {
    return { expectTimeout: 20_000, portBase: 32_283, testMatch: "editor-debugging-2348.spec.ts" };
  }
  return { expectTimeout: 15_000, portBase: 32_183, testMatch: "editor-performance.spec.ts" };
}

function webServerLauncherSource(plan) {
  return [
    'import { execFileSync, spawn } from "node:child_process";',
    'import { copyFileSync, mkdirSync } from "node:fs";',
    'import { join } from "node:path";',
    `const plan = ${JSON.stringify(plan)};`,
    "mkdirSync(plan.stateDir, { recursive: true, mode: 0o700 });",
    "copyFileSync(plan.fixtureConfigPath, plan.runtimeConfigPath);",
    'for (const script of ["build", "prepare:bin", "build:ui"]) {',
    '  execFileSync("npm", ["run", script], {',
    "    cwd: plan.root,",
    "    env: process.env,",
    "    shell: false,",
    '    stdio: "inherit",',
    "  });",
    "}",
    "const child = spawn(",
    "  process.execPath,",
    "  [",
    '    join(plan.root, "dist", "cli", "index.js"),',
    '    "ui",',
    '    "--port",',
    "    String(plan.port),",
    '    "--config",',
    "    plan.runtimeConfigPath,",
    '    "--ui-db",',
    "    plan.uiDbPath,",
    "  ],",
    '  { cwd: plan.root, env: process.env, shell: false, stdio: "inherit" },',
    ");",
    'for (const signal of ["SIGINT", "SIGTERM"]) {',
    "  process.once(signal, () => child.kill(signal));",
    "}",
    'child.once("error", (error) => { throw error; });',
    'child.once("exit", (code) => { process.exitCode = code ?? 1; });',
    "",
  ].join("\n");
}

function writeWebServerLauncher(context, paths, port) {
  const launcherPath = join(context.stateDir, "web-server-launcher.mjs");
  const launcherSource = webServerLauncherSource({
    fixtureConfigPath: paths.fixtureConfigPath,
    port,
    root: context.root,
    runtimeConfigPath: paths.runtimeConfigPath,
    stateDir: context.stateDir,
    uiDbPath: join(context.stateDir, "ui", "ui.sqlite"),
  });
  mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(launcherPath, launcherSource, { encoding: "utf8", mode: 0o600 });
  return { launcherPath, launcherSource };
}

function buildWebServer(context, provisioning, settings) {
  const paths = runtimePreparationPaths(context.root, context.stateDir);
  const port = settings.portBase + context.portOffset;
  const launcher = writeWebServerLauncher(context, paths, port);
  return {
    command: "node web-server-launcher.mjs",
    cwd: context.stateDir,
    env: {
      KEIKO_CONFIG_FILE: paths.runtimeConfigPath,
      KEIKO_MEMORY_DIR: join(context.stateDir, "memory"),
      KEIKO_STATE_DIR: context.stateDir,
      KEIKO_UI_DATA_DIR: join(context.stateDir, "ui"),
      ...(provisioning === undefined ? {} : { KEIKO_DAP_OPERATOR_PROVISIONING_JSON: provisioning }),
    },
    port,
    fixtureConfigPath: paths.fixtureConfigPath,
    ...launcher,
    root: context.root,
    reuseExistingServer: false,
    timeout: 240_000,
    url: `http://127.0.0.1:${String(port)}`,
  };
}

function playwrightWebServer(webServer) {
  return {
    command: webServer.command,
    cwd: webServer.cwd,
    env: webServer.env,
    reuseExistingServer: webServer.reuseExistingServer,
    timeout: webServer.timeout,
    url: webServer.url,
  };
}

function writeRunPlaywrightConfig(context, provisioning) {
  const settings = runConfigSettings(context.kind);
  const webServer = buildWebServer(context, provisioning, settings);
  const requireBase = pathToFileURL(join(context.candidateRoot, "package.json")).href;
  const source = [
    'import { createRequire } from "node:module";',
    `const require = createRequire(${JSON.stringify(requireBase)});`,
    'const { defineConfig, devices } = require("@playwright/test");',
    "export default defineConfig({",
    `  testDir: ${JSON.stringify(join(context.candidateRoot, "tests", "e2e"))},`,
    `  testMatch: ${JSON.stringify(settings.testMatch)},`,
    "  fullyParallel: false,",
    "  workers: 1,",
    "  timeout: 120000,",
    `  expect: { timeout: ${String(settings.expectTimeout)} },`,
    '  reporter: process.env.CI ? [["github"], ["line"]] : "line",',
    `  use: { baseURL: ${JSON.stringify(webServer.url)}, trace: "retain-on-failure" },`,
    '  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],',
    `  webServer: ${JSON.stringify(playwrightWebServer(webServer))},`,
    "});",
    "",
  ].join("\n");
  mkdirSync(dirname(context.configPath), { recursive: true });
  writeFileSync(context.configPath, source, "utf8");
  return { path: context.configPath, source, webServer };
}

export function buildHarnessArguments(kind, cli, configPath) {
  const grep = kind === "common" ? "@release-evidence" : "D12";
  return [cli, "test", "--config", configPath, "--project=chromium", "--grep", grep];
}

function defaultHarnessRunner(context) {
  const cli = join(context.candidateRoot, "node_modules", "@playwright", "test", "cli.js");
  if (!existsSync(cli)) fail(`Playwright CLI is missing: ${cli}`);
  const args = buildHarnessArguments(context.kind, cli, context.configPath);
  const evidenceEnvironment =
    context.kind === "cap"
      ? { KEIKO_D12_CAP_EVIDENCE_PATH: context.outputPath }
      : { KEIKO_PERF_EVIDENCE_PATH: context.outputPath };
  const result = spawnSync(process.execPath, args, {
    cwd: context.root,
    encoding: "utf8",
    env: createD12RuntimeEnvironment(process.env, {
      ...evidenceEnvironment,
      KEIKO_E2E_STATE_DIR: context.stateDir,
      KEIKO_PERF_COMMIT: context.head,
      KEIKO_PERF_D12_REVISION: context.revision,
      KEIKO_PERF_MEASUREMENT_HARNESS_SHA256: context.measurementHarnessSha256,
      KEIKO_PERF_RUNS: "10",
      KEIKO_PERF_SOURCE_TREE_SHA256: context.sourceTreeSha256,
    }),
    stdio: "inherit",
  });
  if (result.error !== undefined) fail(`browser harness failed to start: ${String(result.error)}`);
  if (result.status !== 0) {
    fail(
      `${context.revision} ${context.kind} browser harness exited with status ${String(result.status)}`,
    );
  }
}

function iso(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    fail("clock returned an invalid date");
  return value.toISOString();
}

function requireRawRunProvenance(raw, revision, context) {
  if (raw?.commit !== context.head)
    fail(`${revision} artifact commit does not equal checkout HEAD`);
  if (raw?.sourceTreeSha256 !== context.sourceTreeSha256) {
    fail(`${revision} artifact sourceTreeSha256 does not equal the checkout digest`);
  }
  if (raw?.measurementHarnessSha256 !== context.measurementHarnessSha256) {
    fail(`${revision} artifact measurementHarnessSha256 does not equal the runner digest`);
  }
  if (typeof raw?.provenance !== "object" || raw.provenance === null) {
    fail(`${revision} artifact provenance is missing`);
  }
}

function invokeHarness(context, kind, dependencies) {
  const outputPath = kind === "cap" ? context.capOutputPath : context.outputPath;
  const stateDir = join(context.stateDir, kind);
  const configPath = join(context.artifactsRoot, "configs", `${context.suffix}-${kind}.config.mjs`);
  const provisioning =
    context.revision === "baseline"
      ? undefined
      : dependencies.createProvisioning({
          adapterFixturePath: join(
            context.root,
            "tests",
            "e2e",
            "fixtures",
            "editor-debugging-2348",
            "dap-socket-adapter.fixture",
          ),
          candidateRoot: context.candidateRoot,
          root: context.root,
          stateDir,
        });
  const config = writeRunPlaywrightConfig(
    { ...context, configPath, kind, outputPath, stateDir },
    provisioning,
  );
  dependencies.runHarness({
    ...context,
    config,
    configPath,
    kind,
    outputPath,
    stateDir,
  });
}

function recordedRun(context, artifact, interval) {
  requireRawRunProvenance(artifact.raw, context.revision, context);
  return {
    artifact: relative(context.artifactsRoot, context.outputPath),
    artifactSha256: artifact.sha256,
    checkoutHead: context.head,
    commonCompletedAtIso: interval.commonCompletedAtIso,
    completedAtIso: interval.completedAtIso,
    measurementHarnessSha256: context.measurementHarnessSha256,
    provenance: artifact.raw.provenance,
    sequence: context.sequence,
    sourceTreeSha256: context.sourceTreeSha256,
    startedAtIso: interval.startedAtIso,
  };
}

function runContext(context, dependencies) {
  const startedAtIso = iso(dependencies.now);
  invokeHarness(context, "common", dependencies);
  const commonCompletedAtIso = iso(dependencies.now);
  let capInterval;
  if (context.revision === "candidate") {
    const capStartedAtIso = iso(dependencies.now);
    invokeHarness(context, "cap", dependencies);
    capInterval = { capCompletedAtIso: iso(dependencies.now), capStartedAtIso };
  }
  const completedAtIso = capInterval?.capCompletedAtIso ?? commonCompletedAtIso;
  if (!context.recorded) {
    rmSync(context.outputPath, { force: true });
    rmSync(context.capOutputPath, { force: true });
    return undefined;
  }
  const run = recordedRun(context, readArtifact(context.outputPath), {
    commonCompletedAtIso,
    completedAtIso,
    startedAtIso,
  });
  if (capInterval !== undefined) {
    run.capEvidence = bindCandidateCapEvidence(
      context,
      run,
      readArtifact(context.capOutputPath),
      capInterval,
    );
  }
  return run;
}

function makeRunContext(state, revision, sequence, recorded, capOrdinal = 0) {
  const suffix = recorded ? `run-${String(sequence)}` : `warm-up-${revision}`;
  const outputPath = join(state.artifactsRoot, "runs", `${suffix}.json`);
  const capName = recorded
    ? `candidate-cap-${String(capOrdinal)}.json`
    : "warm-up-candidate-cap.json";
  const root = state.roots[revision];
  return {
    ...state,
    capOutputPath: join(state.artifactsRoot, "runs", capName),
    head: state.heads[revision],
    outputPath,
    portOffset: recorded ? sequence : revision === "baseline" ? 7 : 8,
    recorded,
    revision,
    root,
    sequence,
    sourceTreeSha256: state.sourceTreeSha256[revision],
    stateDir: join(state.artifactsRoot, "state", suffix),
    suffix,
  };
}

function executeWarmUps(state, dependencies) {
  for (const revision of REVISIONS) {
    runContext(makeRunContext(state, revision, 0, false), dependencies);
  }
}

function executeRecordedRuns(state, dependencies) {
  const repetitions = [];
  let sequence = 0;
  for (const [repetitionIndex, order] of RECORDED_ORDERS.entries()) {
    const repetition = { order: [...order] };
    for (const revision of order) {
      sequence += 1;
      const run = runContext(
        makeRunContext(state, revision, sequence, true, repetitionIndex + 1),
        dependencies,
      );
      repetition[revision] = run;
    }
    repetitions.push(repetition);
  }
  return repetitions;
}

function bindCandidateCapEvidence(context, candidateRun, artifact, interval) {
  requireRawRunProvenance(artifact.raw, "candidate cap", context);
  if (!isDeepStrictEqual(artifact.raw.provenance, candidateRun.provenance)) {
    fail(`candidate cap evidence sequence ${String(candidateRun.sequence)} provenance differs`);
  }
  return {
    artifact: relative(context.artifactsRoot, context.capOutputPath),
    artifactSha256: artifact.sha256,
    checkoutHead: candidateRun.checkoutHead,
    completedAtIso: interval.capCompletedAtIso,
    measurementHarnessSha256: candidateRun.measurementHarnessSha256,
    provenance: candidateRun.provenance,
    sequence: candidateRun.sequence,
    sourceTreeSha256: candidateRun.sourceTreeSha256,
    startedAtIso: interval.capStartedAtIso,
  };
}

function builderArguments(options, manifestPath) {
  return [
    "--manifest",
    manifestPath,
    "--baseline-bundle",
    resolve(options["baseline-bundle"]),
    "--candidate-bundle",
    resolve(options["candidate-bundle"]),
    "--baseline-root",
    resolve(options["baseline-root"]),
    "--candidate-root",
    resolve(options["candidate-root"]),
    "--output",
    resolve(options.output),
    "--self-check",
  ];
}

function resolveState(options, dependencies) {
  const roots = {
    baseline: resolve(options["baseline-root"]),
    candidate: resolve(options["candidate-root"]),
  };
  const heads = Object.fromEntries(
    REVISIONS.map((revision) => [revision, dependencies.getHead(roots[revision])]),
  );
  for (const revision of REVISIONS) {
    validateCheckout(
      revision,
      roots[revision],
      heads[revision],
      dependencies.listDirtyPaths(roots[revision]),
    );
  }
  if (!dependencies.isAncestor(roots.candidate, BASELINE_COMMIT, heads.candidate)) {
    fail("pinned baseline commit is not an ancestor of candidate HEAD");
  }
  const dirtyToolchainPaths = dependencies.listDirtyToolchainPaths(roots.candidate);
  if (dirtyToolchainPaths.length > 0) {
    fail(`candidate D12 measurement toolchain is dirty: ${dirtyToolchainPaths.join(", ")}`);
  }
  const sourceTreeSha256 = Object.fromEntries(
    REVISIONS.map((revision) => [revision, dependencies.computeDigest({ root: roots[revision] })]),
  );
  for (const [revision, digest] of Object.entries(sourceTreeSha256)) {
    if (!SHA_256.test(digest)) fail(`${revision} source-tree helper returned an invalid digest`);
  }
  const measurementHarnessSha256 = dependencies.computeHarnessDigest(roots.candidate);
  if (!SHA_256.test(measurementHarnessSha256)) fail("measurement harness digest is invalid");
  const artifactsRoot = resolve(
    options["artifacts-root"] ?? join(dirname(resolve(options.output)), "d12-perf-runs"),
  );
  const lockfileDigests = Object.fromEntries(
    REVISIONS.map((revision) => [revision, lockfileSha256(roots[revision])]),
  );
  if (lockfileDigests.baseline !== lockfileDigests.candidate) {
    fail("baseline and candidate package-lock.json digests differ");
  }
  return {
    artifactsRoot,
    dependencyLockfileSha256: lockfileDigests.candidate,
    heads,
    measurementHarnessSha256,
    roots,
    sourceTreeSha256,
  };
}

export async function runD12Comparison(argv, injected = {}) {
  const options = parseArguments(argv);
  const dependencies = {
    buildComparison: runD12Builder,
    cleanCheckout: defaultCheckoutCleaner,
    computeDigest: computePerformanceSubjectDigest,
    computeHarnessDigest: computeCommittedD12MeasurementToolchainDigest,
    createProvisioning: defaultProvisioningCreator,
    getHead: checkoutHead,
    isAncestor: commitIsAncestor,
    listDirtyPaths: listExactDirtyPerformanceSubjectPaths,
    listDirtyToolchainPaths: listDirtyD12MeasurementToolchainPaths,
    now: () => new Date(),
    provisionDependencies: defaultDependencyProvisioner,
    runHarness: defaultHarnessRunner,
    ...injected,
  };
  const state = resolveState(options, dependencies);
  assertArtifactsRootSafe(state, options.output);
  if (existsSync(state.artifactsRoot)) assertOwnedArtifactsRoot(state.artifactsRoot);
  provisionDependencies(state, dependencies.provisionDependencies);
  cleanCheckouts(state, dependencies.cleanCheckout);
  resetOwnedArtifactsRoot(state.artifactsRoot);
  state.candidateRoot = state.roots.candidate;
  executeWarmUps(state, dependencies);
  const manifest = {
    schemaVersion: "3",
    dependencyProvisioning: {
      ...DEPENDENCY_PROVISIONING,
      args: [...DEPENDENCY_PROVISIONING.args],
      lockfileSha256: state.dependencyLockfileSha256,
    },
    warmUp: {
      runs: 1,
      procedure:
        "one complete unrecorded common run per revision, plus one candidate cap-producer warm-up",
    },
    repetitions: executeRecordedRuns(state, dependencies),
  };
  const manifestPath = join(state.artifactsRoot, "execution-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  mkdirSync(dirname(resolve(options.output)), { recursive: true });
  const comparison = dependencies.buildComparison(builderArguments(options, manifestPath));
  return { artifactsRoot: state.artifactsRoot, comparison, manifestPath };
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  runD12Comparison(process.argv.slice(2))
    .then(({ comparison }) => {
      console.log(
        `Wrote D12 comparison for ${comparison.d12Comparison.candidateCommit} from six orchestrated runs`,
      );
    })
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}
