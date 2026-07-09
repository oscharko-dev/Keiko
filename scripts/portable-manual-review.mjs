/* global Response */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

import { PORTABLE_TARGETS, findPortableMetadataRedactionFailures } from "./portable-runtime.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const CURRENT_VERSION = rootPackage.version;
const TARGET_VERSION = nextPatchVersion(CURRENT_VERSION);
const RELEASE_TAG = `v${TARGET_VERSION}`;
const RELEASE_ID = 9_940_204_100;
const FIXED_NOW = "2026-07-08T00:00:00.000Z";
const PACKAGE_NAME = "@oscharko-dev/keiko";
const HOST = "127.0.0.1";
const DEFAULT_PORT = 19830;
const REVIEW_DIR_PREFIX = "manual-review";
const SCENARIOS = Object.freeze([
  "current-release",
  "fresh-install",
  "happy-update",
  "bad-checksum",
  "bad-manifest",
  "missing-asset",
  "missing-signing",
  "hostile-archive",
  "remediation-required",
  "sidecar-absent",
  "sidecar-present",
  "sidecar-failure",
  "policy-disabled",
  "unmanaged-bootstrap",
  "system-managed",
  "legacy-package-manager",
  "network-failure",
]);
const VALUE_OPTIONS = new Set(["--out-dir", "--port", "--scenario", "--target"]);
const MUTATING_SCENARIOS = new Set([
  "happy-update",
  "hostile-archive",
  "remediation-required",
  "sidecar-absent",
  "sidecar-present",
]);

function fail(message) {
  throw new Error(`portable manual review failed: ${message}`);
}

function nextPatchVersion(version) {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (stable !== null) {
    return `${stable[1]}.${stable[2]}.${String(Number(stable[3]) + 1)}`;
  }
  // Prerelease root (for example 0.2.15-beta.0 during release-branch stabilization): the
  // simulated next portable release is that version's stable base, and importing this module
  // must not throw at load time.
  const prerelease = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9A-Za-z.-]+$/u.exec(version);
  if (prerelease === null) fail(`root version is not semver: ${version}`);
  return `${prerelease[1]}.${prerelease[2]}.${prerelease[3]}`;
}

function parseArgs(argv) {
  const command = argv[0] ?? "prepare";
  if (!["prepare", "serve"].includes(command)) fail(`unsupported command ${command}`);
  const options = {
    command,
    open: false,
    outDir: undefined,
    port: undefined,
    scenario: "happy-update",
    target: "macos-arm64",
  };
  for (let index = 1; index < argv.length; index += 1) {
    index += applyArg(options, argv, index);
  }
  return options;
}

function applyArg(options, argv, index) {
  const arg = argv[index];
  if (arg === "--open") {
    options.open = true;
    return 0;
  }
  if (!VALUE_OPTIONS.has(arg)) fail(`unsupported argument ${arg}`);
  applyOptionValue(options, arg, requiredArgValue(argv, index, arg));
  return 1;
}

function requiredArgValue(argv, index, arg) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
  return value;
}

function applyOptionValue(options, arg, value) {
  if (arg === "--out-dir") options.outDir = resolve(value);
  else if (arg === "--port") options.port = parsePort(value);
  else if (arg === "--scenario") options.scenario = parseScenario(value);
  else if (arg === "--target") options.target = parseTarget(value).platformTarget;
}

function parsePort(value) {
  if (!/^\d{1,5}$/u.test(value)) fail(`invalid port ${value}`);
  const port = Number(value);
  if (port < 1 || port > 65535) fail(`invalid port ${value}`);
  return port;
}

function parseScenario(value) {
  if (!SCENARIOS.includes(value)) fail(`unknown scenario ${value}`);
  return value;
}

function parseTarget(value) {
  const target = PORTABLE_TARGETS.find((candidate) => candidate.platformTarget === value);
  if (target === undefined) fail(`unknown target ${value}`);
  return target;
}

function shortSha() {
  const result = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "local";
}

function defaultOutDir() {
  return join(
    repoRoot,
    ".portable-runtime",
    `${REVIEW_DIR_PREFIX}-${CURRENT_VERSION}-${shortSha()}`,
  );
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o755 });
}

function shellQuote(value) {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function targetByName(name) {
  return parseTarget(name);
}

function assetName(target) {
  return targetByName(target).assetName;
}

function launcherName(target) {
  return target === "windows-x64" ? "Keiko.exe" : "Keiko.app";
}

function scriptName(target, scenario, ext) {
  return `start-${target}-${scenario}${ext}`;
}

function planTarget(target) {
  return {
    platformTarget: target.platformTarget,
    assetName: target.assetName,
    launcher: target.primaryLauncher,
    scripts: SCENARIOS.map((scenario) => ({
      scenario,
      posix: `scripts/${scriptName(target.platformTarget, scenario, ".sh")}`,
      windows: `scripts/${scriptName(target.platformTarget, scenario, ".cmd")}`,
    })),
  };
}

export function manualReviewPlan() {
  return {
    schemaVersion: 1,
    generatedAt: FIXED_NOW,
    currentVersion: CURRENT_VERSION,
    targetVersion: TARGET_VERSION,
    targets: PORTABLE_TARGETS.map(planTarget),
    scenarios: scenarioRecords(),
    isolation:
      "Each scenario uses its own HOME, state dir, managed install root, UI DB, evidence dir, and update asset fixture.",
  };
}

function scenarioRecords() {
  return SCENARIOS.map((scenario) => ({
    id: scenario,
    title: scenarioTitle(scenario),
    matrixArea: scenarioMatrixArea(scenario),
    mutatesScenarioInstallOnly: MUTATING_SCENARIOS.has(scenario),
  }));
}

function scenarioTitle(scenario) {
  return {
    "bad-checksum": "Bad checksum blocks update",
    "bad-manifest": "Malformed manifest blocks update",
    "current-release": "Already current release",
    "fresh-install": "Fresh package install and native launch",
    "happy-update": "Portable one-click happy path",
    "hostile-archive": "Hostile archive fails closed during staging",
    "legacy-package-manager": "Legacy package-manager compatibility",
    "missing-asset": "Missing platform asset blocks readiness",
    "missing-signing": "Missing signing/notarization evidence blocks readiness",
    "network-failure": "Release metadata unavailable",
    "policy-disabled": "Local update mutation policy disabled",
    "remediation-required": "Post-update remediation blocks final completion",
    "sidecar-absent": "Sidecar-free portable asset remains valid",
    "sidecar-failure": "Sidecar metadata/digest failure blocks update",
    "sidecar-present": "Sidecar-bearing asset verifies as whole-product update",
    "system-managed": "System or organization-managed install is ineligible",
    "unmanaged-bootstrap": "Unmanaged bootstrap install is ineligible",
  }[scenario];
}

function scenarioMatrixArea(scenario) {
  if (scenario === "fresh-install") return "Fresh install, first-run setup, native launch";
  if (scenario === "legacy-package-manager") return "Legacy compatibility";
  if (scenario.startsWith("sidecar")) return "Sidecar absent/present/failure";
  if (scenario.includes("bad") || scenario.includes("missing") || scenario === "hostile-archive") {
    return "Negative artifact";
  }
  if (scenario === "remediation-required") return "Remediation";
  if (scenario === "current-release") return "Current release";
  if (scenario === "network-failure") return "Network/download failure";
  return "Portable update UX";
}

function writePlanJson(outDir, plan) {
  writeFileSync(join(outDir, "manual-review-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
}

function writeReadme(outDir, plan) {
  writeFileSync(join(outDir, "README.md"), readme(plan));
}

function readme(plan) {
  return `# Portable Product Delivery V2 Manual Review

Generated for Keiko ${plan.currentVersion} -> fake stable ${plan.targetVersion}.

This review root is intentionally disposable. Every scenario gets an isolated HOME, state
directory, managed install root, UI database, evidence directory, and fake release asset set.
Scenario runtime roots live under your OS temp directory because Keiko correctly rejects runtime
databases inside the current workspace. Testing an update overwrites only that scenario's managed
install root. It does not touch your real Keiko install.

## Start A Scenario

From this directory, run one generated script, for example:

\`\`\`sh
./scripts/start-macos-arm64-happy-update.sh
./scripts/start-macos-arm64-bad-checksum.sh
./scripts/start-macos-x64-happy-update.sh
./scripts/start-windows-x64-happy-update.sh
\`\`\`

Each script opens a local Keiko review server at \`http://${HOST}:<port>\`. In the UI, use the
startup update notice or Settings -> General -> Review updates. Stop the scenario with Ctrl-C in
the terminal that launched it.

## What Is Mocked

Only public GitHub release metadata/assets are mocked. The local BFF, CSRF gate, update preflight
service, update session routes, update window, portable staging, activation swap, and local update
state are the product code paths. The fake assets are unsigned review fixtures and must not be used
as production signing/notarization evidence.

## Scenario Inventory

${plan.scenarios.map((scenario) => `- \`${scenario.id}\` - ${scenario.title}`).join("\n")}

## Platform Inventory

${plan.targets
  .map(
    (target) => `- \`${target.platformTarget}\` - ${target.assetName}; launcher ${target.launcher}`,
  )
  .join("\n")}

## Fresh Install Artifacts

Use the latest files copied under \`artifacts/current/<target>/\` for the fresh install/manual
package-launch checks. For update UX checks, use the generated scenario scripts instead of your
real Keiko install.
`;
}

function writeScripts(outDir) {
  const scriptsDir = join(outDir, "scripts");
  ensureDir(scriptsDir);
  for (const target of PORTABLE_TARGETS) {
    for (const scenario of SCENARIOS) {
      writeShellScript(outDir, scriptsDir, target.platformTarget, scenario);
      writeCmdScript(outDir, scriptsDir, target.platformTarget, scenario);
    }
  }
}

function writeShellScript(outDir, scriptsDir, target, scenario) {
  const path = join(scriptsDir, scriptName(target, scenario, ".sh"));
  const reviewScript = join(repoRoot, "scripts", "portable-manual-review.mjs");
  const body = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'ROOT="$(cd "$(dirname "$0")/.." && pwd)"',
    `node ${shellQuote(reviewScript)} serve --out-dir "$ROOT" --target ${target} --scenario ${scenario} --open`,
    "",
  ].join("\n");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function writeCmdScript(outDir, scriptsDir, target, scenario) {
  const path = join(scriptsDir, scriptName(target, scenario, ".cmd"));
  const reviewScript = join(repoRoot, "scripts", "portable-manual-review.mjs");
  const body = [
    "@echo off",
    "setlocal",
    "set ROOT=%~dp0..",
    `node "${reviewScript}" serve --out-dir "%ROOT%" --target ${target} --scenario ${scenario} --open`,
    "",
  ].join("\r\n");
  writeFileSync(path, body);
}

function copyCurrentArtifacts(outDir) {
  const current = latestManualArtifactRoot();
  const copied = [];
  for (const target of PORTABLE_TARGETS) {
    const destination = join(outDir, "artifacts", "current", target.platformTarget);
    ensureDir(destination);
    const source = current === undefined ? undefined : findCurrentAsset(current, target);
    if (source !== undefined) {
      copyFileSync(source, join(destination, basename(source)));
      copied.push({ target: target.platformTarget, source: basename(source) });
      continue;
    }
    writeFileSync(join(destination, "README.md"), "No staged artifact was found locally.\n");
  }
  return copied;
}

function latestManualArtifactRoot() {
  const runtimeRoot = join(repoRoot, ".portable-runtime");
  if (!existsSync(runtimeRoot)) return undefined;
  const candidates = spawnSync("find", [runtimeRoot, "-maxdepth", "1", "-name", "manual-*"], {
    encoding: "utf8",
  });
  if (candidates.status !== 0) return undefined;
  return candidates.stdout.split(/\r?\n/u).filter(Boolean).sort().at(-1);
}

function findCurrentAsset(root, target) {
  const candidate = join(root, target.platformTarget, target.assetName);
  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : undefined;
}

function writePrepareEvidence(outDir, copiedArtifacts) {
  const evidence = {
    schemaVersion: 1,
    generatedAt: FIXED_NOW,
    copiedArtifacts,
    plan: "manual-review-plan.json",
    readme: "README.md",
  };
  const failures = findPortableMetadataRedactionFailures(evidence, "portableManualReviewPrepare");
  if (failures.length > 0)
    fail(`prepare evidence is not redacted:\n  - ${failures.join("\n  - ")}`);
  writeFileSync(join(outDir, "prepare-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

export function prepareManualReview(outDir = defaultOutDir()) {
  ensureDir(outDir);
  const plan = manualReviewPlan();
  writePlanJson(outDir, plan);
  writeReadme(outDir, plan);
  writeScripts(outDir);
  const copiedArtifacts = copyCurrentArtifacts(outDir);
  writePrepareEvidence(outDir, copiedArtifacts);
  return { outDir, plan };
}

export function targetRoot(reviewRoot, target, scenario) {
  const reviewId = createHash("sha256").update(resolve(reviewRoot)).digest("hex").slice(0, 12);
  return join(realpathSync(tmpdir()), "keiko-portable-manual-review", reviewId, target, scenario);
}

function setupManifest(target, version) {
  const runtime = targetByName(target);
  return {
    schemaVersion: 1,
    platformTarget: target,
    packageName: PACKAGE_NAME,
    packageVersion: version,
    stable: true,
    primaryLauncher: launcherName(target),
    bootstrapUpdateEligible: false,
    runtime: {
      nodePlatform: runtime.nodePlatform,
      nodeArchitecture: runtime.nodeArchitecture,
    },
  };
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeAppPackage(appRoot, version) {
  ensureDir(join(appRoot, "dist", "cli"));
  writeJson(join(appRoot, "package.json"), { name: PACKAGE_NAME, version });
  writeFileSync(join(appRoot, "dist", "cli", "index.js"), "console.log('Keiko fixture');\n");
}

function writeWindowsLayout(root, target, version, sidecar) {
  ensureDir(join(root, "runtime", "node"));
  ensureDir(join(root, ".portable"));
  ensureDir(join(root, "support"));
  writeAppPackage(join(root, "app"), version);
  writeFileSync(join(root, "runtime", "node", "node.exe"), "fixture node\n");
  writeFileSync(join(root, "Keiko.exe"), "fixture launcher\n");
  writeFileSync(join(root, "support", "keiko-support.cmd"), "@echo off\r\n");
  writeJson(join(root, ".portable", "setup-manifest.json"), setupManifest(target, version));
  writeSidecarPayload(root, target, sidecar);
}

function writeMacLayout(root, target, version, sidecar) {
  const bundle = join(root, "Keiko.app");
  const resources = join(bundle, "Contents", "Resources");
  ensureDir(join(bundle, "Contents", "MacOS"));
  ensureDir(join(resources, "runtime", "node", "bin"));
  ensureDir(join(resources, ".portable"));
  ensureDir(join(root, "support"));
  writeAppPackage(join(resources, "app"), version);
  writeFileSync(join(resources, "runtime", "node", "bin", "node"), "fixture node\n");
  writeFileSync(join(bundle, "Contents", "MacOS", "Keiko"), "fixture launcher\n");
  writeFileSync(join(resources, "Keiko.icns"), "icns fixture\n");
  writeFileSync(join(root, "support", "keiko-support.sh"), "#!/usr/bin/env sh\n");
  writeJson(join(resources, ".portable", "setup-manifest.json"), setupManifest(target, version));
  writeJson(join(bundle, "Contents", "Info.plist.json"), { CFBundleIconFile: "Keiko.icns" });
  writeSidecarPayload(resources, target, sidecar);
}

function writePortablePayload(root, target, version, sidecar = "absent") {
  const payloadRoot = join(root, "Keiko");
  if (target === "windows-x64") writeWindowsLayout(payloadRoot, target, version, sidecar);
  else writeMacLayout(payloadRoot, target, version, sidecar);
  return payloadRoot;
}

function writeManagedInstall(root, target, version) {
  const managedRoot = managedRootPath(root, target);
  rmSync(managedRoot, { recursive: true, force: true });
  if (target === "windows-x64") writeWindowsLayout(managedRoot, target, version, "absent");
  else writeMacLayout(dirname(managedRoot), target, version, "absent");
  return managedRoot;
}

function managedRootPath(root, target) {
  if (target === "windows-x64") return join(root, "managed", "Programs", "Keiko");
  return join(root, "managed", "Applications", "Keiko.app");
}

function packageRootFor(root, target) {
  const managedRoot = managedRootPath(root, target);
  if (target === "windows-x64") return join(managedRoot, "app");
  return join(managedRoot, "Contents", "Resources", "app");
}

function writeSidecarPayload(root, target, sidecar) {
  if (sidecar === "absent") return;
  const sidecarRoot = join(root, "runtime", "sidecars", "opencode-compatible");
  ensureDir(join(sidecarRoot, "evidence"));
  const executable = target === "windows-x64" ? "opencode.cmd" : join("bin", "opencode");
  ensureDir(dirname(join(sidecarRoot, executable)));
  writeFileSync(join(sidecarRoot, "LICENSE.txt"), "sidecar license\n");
  writeFileSync(join(sidecarRoot, "evidence", "sbom.cdx.json"), '{"bomFormat":"CycloneDX"}\n');
  writeFileSync(
    join(sidecarRoot, executable),
    target === "windows-x64" ? "@echo off\r\n" : "#!/bin/sh\n",
  );
}

function zipDirectory(sourceRoot, zipPath) {
  rmSync(zipPath, { force: true });
  const result = spawnSync("zip", ["-qr", "-D", zipPath, "Keiko"], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) fail(result.stderr || "zip command failed");
}

export function prepareScenarioFixture(root, target, scenario) {
  parseTarget(target);
  parseScenario(scenario);
  rmSync(root, { recursive: true, force: true });
  ensureDir(root);
  writeManagedInstall(root, target, CURRENT_VERSION);
  return createScenarioAssets(root, target, scenario);
}

function createHostileZip(workRoot, zipPath) {
  const parent = mkdtempSync(join(workRoot, "hostile-parent-"));
  const child = join(parent, "child");
  ensureDir(child);
  writeFileSync(join(parent, "evil.txt"), "hostile\n");
  const result = spawnSync("zip", ["-q", zipPath, "../evil.txt"], {
    cwd: child,
    encoding: "utf8",
  });
  if (result.status !== 0) fail(result.stderr || "hostile zip command failed");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileSize(path) {
  return statSync(path).size;
}

function sidecarFiles(target) {
  const executable = target === "windows-x64" ? "opencode.cmd" : "bin/opencode";
  return [
    { path: "LICENSE.txt", bytes: Buffer.from("sidecar license\n") },
    { path: "evidence/sbom.cdx.json", bytes: Buffer.from('{"bomFormat":"CycloneDX"}\n') },
    {
      path: executable,
      bytes: Buffer.from(target === "windows-x64" ? "@echo off\r\n" : "#!/bin/sh\n"),
    },
  ];
}

function treeDigest(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    hash.update(`${file.path}\0${createHash("sha256").update(file.bytes).digest("hex")}\0`);
  }
  return hash.digest("hex");
}

function sidecarRuntime(target, scenario) {
  if (scenario !== "sidecar-present" && scenario !== "sidecar-failure") return undefined;
  const files = sidecarFiles(target);
  const root = "runtime/sidecars/opencode-compatible";
  const runtime = {
    name: "opencode-compatible",
    kind: "coding-runtime",
    upstream: { name: "OpenCode-compatible", version: "1.0.0" },
    adapterCompatibility: {
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "1",
      protocolVersion: "coding-sidecar-v1",
    },
    platformTarget: target,
    payloadRootPath: root,
    executablePath: `${root}/${target === "windows-x64" ? "opencode.cmd" : "bin/opencode"}`,
    payloadSha256: scenario === "sidecar-failure" ? "9".repeat(64) : treeDigest(files),
    sizeBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    licenseEvidence: {
      path: `${root}/LICENSE.txt`,
      sha256: createHash("sha256").update(files[0].bytes).digest("hex"),
    },
    sbomEvidence: {
      path: `${root}/evidence/sbom.cdx.json`,
      sha256: createHash("sha256").update(files[1].bytes).digest("hex"),
    },
    signing: signingEvidence(target, true),
  };
  return runtime;
}

function signingEvidence(target, verified) {
  const macos = target !== "windows-x64";
  return {
    verificationPolicy: "production",
    verificationStatus: verified ? "verified-production" : "verification-failed",
    verificationReasonCodes: verified ? [] : ["manual-review-unsigned-fixture"],
    signatureKind: target === "windows-x64" ? "authenticode" : "developer-id-notarized",
    signatureVerified: verified,
    notarizationRequired: macos,
    notarizationVerified: macos && verified,
    verificationChecks:
      target === "windows-x64"
        ? { publisherChainVerified: verified, timestampVerified: verified }
        : {
            developerIdVerified: verified,
            notarizationVerified: verified,
            stapleVerified: verified,
            assessmentVerified: verified,
          },
  };
}

function releaseAsset(id, name, size) {
  return {
    id,
    name,
    size,
    browser_download_url: `https://github.com/oscharko-dev/keiko/releases/download/${RELEASE_TAG}/${name}`,
  };
}

function releaseJson(assets, targetVersion = TARGET_VERSION) {
  return {
    id: RELEASE_ID,
    tag_name: `v${targetVersion}`,
    name: `Keiko ${targetVersion}`,
    body: "- Portable manual review fixture.\n- One-click updater review path.",
    draft: false,
    prerelease: false,
    html_url: `https://github.com/oscharko-dev/Keiko/releases/tag/v${targetVersion}`,
    published_at: FIXED_NOW,
    assets,
  };
}

function fakeCatalog(remediationRequired) {
  const stateImpact = fakeStateImpact(remediationRequired);
  return {
    schemaVersion: 1,
    entries: [fakeCatalogEntry(remediationRequired, stateImpact)],
  };
}

function fakeStateImpact(remediationRequired) {
  if (!remediationRequired) return [];
  return [
    {
      store: "local-knowledge",
      description: "Local Knowledge vectors need reindexing after this update.",
      remediation: "local-knowledge-reindex-required",
      userActionRequired: true,
    },
  ];
}

function fakeCatalogEntry(remediationRequired, stateImpact) {
  return {
    id: `manual-review-${TARGET_VERSION}`,
    packageName: PACKAGE_NAME,
    packageVersion: TARGET_VERSION,
    distTag: "latest",
    registry: "https://registry.npmjs.org/",
    releaseTag: RELEASE_TAG,
    releaseNoteCategory: "new-additions",
    releaseNotePriority: remediationRequired ? "high" : "normal",
    userVisibleChange: "observable",
    userVisibleSummary: "Portable updater manual review fixture.",
    affectedStateStores: remediationRequired ? ["local-knowledge"] : [],
    stateImpact,
    userActionRequired: remediationRequired,
    remediation: remediationRequired ? "local-knowledge-reindex-required" : "no-action-required",
    supportedFrom: [CURRENT_VERSION],
    releaseNoteBullets: ["Portable updater manual review fixture."],
    internalOnly: false,
    observableImpact: true,
    defaultPatchNotes: true,
    oneClickEligible: true,
    publishGates: fakePublishGates(),
    review: fakeCatalogReview(),
  };
}

function fakePublishGates() {
  return [
    "version-consistency",
    "publish-manifests",
    "release-impact",
    "package-surface",
    "qi-supply-chain",
  ];
}

function fakeCatalogReview() {
  return {
    status: "reviewed",
    reviewer: "release-owner",
    reviewedAt: "2026-07-08",
    humanApproved: true,
    approvalReference: "github-pr-review:oscharko-dev/Keiko#2041#4907052948",
    rationale: "Manual review fixture for portable updater v2 UX validation.",
  };
}

function portableManifest(input) {
  const manifest = {
    schemaVersion: 1,
    product: { name: "Keiko", packageName: PACKAGE_NAME, packageVersion: input.targetVersion },
    release: portableManifestRelease(input.targetVersion),
    artifact: portableManifestArtifact(input),
    runtime: portableManifestRuntime(input.target),
    security: signingEvidence(input.target, input.signingVerified),
    updateEligibility: portableUpdateEligibility(),
    releaseImpact: {
      entryPackageVersion: input.targetVersion,
      entryReleaseTag: `v${input.targetVersion}`,
      reviewedBinding: reviewedBinding(input),
    },
  };
  if (input.sidecar !== undefined) {
    manifest.sidecarRuntimes = [input.sidecar];
    manifest.releaseImpact.reviewedBinding.sidecarRuntimes = [input.sidecar];
  }
  return manifest;
}

function portableManifestRelease(targetVersion) {
  return {
    releaseId: RELEASE_ID,
    releaseTag: `v${targetVersion}`,
    stable: true,
    commitSha: "a".repeat(40),
  };
}

function portableManifestArtifact(input) {
  return {
    platformTarget: input.target,
    assetId: input.archive.id,
    assetName: input.archive.name,
    archiveFormat: "zip",
    sizeBytes: input.archive.size,
    sha256: input.archiveSha,
  };
}

function portableManifestRuntime(target) {
  return {
    nodeVersion: "22.23.1",
    nodePlatform: targetByName(target).nodePlatform,
    nodeArchitecture: targetByName(target).nodeArchitecture,
    nodeDistribution: "official-nodejs-dist",
    nodeArchiveSha256: "b".repeat(64),
  };
}

function portableUpdateEligibility() {
  return {
    stableOnly: true,
    rollbackSupported: false,
    eligibleAfterSetupOnly: true,
    requiredPredicates: {
      managedRootAttested: true,
      artifactShaVerified: true,
      platformSignatureLocallyVerified: true,
      manifestReleaseImpactBound: true,
      sameVolumeCrashSafePromotionAvailable: true,
      relaunchVersionVerificationAvailable: true,
    },
  };
}

function reviewedBinding(input) {
  return {
    releaseId: RELEASE_ID,
    releaseTag: `v${input.targetVersion}`,
    assetId: input.archive.id,
    assetName: input.archive.name,
    assetSizeBytes: input.archive.size,
    platformTarget: input.target,
    packageVersion: input.targetVersion,
    archiveSha256: input.archiveSha,
    platformSignatureLocallyVerified: input.signingVerified,
  };
}

function createScenarioAssets(root, target, scenario) {
  const assetsRoot = join(root, "release-assets");
  const payloadRoot = join(root, "payload-source");
  ensureDir(assetsRoot);
  ensureDir(payloadRoot);
  const targetVersion = scenario === "current-release" ? CURRENT_VERSION : TARGET_VERSION;
  const archivePath = join(assetsRoot, assetName(target));
  if (scenario === "hostile-archive") createHostileZip(root, archivePath);
  else {
    writePortablePayload(payloadRoot, target, targetVersion, sidecarState(scenario));
    zipDirectory(payloadRoot, archivePath);
  }
  return createScenarioReleaseFiles(root, target, scenario, archivePath, targetVersion);
}

function sidecarState(scenario) {
  return scenario === "sidecar-present" || scenario === "sidecar-failure" ? "present" : "absent";
}

function createScenarioReleaseFiles(root, target, scenario, archivePath, targetVersion) {
  const archive = releaseAsset(100 + targetIndex(target), assetName(target), fileSize(archivePath));
  const archiveSha = sha256File(archivePath);
  const manifest = portableManifest({
    target,
    targetVersion,
    archive,
    archiveSha,
    signingVerified: scenario !== "missing-signing",
    sidecar: sidecarRuntime(target, scenario),
  });
  const manifestText =
    scenario === "bad-manifest"
      ? "{ malformed portable manifest\n"
      : `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestName = `${target}-portable-manifest.json`;
  const checksumName = `${target}-SHA256SUMS.txt`;
  const checksumSha = scenario === "bad-checksum" ? "0".repeat(64) : archiveSha;
  writeFileSync(join(root, "release-assets", manifestName), manifestText);
  writeFileSync(
    join(root, "release-assets", checksumName),
    `${checksumSha}  ${assetName(target)}\n`,
  );
  return releaseFixture(root, target, scenario, archive, manifestName, checksumName, targetVersion);
}

function releaseFixture(
  root,
  target,
  scenario,
  archive,
  manifestName,
  checksumName,
  targetVersion,
) {
  const assets = portableReleaseAssets(target, archive, manifestName, checksumName, root);
  const release = releaseJson(
    scenario === "missing-asset" ? assets.slice(1) : assets,
    targetVersion,
  );
  writeJson(join(root, "release-assets", "latest.json"), release);
  return { release, targetVersion };
}

function portableReleaseAssets(target, archive, manifestName, checksumName, root) {
  const archives = PORTABLE_TARGETS.map((item, index) =>
    item.platformTarget === target
      ? archive
      : releaseAsset(200 + index, item.assetName, 128_000 + index),
  );
  return [
    ...archives,
    releaseAsset(
      300 + targetIndex(target),
      manifestName,
      fileSize(join(root, "release-assets", manifestName)),
    ),
    releaseAsset(
      400 + targetIndex(target),
      checksumName,
      fileSize(join(root, "release-assets", checksumName)),
    ),
  ];
}

function targetIndex(target) {
  return PORTABLE_TARGETS.findIndex((item) => item.platformTarget === target);
}

function localFetchFor(root, scenario) {
  return async (url) => {
    if (scenario === "network-failure") return new Response("unavailable", { status: 503 });
    const parsed = new URL(String(url));
    if (parsed.hostname === "registry.npmjs.org") {
      return jsonResponse({ "dist-tags": { latest: TARGET_VERSION } });
    }
    if (parsed.hostname === "api.github.com") {
      return jsonResponse(
        JSON.parse(readFileSync(join(root, "release-assets", "latest.json"), "utf8")),
      );
    }
    const name = basename(parsed.pathname);
    const path = join(root, "release-assets", name);
    if (!existsSync(path)) return new Response("missing", { status: 404 });
    return new Response(readFileSync(path), { status: 200 });
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function portableMode(target, scenario, packageVersion = CURRENT_VERSION) {
  if (scenario === "legacy-package-manager") return legacyInstallMode();
  const portable = {
    status:
      scenario === "unmanaged-bootstrap"
        ? "bootstrap"
        : scenario === "system-managed"
          ? "it-managed"
          : "managed",
    target,
    updateEligible: scenario !== "unmanaged-bootstrap" && scenario !== "system-managed",
    packageVersion,
    stable: true,
    managedRootKind: scenario === "system-managed" ? "absolute-local" : "home-relative",
  };
  if (scenario === "unmanaged-bootstrap")
    return unsupportedPortableMode(portable, "portable-bootstrap");
  if (scenario === "system-managed")
    return unsupportedPortableMode(portable, "portable-it-managed");
  return {
    schemaVersion: "1",
    status: "supported",
    packageName: PACKAGE_NAME,
    installKind: "portable-managed",
    portable,
    recommendedAction: "portable-managed-update",
  };
}

function unsupportedPortableMode(portable, reason) {
  return {
    schemaVersion: "1",
    status: "unsupported",
    packageName: PACKAGE_NAME,
    installKind: reason === "portable-it-managed" ? "portable-it-managed" : "portable-bootstrap",
    portable,
    recommendedAction:
      reason === "portable-bootstrap" ? "portable-bootstrap-setup" : "manual-download",
    reason,
    manualInstructions:
      reason === "portable-bootstrap"
        ? "Run the portable setup flow from the Keiko launcher before using in-app updates."
        : "This Keiko install is managed outside the app and is not eligible for self-update.",
  };
}

function legacyInstallMode() {
  return {
    schemaVersion: "1",
    status: "supported",
    packageName: PACKAGE_NAME,
    installKind: "package-manager",
    packageManager: "npm",
    installRoot: join(repoRoot, "dist"),
    recommendedAction: "package-manager-maintenance",
    commandPreview: {
      executable: "npm",
      args: ["install", "--global", "--ignore-scripts", `${PACKAGE_NAME}@<target-version>`],
      label: `npm install --global --ignore-scripts ${PACKAGE_NAME}@<target-version>`,
    },
  };
}

function scenarioEnv(root, scenario) {
  return {
    HOME: join(root, "home"),
    KEIKO_STATE_DIR: join(root, "state"),
    KEIKO_UI_HOST: HOST,
    KEIKO_UPDATE_MUTATION_DISABLED: scenario === "policy-disabled" ? "true" : undefined,
  };
}

function scenarioFacts(root, target, scenario) {
  if (scenario === "legacy-package-manager") {
    return {
      packageName: PACKAGE_NAME,
      packageRoot: join(repoRoot, "dist"),
      installScope: "global",
      packageManagerHint: "npm",
    };
  }
  return {
    packageName: PACKAGE_NAME,
    packageRoot: packageRootFor(root, target),
    portableStateDir: join(root, "state"),
  };
}

function makeRemediationManager(server, scenario, localState) {
  if (scenario !== "remediation-required")
    return server.createUpdateRemediationManager({ localState });
  let completed = false;
  return {
    getStatus: (request = {}) =>
      remediationReport(request.targetVersion ?? TARGET_VERSION, completed),
    completeRestart: (targetVersion = TARGET_VERSION) =>
      remediationReport(targetVersion, completed),
    updateCanComplete: () => completed,
    runAction: (request = {}) => {
      completed = true;
      return remediationReport(request.targetVersion ?? TARGET_VERSION, completed);
    },
  };
}

function remediationReport(targetVersion, completed) {
  return {
    schemaVersion: 1,
    checkedAt: FIXED_NOW,
    targetVersion,
    overallStatus: completed ? "completed" : "pending",
    updateCanComplete: completed,
    actions: [
      {
        actionId: "local-knowledge-reindex:local-knowledge",
        kind: "local-knowledge-reindex",
        store: "local-knowledge",
        remediation: "local-knowledge-reindex-required",
        status: completed ? "completed" : "pending",
        required: true,
        canRun: !completed,
        canDefer: false,
        userApprovalRequired: true,
        featureIds: ["local-knowledge"],
        scopeCounts: { stores: 1, artifacts: 1, retainedEntries: 1, capsules: 1 },
        message: completed ? "Local Knowledge reindex completed." : "Reindex Local Knowledge.",
      },
    ],
    affectedFeatures: [
      {
        featureId: "local-knowledge",
        label: "Local Knowledge",
        state: completed ? "ready" : "degraded",
        reason: completed
          ? "Local Knowledge is current for this update."
          : "Vectors need reindexing before search is fully current.",
        actionIds: ["local-knowledge-reindex:local-knowledge"],
      },
    ],
    warnings: [],
  };
}

async function loadServerModules() {
  const base = join(repoRoot, "packages", "keiko-server", "dist");
  return {
    server: await import(pathToFileURL(join(base, "index.js")).href),
    stager: await import(pathToFileURL(join(base, "update-portable-staging.js")).href),
    activator: await import(pathToFileURL(join(base, "update-portable-activation.js")).href),
  };
}

function ensureBuildOutputs() {
  if (!existsSync(join(repoRoot, "packages", "keiko-server", "dist", "index.js"))) {
    fail("run npm run build:packages before serve");
  }
  if (!existsSync(join(repoRoot, "dist", "ui", "static", "index.html"))) {
    fail("run npm run build:ui before serve");
  }
}

function fakeChild() {
  return { unref: () => undefined };
}

function commandSuccess() {
  return Promise.resolve({
    command: "npm",
    args: ["install", "--global", "--ignore-scripts", `${PACKAGE_NAME}@${TARGET_VERSION}`],
    exitCode: 0,
    signal: null,
    stdout: "updated package-manager fixture\n",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
  });
}

function resolveScenarioMode(input) {
  return typeof input.mode === "function" ? input.mode() : input.mode;
}

function updateSession(server, stager, activator, input) {
  const portable = resolveScenarioMode(input).installKind === "portable-managed";
  return server.createUpdateSessionManager({
    processEnv: input.env,
    detector: () => resolveScenarioMode(input),
    facts: () => input.facts,
    currentVersion: () => input.runningVersion.value,
    idFactory: () => `manual-review-${input.scenario}-${input.target}`,
    now: () => Date.parse(FIXED_NOW),
    runCommandImpl: commandSuccess,
    portableStager: portable
      ? stager.createPortableUpdateStager({
          env: input.env,
          localState: input.localState,
          fetchImpl: input.fetchImpl,
          platformVerifier: () => Promise.resolve(),
        })
      : undefined,
    portableActivator: portable
      ? activator.createPortableUpdateActivator({
          env: input.env,
          localState: input.localState,
          homedir: () => input.env.HOME,
          spawnFn: () => fakeChild(),
          versionVerifier: () => {
            const verified = input.scenario !== "hostile-archive";
            if (verified) input.runningVersion.value = TARGET_VERSION;
            return Promise.resolve(verified);
          },
        })
      : undefined,
    portableCompletionGate: () => input.remediation.updateCanComplete(TARGET_VERSION),
    redactor: (value) => value,
  });
}

async function startScenarioServer(options) {
  ensureBuildOutputs();
  const target = options.target;
  const scenario = options.scenario;
  const root = targetRoot(options.outDir, target, scenario);
  prepareScenarioFixture(root, target, scenario);
  const modules = await loadServerModules();
  const env = scenarioEnv(root, scenario);
  const runningVersion = { value: CURRENT_VERSION };
  const mode = () => portableMode(target, scenario, runningVersion.value);
  const facts = scenarioFacts(root, target, scenario);
  const fetchImpl = localFetchFor(root, scenario);
  const localState = modules.server.createUpdateLocalStateManager({
    stateDir: env.KEIKO_STATE_DIR,
  });
  const remediation = makeRemediationManager(modules.server, scenario, localState);
  const session = updateSession(modules.server, modules.stager, modules.activator, {
    env,
    facts,
    fetchImpl,
    localState,
    mode,
    remediation,
    runningVersion,
    scenario,
    target,
  });
  return listenScenario(modules.server, {
    env,
    fetchImpl,
    localState,
    mode,
    open: options.open,
    remediation,
    root,
    runningVersion,
    scenario,
    session,
    target,
    port: options.port ?? DEFAULT_PORT,
  });
}

async function listenScenario(server, input) {
  const staticRoot = join(repoRoot, "dist", "ui", "static");
  const csp = await server.loadCspHeader(join(repoRoot, "dist", "ui", "csp-hashes.json"));
  const preflight = server.createUpdatePreflightService({
    currentVersion: () => input.runningVersion.value,
    bundledCatalog: fakeCatalog(input.scenario === "remediation-required"),
    installMode: () => resolveScenarioMode(input),
  });
  const deps = server.buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(input.root, "evidence"),
    env: input.env,
    uiDbPath: join(input.root, "ui.db"),
    modelPortFactory: () => undefined,
    updateLocalState: input.localState,
    updatePreflight: preflight,
    updateRemediation: input.remediation,
    updateSession: input.session,
  });
  deps.gatewayReadinessFetch = input.fetchImpl;
  const httpServer = server.createUiServer({
    staticRoot,
    csp,
    port: input.port,
    handlerDeps: deps,
  });
  await listen(httpServer, input.port);
  const url = `http://${HOST}:${String(input.port)}`;
  writeScenarioReceipt(input.root, input, url);
  openBrowserIfRequested(url, input.open);
  console.log(`portable-manual-review: ${input.target}/${input.scenario}`);
  console.log(`URL: ${url}`);
  console.log(`Scenario root: ${input.root}`);
  console.log("Press Ctrl-C to stop this scenario.");
  await waitForShutdown(httpServer, deps);
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function waitForShutdown(server, deps) {
  return new Promise((resolveShutdown) => {
    const stop = () => {
      server.close(() => {
        deps.dispose?.();
        resolveShutdown();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function writeScenarioReceipt(root, input, url) {
  writeJson(join(root, "scenario.json"), {
    schemaVersion: 1,
    generatedAt: FIXED_NOW,
    target: input.target,
    scenario: input.scenario,
    url,
    managedRoot: "<scenario-managed-root>",
    stateDir: "<scenario-state-dir>",
  });
}

function openBrowserIfRequested(url, open) {
  if (!open) return;
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawnSync(command, args, { stdio: "ignore", detached: true });
}

export async function runPortableManualReview(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const outDir = options.outDir ?? defaultOutDir();
  if (options.command === "prepare") {
    const result = prepareManualReview(outDir);
    console.log(`portable-manual-review: prepared ${result.outDir}`);
    console.log(`Open ${join(result.outDir, "README.md")}`);
    return result;
  }
  return startScenarioServer({ ...options, outDir });
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runPortableManualReview();
}
