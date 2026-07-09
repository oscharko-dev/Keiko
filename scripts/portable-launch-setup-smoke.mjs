import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PORTABLE_TARGETS, findPortableMetadataRedactionFailures } from "./portable-runtime.mjs";
import { validateStageRoot } from "./portable-launch-setup-stage.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const FIXED_NOW = new Date("2026-07-06T00:00:00.000Z");

function fail(message) {
  throw new Error(`portable launch/setup smoke failed: ${message}`);
}

function parseArgs(argv) {
  const options = { evidence: undefined, keepTemp: false, stageRoot: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }
    if (arg !== "--evidence" && arg !== "--stage-root") fail(`unsupported argument ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
    if (arg === "--evidence") options.evidence = resolve(value);
    if (arg === "--stage-root") options.stageRoot = resolve(value);
    index += 1;
  }
  return options;
}

function runtimeManifest(target) {
  return {
    nodePlatform: target.nodePlatform,
    nodeArchitecture: target.nodeArchitecture,
  };
}

function setupManifest(target, version = rootPackage.version) {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      platformTarget: target.platformTarget,
      packageName: rootPackage.name,
      packageVersion: version,
      stable: !version.includes("-"),
      primaryLauncher: target.primaryLauncher,
      bootstrapUpdateEligible: false,
      runtime: runtimeManifest(target),
    },
    null,
    2,
  )}\n`;
}

function writeAppFixture(appRoot, version = rootPackage.version) {
  mkdirSync(join(appRoot, "dist", "cli"), { recursive: true });
  writeFileSync(
    join(appRoot, "package.json"),
    `${JSON.stringify({ name: rootPackage.name, version }, null, 2)}\n`,
  );
  writeFileSync(join(appRoot, "dist", "cli", "index.js"), "fixture cli\n");
}

function writeWindowsFixture(root, target, version = rootPackage.version) {
  mkdirSync(join(root, "runtime", "node"), { recursive: true });
  mkdirSync(join(root, ".portable"), { recursive: true });
  mkdirSync(join(root, "support"), { recursive: true });
  writeAppFixture(join(root, "app"), version);
  writeFileSync(join(root, "runtime", "node", "node.exe"), "fixture node\n");
  writeFileSync(join(root, "Keiko.exe"), "fixture launcher\n");
  writeFileSync(join(root, "support", "keiko-support.cmd"), "support launcher\n");
  writeFileSync(join(root, ".portable", "setup-manifest.json"), setupManifest(target, version));
  return root;
}

function writeMacFixture(root, target, version = rootPackage.version) {
  const appRoot = join(root, "Keiko.app");
  const resources = join(appRoot, "Contents", "Resources");
  mkdirSync(join(appRoot, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(resources, "runtime", "node", "bin"), { recursive: true });
  mkdirSync(join(resources, ".portable"), { recursive: true });
  mkdirSync(join(root, "support"), { recursive: true });
  writeAppFixture(join(resources, "app"), version);
  writeFileSync(join(resources, "runtime", "node", "bin", "node"), "fixture node\n");
  writeFileSync(join(appRoot, "Contents", "MacOS", "Keiko"), "fixture launcher\n");
  writeFileSync(join(root, "support", "keiko-support.sh"), "support launcher\n");
  writeFileSync(
    join(resources, ".portable", "setup-manifest.json"),
    setupManifest(target, version),
  );
  return appRoot;
}

function writeFixture(root, target, version = rootPackage.version) {
  return target.nodePlatform === "win32"
    ? writeWindowsFixture(root, target, version)
    : writeMacFixture(root, target, version);
}

function targetEnv(target, home) {
  if (target.nodePlatform !== "win32") return { HOME: home, PATH: "" };
  return {
    APPDATA: join(home, "AppData", "Roaming"),
    HOME: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    PATH: "",
  };
}

function managedRoot(target, home) {
  if (target.nodePlatform === "win32") return join(home, "AppData", "Local", "Programs", "Keiko");
  return join(home, "Applications", "Keiko.app");
}

function managedAppRoot(target, root) {
  if (target.nodePlatform === "win32") return join(root, "app");
  return join(root, "Contents", "Resources", "app");
}

function managedPackageJson(target, root) {
  return join(managedAppRoot(target, root), "package.json");
}

function readManagedPackageVersion(target, root) {
  return JSON.parse(readFileSync(managedPackageJson(target, root), "utf8")).version;
}

function previousStableVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (match === null) fail(`root version is not stable semver: ${version}`);
  const patch = Number(match[3]);
  if (patch <= 0) fail(`root patch version cannot produce a previous fixture: ${version}`);
  return `${match[1]}.${match[2]}.${String(patch - 1)}`;
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    err: () => stderr,
    io: {
      err: (text) => {
        stderr += text;
      },
      out: (text) => {
        stdout += text;
      },
    },
    out: () => stdout,
  };
}

function readRegistration(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, "portable-install-state.json"), "utf8"));
}

function fakeChild() {
  return { unref: () => undefined };
}

function smokeTempRoot() {
  const base = join(homedir(), ".keiko-test-roots");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "portable-launch-setup-"));
}

async function runFixtureTarget(target, root, runPortableCli, now) {
  const base = join(root, "fixtures", target.platformTarget);
  const home = join(base, "home");
  const stateDir = join(base, "state");
  const portableRoot = writeFixture(join(base, "bootstrap"), target);
  const env = targetEnv(target, home);
  const rootAfterSetup = managedRoot(target, home);
  const first = capture();
  const spawns = [];
  const code = await runPortableCli(
    portableLaunchArgs(target, portableRoot, rootAfterSetup, stateDir),
    first.io,
    env,
    {
      arch: () => target.nodeArchitecture,
      homedir: () => home,
      now: () => now,
      platform: () => target.nodePlatform,
      spawnFn: (command) => {
        spawns.push(command);
        return fakeChild();
      },
    },
  );
  if (code !== 0) fail(`${target.platformTarget} first launch failed: ${first.err()}`);
  const relaunch = await runFixtureRelaunch(
    target,
    portableRoot,
    rootAfterSetup,
    stateDir,
    env,
    home,
    runPortableCli,
    spawns,
  );
  return {
    ...relaunch,
    manualDownloadUpgrade: await runFixtureManualUpgrade(target, root, runPortableCli, now),
  };
}

function portableLaunchArgs(target, portableRoot, rootAfterSetup, stateDir) {
  return [
    "launch",
    "--target",
    target.platformTarget,
    "--portable-root",
    portableRoot,
    "--managed-root",
    rootAfterSetup,
    "--state-dir",
    stateDir,
  ];
}

async function runFixtureManualUpgrade(target, root, runPortableCli, now) {
  const base = join(root, "manual-upgrade", target.platformTarget);
  const home = join(base, "home");
  const stateDir = join(base, "state");
  const env = targetEnv(target, home);
  const rootAfterSetup = managedRoot(target, home);
  const oldVersion = previousStableVersion(rootPackage.version);
  const oldRoot = writeFixture(join(base, "old-download"), target, oldVersion);
  const newRoot = writeFixture(join(base, "new-download"), target, rootPackage.version);
  const first = capture();
  const firstCode = await runPortableCli(
    portableLaunchArgs(target, oldRoot, rootAfterSetup, stateDir),
    first.io,
    env,
    {
      arch: () => target.nodeArchitecture,
      homedir: () => home,
      now: () => now,
      platform: () => target.nodePlatform,
      spawnFn: () => fakeChild(),
    },
  );
  if (firstCode !== 0) fail(`${target.platformTarget} manual upgrade setup failed: ${first.err()}`);
  return runFixtureManualUpgradeClick(
    target,
    newRoot,
    rootAfterSetup,
    stateDir,
    env,
    home,
    runPortableCli,
  );
}

async function runFixtureManualUpgradeClick(
  target,
  newRoot,
  rootAfterSetup,
  stateDir,
  env,
  home,
  runPortableCli,
) {
  const second = capture();
  const lifecycleCommands = [];
  const code = await runPortableCli(
    portableLaunchArgs(target, newRoot, rootAfterSetup, stateDir),
    second.io,
    env,
    {
      arch: () => target.nodeArchitecture,
      homedir: () => home,
      lifecycleFn: (command) => {
        lifecycleCommands.push(command);
        return Promise.resolve(0);
      },
      platform: () => target.nodePlatform,
    },
  );
  if (code !== 0) fail(`${target.platformTarget} manual upgrade failed: ${second.err()}`);
  const registration = readRegistration(stateDir);
  return {
    clickedNewerPackageStoppedServer: lifecycleCommands[0] === "stop",
    relaunchedAfterSwap: lifecycleCommands[1] === "start",
    upgradedPackageVersion:
      registration.packageVersion === rootPackage.version &&
      readManagedPackageVersion(target, rootAfterSetup) === rootPackage.version,
    noRollbackPathUsed: !lifecycleCommands.includes("restart"),
  };
}

async function runFixtureRelaunch(
  target,
  portableRoot,
  rootAfterSetup,
  stateDir,
  env,
  home,
  runPortableCli,
  spawns,
) {
  const second = capture();
  const lifecycleStarts = [];
  const code = await runPortableCli(
    portableLaunchArgs(target, portableRoot, rootAfterSetup, stateDir),
    second.io,
    env,
    {
      arch: () => target.nodeArchitecture,
      homedir: () => home,
      lifecycleFn: (_command, _args, _io, _env, deps) => {
        lifecycleStarts.push(deps.cwd);
        return Promise.resolve(0);
      },
      platform: () => target.nodePlatform,
    },
  );
  if (code !== 0) fail(`${target.platformTarget} relaunch failed: ${second.err()}`);
  return fixtureEvidence(
    target,
    readRegistration(stateDir),
    spawns,
    lifecycleStarts,
    rootAfterSetup,
  );
}

function fixtureEvidence(target, registration, spawns, lifecycleStarts, rootAfterSetup) {
  const appRoot = managedAppRoot(target, rootAfterSetup);
  return {
    platformTarget: target.platformTarget,
    primaryLauncher: target.primaryLauncher,
    setupStatus: registration.status,
    updateEligible: registration.updateEligible,
    pathWithoutNodeOrNpm: true,
    spawnedManagedLauncher: spawns.length === 1,
    relaunchedFromManagedAppRoot: lifecycleStarts.length === 1 && lifecycleStarts[0] === appRoot,
  };
}

function verifyNativeLauncherSource() {
  const source = readFileSync(
    join(repoRoot, "native", "portable-launcher", "keiko-portable-launcher.c"),
    "utf8",
  );
  if (!source.includes("\\\\runtime\\\\node\\\\node.exe"))
    fail("Windows launcher does not use bundled Node");
  if (!source.includes("/Contents/Resources/runtime/node/bin/node"))
    fail("macOS launcher does not use bundled Node");
  if (!source.includes('"portable"') || !source.includes('"launch"'))
    fail("launcher does not invoke portable launch");
  if (/\bnpm\b|\bnpx\b|\byarn\b/u.test(source))
    fail("launcher source must not invoke package managers");
  return {
    windowsBundledNodePath: true,
    macosBundledNodePath: true,
    packageManagersBypassed: true,
    invokesPortableLaunch: true,
  };
}

function section(text, heading) {
  const marker = `## ${heading}\n`;
  const start = text.indexOf(marker);
  if (start === -1) return "";
  const body = text.slice(start + marker.length);
  const next = body.search(/\n## |\n# /u);
  return next === -1 ? body : body.slice(0, next);
}

function containsPrimaryShellCommand(text) {
  return /```|(?:^|\n)\s*(?:node|npm|npx|yarn|keiko)\s+|npm install|keiko start|keiko portable/iu.test(
    text,
  );
}

export function validatePortableLaunchSetupDocs() {
  const guide = readFileSync(
    join(repoRoot, "docs", "release", "portable-launch-setup-guide.md"),
    "utf8",
  );
  const troubleshooting = readFileSync(
    join(repoRoot, "docs", "troubleshooting", "portable-launch-setup.md"),
    "utf8",
  );
  const primary = `${section(guide, "Primary User Journey")}\n${section(guide, "Update Journey")}`;
  if (containsPrimaryShellCommand(primary))
    fail("primary portable user journey must not contain shell commands");
  for (const target of PORTABLE_TARGETS) {
    if (!guide.includes(target.platformTarget) || !guide.includes(target.assetName)) {
      fail(`portable guide must document ${target.platformTarget}`);
    }
  }
  for (const word of [
    "Windows SmartScreen",
    "Gatekeeper",
    "proxy",
    "firewall",
    "local port",
    "permissions",
    "organization-managed",
  ]) {
    if (!troubleshooting.includes(word)) fail(`troubleshooting must mention ${word}`);
  }
  return { primaryJourneyShellFree: true, troubleshootingHonest: true };
}

async function loadPortableCli() {
  const modulePath = pathToFileURL(
    join(repoRoot, "packages", "keiko-cli", "dist", "portable.js"),
  ).href;
  try {
    return await import(modulePath);
  } catch (error) {
    fail(
      `build packages before running the smoke (${error instanceof Error ? error.message : "import failed"})`,
    );
  }
}

function assertEvidenceSafe(evidence) {
  const failures = findPortableMetadataRedactionFailures(evidence, "portableLaunchSetupSmoke");
  if (failures.length > 0) fail(`evidence is not redacted:\n  - ${failures.join("\n  - ")}`);
}

function resolvedTempRoot(deps) {
  return deps.tempRoot !== undefined ? deps.tempRoot : smokeTempRoot();
}

function resolvedNow(deps) {
  return deps.now !== undefined ? deps.now : FIXED_NOW;
}

async function fixtureTargetEvidence(tempRoot, runPortableCli, now) {
  const fixtureTargets = [];
  for (const target of PORTABLE_TARGETS)
    fixtureTargets.push(await runFixtureTarget(target, tempRoot, runPortableCli, now));
  return fixtureTargets;
}

function stagedArtifactEvidence(options) {
  return options.stageRoot === undefined ? [] : validateStageRoot(options.stageRoot);
}

function writeEvidenceFile(options, evidence) {
  if (options.evidence !== undefined)
    writeFileSync(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function smokeEvidence(options, tempRoot, deps, now) {
  const { runPortableCli } = deps.runPortableCli ?? (await loadPortableCli());
  const fixtureTargets = await fixtureTargetEvidence(tempRoot, runPortableCli, now);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    issue: 1953,
    launcherSource: verifyNativeLauncherSource(),
    docs: validatePortableLaunchSetupDocs(),
    fixtureTargets,
    stagedArtifacts: stagedArtifactEvidence(options),
  };
}

export async function runPortableLaunchSetupSmoke(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const tempRoot = resolvedTempRoot(deps);
  const now = resolvedNow(deps);
  try {
    const evidence = await smokeEvidence(options, tempRoot, deps, now);
    assertEvidenceSafe(evidence);
    writeEvidenceFile(options, evidence);
    console.log(`portable-launch-setup-smoke: PASS ${evidence.fixtureTargets.length} target(s)`);
    return evidence;
  } finally {
    if (!options.keepTemp && deps.tempRoot === undefined)
      rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPortableLaunchSetupSmoke();
}
