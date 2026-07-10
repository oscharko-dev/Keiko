#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { inventoryMacPortableCode } from "./macos-portable-inventory.mjs";
import {
  assertContainedPath,
  portableTargetByName,
  portableVerificationSummaryForManifest,
  readPortableManifest,
  sha256File,
  validatePortableManifest,
} from "./portable-runtime.mjs";

const TARGETS = new Set(["macos-arm64", "macos-x64"]);

export class IsolatedMacSmokeError extends Error {}

function fail(message) {
  throw new IsolatedMacSmokeError(`isolated-macos-smoke: ${message}`);
}

function parse(argv) {
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

function assertRegularUnlinkedFile(path) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
    fail("artifact contains an unsafe file");
}

function assertVerifiedManifest(manifest, target) {
  const descriptor = portableTargetByName(target);
  if (!TARGETS.has(target) || descriptor === undefined) fail("target is invalid");
  if (manifest.artifact?.platformTarget !== target) fail("manifest target is invalid");
  if (manifest.artifact.assetName !== descriptor.assetName) fail("manifest asset is invalid");
  if (validatePortableManifest(manifest).length > 0) fail("manifest is invalid");
  if (manifest.security?.verificationStatus !== "verified-production")
    fail("artifact is not verified production");
}

function assertSummary(artifactRoot, manifest) {
  const path = join(artifactRoot, "evidence", "signing-verification.json");
  assertRegularUnlinkedFile(path);
  const actual = JSON.parse(readFileSync(path, "utf8"));
  const expected = portableVerificationSummaryForManifest(manifest);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("signing summary is invalid");
}

async function assertArchive(artifactRoot, manifest) {
  const archive = join(artifactRoot, manifest.artifact.assetName);
  assertRegularUnlinkedFile(archive);
  const digest = await sha256File(archive);
  if (digest !== manifest.artifact.sha256) fail("archive digest is invalid");
  const checksumPath = join(artifactRoot, "evidence", "SHA256SUMS.txt");
  assertRegularUnlinkedFile(checksumPath);
  const checksum = readFileSync(checksumPath, "utf8");
  if (checksum !== `${digest}  ${manifest.artifact.assetName}\n`)
    fail("archive checksum evidence is invalid");
  return archive;
}

function safeDisposableRoot(disposableRoot, runnerTemp) {
  const runner = resolve(runnerTemp);
  const disposable = assertContainedPath(runner, resolve(disposableRoot));
  if (disposable === runner || !disposable.startsWith(`${runner}/keiko-isolated-macos-smoke-`))
    fail("disposable root is invalid");
  return disposable;
}

function extractWithDitto(archive, disposable) {
  const result = spawnSync("ditto", ["-x", "-k", archive, disposable], { stdio: "ignore" });
  if (result.error !== undefined || result.status !== 0) fail("archive extraction failed");
}

function extractArchive(archive, disposable, extractor) {
  rmSync(disposable, { force: true, recursive: true });
  mkdirSync(disposable, { mode: 0o700, recursive: true });
  extractor(archive, disposable);
}

function assertExecutableLayout(disposable, manifest, target) {
  const payload = join(disposable, "Keiko");
  inventoryMacPortableCode(payload, target);
  const resources = join(payload, "Keiko.app", "Contents", "Resources");
  assertRegularUnlinkedFile(join(resources, "runtime", "node", "bin", "node"));
  for (const sidecar of manifest.sidecarRuntimes ?? []) {
    const executable = assertContainedPath(resources, join(resources, sidecar.executablePath));
    assertRegularUnlinkedFile(executable);
  }
  const plan = {
    schemaVersion: 1,
    sidecarExecutables: (manifest.sidecarRuntimes ?? []).map((sidecar) => sidecar.executablePath),
    target,
  };
  const planPath = join(disposable, "smoke-plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
}

export async function prepareIsolatedMacSmoke(options) {
  const target = required(options, "target");
  const artifactRoot = resolve(required(options, "artifact-root"));
  const disposable = safeDisposableRoot(
    required(options, "disposable-root"),
    required(options, "runner-temp"),
  );
  const manifestPath = join(artifactRoot, "manifest", "portable-manifest.json");
  assertRegularUnlinkedFile(manifestPath);
  const manifest = readPortableManifest(manifestPath);
  assertVerifiedManifest(manifest, target);
  assertSummary(artifactRoot, manifest);
  const archive = await assertArchive(artifactRoot, manifest);
  const extractor = typeof options.extractor === "function" ? options.extractor : extractWithDitto;
  extractArchive(archive, disposable, extractor);
  assertExecutableLayout(disposable, manifest, target);
  if (!existsSync(join(disposable, "smoke-plan.json"))) fail("smoke plan is missing");
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  if (command !== "prepare") fail("unsupported command");
  await prepareIsolatedMacSmoke(options);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof IsolatedMacSmokeError
        ? error.message
        : "isolated-macos-smoke: redacted failure",
    );
    process.exit(1);
  }
}
