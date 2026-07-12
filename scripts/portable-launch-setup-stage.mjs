import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  PORTABLE_TARGETS,
  validatePortableCandidateManifest,
  validatePortableStagingManifest,
} from "./portable-runtime.mjs";

function fail(message) {
  throw new Error(`portable launch/setup smoke failed: ${message}`);
}

function assertFile(path, label) {
  if (!existsSync(path)) fail(`missing ${label}`);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) fail(`unsafe ${label}`);
}

function supportLauncher(target) {
  return target.nodePlatform === "win32" ? "support/keiko-support.cmd" : "support/keiko-support.sh";
}

function payloadLayout(target, payloadRoot) {
  if (target.nodePlatform === "win32") {
    return {
      packageJson: join(payloadRoot, "app", "package.json"),
      primaryLauncher: join(payloadRoot, "Keiko.exe"),
      runtimeNode: join(payloadRoot, "runtime", "node", "node.exe"),
      setupManifest: join(payloadRoot, ".portable", "setup-manifest.json"),
      supportLauncher: join(payloadRoot, "support", "keiko-support.cmd"),
    };
  }
  const resources = join(payloadRoot, "Keiko.app", "Contents", "Resources");
  return {
    packageJson: join(resources, "app", "package.json"),
    primaryLauncher: join(payloadRoot, "Keiko.app", "Contents", "MacOS", "Keiko"),
    runtimeNode: join(resources, "runtime", "node", "bin", "node"),
    setupManifest: join(resources, ".portable", "setup-manifest.json"),
    supportLauncher: join(payloadRoot, "support", "keiko-support.sh"),
  };
}

function validateSetupManifest(path, target) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.platformTarget !== target.platformTarget)
    fail(`${target.platformTarget} setup target mismatch`);
  if (manifest.primaryLauncher !== target.primaryLauncher)
    fail(`${target.platformTarget} launcher mismatch`);
  if (manifest.bootstrapUpdateEligible !== false)
    fail(`${target.platformTarget} bootstrap update must be false`);
  if (manifest.runtime?.nodePlatform !== target.nodePlatform)
    fail(`${target.platformTarget} runtime platform mismatch`);
  if (manifest.runtime?.nodeArchitecture !== target.nodeArchitecture)
    fail(`${target.platformTarget} runtime arch mismatch`);
  if (manifest.stable !== true) fail(`${target.platformTarget} setup manifest must be stable`);
}

function validateTargetRoot(targetRoot, target, options) {
  const manifestPath = join(targetRoot, "manifest", "portable-manifest.json");
  const layout = payloadLayout(target, join(targetRoot, "payload", "Keiko"));
  assertFile(join(targetRoot, target.assetName), `${target.platformTarget} archive`);
  assertFile(manifestPath, `${target.platformTarget} portable manifest`);
  for (const [label, path] of Object.entries(layout))
    assertFile(path, `${target.platformTarget} ${label}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const failures =
    options.context === "candidate"
      ? validatePortableCandidateManifest(manifest)
      : validatePortableStagingManifest(manifest);
  if (failures.length > 0)
    fail(`${target.platformTarget} manifest invalid:\n  - ${failures.join("\n  - ")}`);
  validateSetupManifest(layout.setupManifest, target);
  return stageEvidence(target, manifest);
}

export function validatePortableTargetRoot(targetRoot, targetName, options = {}) {
  if (!existsSync(targetRoot)) fail("target root is not a directory");
  const rootEntry = lstatSync(targetRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink())
    fail("target root is not a directory");
  const target = PORTABLE_TARGETS.find((candidate) => candidate.platformTarget === targetName);
  if (target === undefined) fail(`unknown stage target ${targetName}`);
  return validateTargetRoot(targetRoot, target, options);
}

function stageEvidence(target, manifest) {
  return {
    platformTarget: target.platformTarget,
    assetName: target.assetName,
    primaryLauncher: target.primaryLauncher,
    supportLauncher: supportLauncher(target),
    bundledRuntimePresent: true,
    manifestValidated: true,
    signatureStatus: manifest.security?.verificationStatus,
  };
}

export function validateStageRoot(stageRoot) {
  return validateStageTargets(
    stageRoot,
    PORTABLE_TARGETS.map((target) => target.platformTarget),
  );
}

export function validateStageTargets(stageRoot, targetNames) {
  if (!existsSync(stageRoot) || !statSync(stageRoot).isDirectory())
    fail("stage root is not a directory");
  if (targetNames.length === 0) fail("at least one stage target is required");
  return targetNames.map((name) => {
    return validatePortableTargetRoot(join(stageRoot, name), name, { context: "staging" });
  });
}
