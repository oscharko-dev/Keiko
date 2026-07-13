import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findPortableMetadataRedactionFailures, hashDirectoryTree } from "./portable-runtime.mjs";

const TARGETS = new Set(["windows-x64", "macos-arm64", "macos-x64"]);
const RECEIPT_NAME = "runtime-supervisor-qualification.json";
const repoRoot = resolve(import.meta.dirname, "..");

function fail(message) {
  throw new Error(`runtime-supervisor-qualification: ${message}`);
}

function parseArgs(argv) {
  const options = { expectUnavailable: false, stageRoot: "", target: "", verifyExisting: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--expect-unavailable") {
      options.expectUnavailable = true;
      continue;
    }
    if (arg === "--verify-existing") {
      options.verifyExisting = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) fail(`${arg} requires a value`);
    if (arg === "--stage-root") options.stageRoot = resolve(value);
    else if (arg === "--target") options.target = value;
    else fail(`unsupported argument ${arg}`);
    index += 1;
  }
  if (!TARGETS.has(options.target)) fail("--target is unsupported");
  if (!isAbsolute(options.stageRoot)) fail("--stage-root must be absolute");
  return options;
}

function stagePaths(stageRoot, target) {
  const root = join(stageRoot, target);
  const resourceRoot =
    target === "windows-x64"
      ? join(root, "payload", "Keiko")
      : join(root, "payload", "Keiko", "Keiko.app", "Contents", "Resources");
  return {
    artifact: join(
      root,
      target === "windows-x64" ? "keiko-windows-x64.zip" : `keiko-${target}.zip`,
    ),
    helper: join(resourceRoot, "runtime", "native", "keiko-runtime-supervisor.exe"),
    manifest: join(root, "manifest", "portable-manifest.json"),
    receipt: join(root, "evidence", RECEIPT_NAME),
    resourceRoot,
  };
}

export function createRuntimeSupervisorQualificationReceipt(paths, target) {
  if (target !== "windows-x64") fail("only windows-x64 has a qualified native backend");
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
  if (manifest.artifact?.platformTarget !== target) fail("manifest target does not match");
  const artifactSha256 = sha256File(paths.artifact);
  if (manifest.artifact?.sha256 !== artifactSha256) fail("artifact bytes do not match manifest");
  if (!existsSync(paths.helper) || !statSync(paths.helper).isFile())
    fail("signed helper is missing");
  const receipt = {
    schemaVersion: 1,
    suiteVersion: "runtime-tree-qualification-v1",
    platformTarget: target,
    sourceCommitSha: manifest.release?.commitSha,
    artifactSha256,
    helperSha256: sha256File(paths.helper),
    sidecars: sidecarDigests(manifest, paths.resourceRoot),
    backend: "windows-job-object",
    result: "passed",
  };
  const redactionFailures = findPortableMetadataRedactionFailures(receipt, "qualificationReceipt");
  if (redactionFailures.length > 0) fail("receipt is not content-free");
  return receipt;
}

export function runtimeSupervisorQualificationReceiptBytes(paths, target) {
  return `${JSON.stringify(createRuntimeSupervisorQualificationReceipt(paths, target), null, 2)}\n`;
}

function sidecarDigests(manifest, resourceRoot) {
  if (!Array.isArray(manifest.sidecarRuntimes)) return [];
  return manifest.sidecarRuntimes
    .map((sidecar) => {
      const root = join(resourceRoot, ...sidecar.payloadRootPath.split("/"));
      const sha256 = hashDirectoryTree(root);
      if (sha256 !== sidecar.payloadSha256) fail("sidecar bytes do not match manifest");
      return { name: sidecar.name, sha256 };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runWindowsQualification(helper) {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "native", "runtime-supervisor", "test-protocol.mjs"), "--helper", helper],
    { cwd: repoRoot, env: process.env, stdio: "inherit" },
  );
  if (result.status !== 0) fail("native descendant/revoke/reap suite failed");
}

export function qualifyRuntimeSupervisor(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const paths = stagePaths(options.stageRoot, options.target);
  if (options.expectUnavailable) {
    if (options.target === "windows-x64") fail("windows-x64 cannot be marked unavailable here");
    if (existsSync(paths.helper)) fail("macOS artifact must not stage an unqualified helper");
    rmSync(paths.receipt, { force: true });
    return { status: "unavailable", target: options.target };
  }
  runWindowsQualification(paths.helper);
  const receiptBytes = runtimeSupervisorQualificationReceiptBytes(paths, options.target);
  if (options.verifyExisting) {
    if (!existsSync(paths.receipt) || readFileSync(paths.receipt, "utf8") !== receiptBytes) {
      fail("existing receipt does not match current signed bytes");
    }
  } else {
    writeFileSync(paths.receipt, receiptBytes, { flag: "wx" });
  }
  return { status: "passed", target: options.target };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = qualifyRuntimeSupervisor();
    console.log(`runtime-supervisor-qualification: ${result.status} ${result.target}`);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "runtime-supervisor-qualification: failed",
    );
    process.exit(1);
  }
}
