import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { PORTABLE_TARGETS, validatePortableManifest } from "./portable-runtime.mjs";

function fail(message) {
  throw new Error(`portable launch/setup smoke failed: ${message}`);
}

function assertFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`missing ${label}`);
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

function validateStageTarget(stageRoot, target) {
  const targetRoot = join(stageRoot, target.platformTarget);
  const manifestPath = join(targetRoot, "manifest", "portable-manifest.json");
  const layout = payloadLayout(target, join(targetRoot, "payload", "Keiko"));
  assertFile(join(targetRoot, target.assetName), `${target.platformTarget} archive`);
  assertFile(manifestPath, `${target.platformTarget} portable manifest`);
  for (const [label, path] of Object.entries(layout))
    assertFile(path, `${target.platformTarget} ${label}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const failures = validatePortableManifest(manifest, { allowUnverified: true });
  if (failures.length > 0)
    fail(`${target.platformTarget} manifest invalid:\n  - ${failures.join("\n  - ")}`);
  validateSetupManifest(layout.setupManifest, target);
  return stageEvidence(target, manifest);
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
  if (!existsSync(stageRoot) || !statSync(stageRoot).isDirectory())
    fail("stage root is not a directory");
  return PORTABLE_TARGETS.map((target) => validateStageTarget(stageRoot, target));
}
