// Functional smoke of the pinned ripgrep executable inside a staged portable payload (Epic #3897).
//
// The USearch smoke loads the shipped addon and runs one search; this is its counterpart for the
// OpenCode runtime's search dependency. It proves, against the exact staged tree, that the manifest
// binds the approved release, that the shipped bytes and license are the pinned ones (or, after a
// verified platform signature, the bytes the manifest binds), that the evidence names the tool, and
// that the executable actually starts and finds text - with the PATH and the user's ripgrep
// configuration out of the picture, so a developer's own `rg` can never mask a broken payload.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { URL, fileURLToPath } from "node:url";

import {
  RIPGREP_PORTABLE_LICENSE_PATH,
  ripgrepPortableExecutablePath,
} from "../packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts";
import { portableTargetByName, ripgrepApprovalForPortableTarget } from "./portable-runtime.mjs";
import { portableResourceRoot } from "./portable-signed-archive.mjs";

const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_NATIVE_BINARY_BYTES = 128 * 1024 * 1024;
const RUN_TIMEOUT_MS = 20_000;
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function fail(message) {
  throw new Error(`portable-ripgrep-smoke: ${message}`);
}

export function governedStageRoot(targetName) {
  // Derived from the producer, never restated: only a declared portable target can reach join().
  if (portableTargetByName(targetName) === undefined) fail("platform target is unsupported");
  return join(REPOSITORY_ROOT, ".portable-runtime", "staging", targetName);
}

export function requiredStageRoot(value) {
  const root = resolve(value);
  const entry = lstatSync(root, { throwIfNoEntry: false });
  if (entry === undefined) fail("stage root is missing");
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail("stage root is unsafe");
  return realpathSync(root);
}

function assertContained(stageRoot, candidate, label) {
  const stageRelative = relative(stageRoot, candidate);
  if (stageRelative === ".." || stageRelative.startsWith(`..${sep}`) || isAbsolute(stageRelative)) {
    fail(`unsafe ${label}`);
  }
}

export function containedDigest(stageRoot, candidate, label, maxBytes) {
  const absolute = resolve(candidate);
  assertContained(stageRoot, absolute, label);
  const entry = lstatSync(absolute, { throwIfNoEntry: false });
  if (entry === undefined) fail(`missing ${label}`);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) fail(`unsafe ${label}`);
  if (entry.size <= 0 || entry.size > maxBytes) fail(`${label} has an invalid bounded size`);
  const canonical = realpathSync(absolute);
  assertContained(stageRoot, canonical, label);
  return {
    path: canonical,
    sha256: createHash("sha256").update(readFileSync(canonical)).digest("hex"),
  };
}

function readContainedText(stageRoot, candidate, label) {
  return readFileSync(
    containedDigest(stageRoot, candidate, label, MAX_EVIDENCE_BYTES).path,
    "utf8",
  );
}

function toolFrom(manifest, targetName, approval) {
  if (!Array.isArray(manifest.nativeTools) || manifest.nativeTools.length !== 1) {
    fail("manifest must bind exactly one native tool");
  }
  const tool = manifest.nativeTools[0];
  if (
    tool.name !== "ripgrep" ||
    tool.kind !== "native-tool" ||
    tool.version !== approval.version ||
    tool.platformTarget !== targetName ||
    tool.executablePath !== ripgrepPortableExecutablePath(approval.targetKey) ||
    tool.licensePath !== RIPGREP_PORTABLE_LICENSE_PATH ||
    tool.unsignedSha256 !== approval.binarySha256
  ) {
    fail("manifest native tool identity is invalid");
  }
  return tool;
}

function hasVerifiedProductionSignature(manifest, tool) {
  return (
    manifest.security?.verificationStatus === "verified-production" &&
    manifest.security?.signatureVerified === true &&
    tool.signing?.verificationStatus === "verified-production" &&
    tool.signing?.signatureVerified === true
  );
}

function assertShippedFiles(stageRoot, manifest, targetName, tool, approval) {
  const root = portableResourceRoot(stageRoot, targetName, manifest);
  const binary = containedDigest(
    stageRoot,
    join(root, ...tool.executablePath.split("/")),
    "shipped ripgrep executable",
    MAX_NATIVE_BINARY_BYTES,
  );
  const license = containedDigest(
    stageRoot,
    join(root, ...tool.licensePath.split("/")),
    "shipped ripgrep license",
    MAX_EVIDENCE_BYTES,
  );
  if (binary.sha256 !== tool.shippedSha256) fail("shipped ripgrep executable digest mismatch");
  // Platform signing rewrites executable bytes. Before that boundary the bytes bind directly to the
  // immutable upstream digest; after it, the platform verifier and the verified-production manifest
  // state are the anchor while shippedSha256 keeps binding the file that will run.
  if (!hasVerifiedProductionSignature(manifest, tool) && binary.sha256 !== approval.binarySha256) {
    fail("staged ripgrep executable digest is not approved");
  }
  if (license.sha256 !== approval.licenseSha256) fail("shipped ripgrep license digest mismatch");
  return binary.path;
}

function assertEvidence(stageRoot, tool, approval) {
  const sbom = JSON.parse(
    readContainedText(stageRoot, join(stageRoot, "evidence", "sbom.cdx.json"), "portable SBOM"),
  );
  const matches = (sbom.components ?? []).filter(
    (component) => component?.["bom-ref"] === tool.sbomBomRef,
  );
  const bound = matches[0]?.hashes?.some(
    (hash) => hash?.alg === "SHA-256" && hash.content === tool.shippedSha256,
  );
  if (matches.length !== 1 || bound !== true) fail("SBOM does not bind the shipped native tool");
  const notices = readContainedText(
    stageRoot,
    join(stageRoot, "evidence", "third-party-notices.txt"),
    "portable third-party notices",
  );
  if (!notices.includes(`ripgrep ${approval.version}`)) {
    fail("third-party notice does not identify ripgrep");
  }
}

// Fresh, empty, private environment: no PATH, no inherited ripgrep configuration, no user profile.
function smokeEnvironment() {
  const { SystemRoot } = process.env;
  return SystemRoot === undefined ? {} : { SystemRoot };
}

function execute(binaryPath, args, cwd) {
  const result = spawnSync(binaryPath, args, {
    cwd,
    encoding: "utf8",
    env: smokeEnvironment(),
    maxBuffer: 1024 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: RUN_TIMEOUT_MS,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? "", error: result.error };
}

function assertApprovedRelease(version, approval) {
  if (version.error !== undefined) {
    fail(`executable did not run: ${String(version.error.code ?? "unknown")}`);
  }
  const revision = approval.sourceCommit.slice(0, 10);
  if (
    version.status !== 0 ||
    !version.stdout.startsWith(`ripgrep ${approval.version} `) ||
    !version.stdout.includes(`rev ${revision}`)
  ) {
    fail("executable does not report the approved ripgrep release");
  }
}

function assertSearches(binaryPath, fixture, run) {
  const common = ["--no-config", "--no-ignore"];
  const hit = run(binaryPath, [...common, "-n", "--no-heading", "needle", "."], fixture);
  if (hit.status !== 0 || !hit.stdout.includes("needle beta")) fail("search did not find text");
  const listing = run(binaryPath, [...common, "--files"], fixture);
  const names = listing.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (listing.status !== 0 || names.length !== 2) fail("file listing is incomplete");
  const miss = run(binaryPath, [...common, "absent-pattern", "."], fixture);
  if (miss.status !== 1) fail("a search without a match must exit 1");
}

/**
 * Starts the executable, checks it is the pinned release, and makes it search a fixture tree: one
 * match, one file listing and one miss, so exit codes, output and file discovery are all real.
 */
export function startAndSearch(binaryPath, approval, run = execute) {
  const fixture = mkdtempSync(join(tmpdir(), "keiko-ripgrep-smoke-"));
  try {
    mkdirSync(join(fixture, "src"));
    writeFileSync(join(fixture, "src", "a.txt"), "alpha\nneedle beta\n");
    writeFileSync(join(fixture, "b.txt"), "gamma\n");
    assertApprovedRelease(run(binaryPath, ["--no-config", "--version"], fixture), approval);
    assertSearches(binaryPath, fixture, run);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

export function smokePortableRipgrep(stageRootValue, targetName, options = {}) {
  const run = options.run ?? execute;
  const stageRoot = requiredStageRoot(stageRootValue);
  const target = portableTargetByName(targetName);
  if (target === undefined) fail("platform target is unsupported");
  const manifest = JSON.parse(
    readContainedText(
      stageRoot,
      join(stageRoot, "manifest", "portable-manifest.json"),
      "portable manifest",
    ),
  );
  if (manifest.artifact?.platformTarget !== targetName) fail("manifest target mismatch");
  const approval = options.approval ?? ripgrepApprovalForPortableTarget(target);
  if (approval === undefined) fail("manifest upstream digest is not approved");
  const tool = toolFrom(manifest, targetName, approval);
  const binaryPath = assertShippedFiles(stageRoot, manifest, targetName, tool, approval);
  assertEvidence(stageRoot, tool, approval);
  startAndSearch(binaryPath, approval, run);
}

function requireArgument(argv, index, name) {
  const value = argv[index];
  if (value === undefined || value.length === 0) fail(`${name} is required`);
  return value;
}

/**
 * `node scripts/smoke-portable-ripgrep.mjs <stage root> <platform target>`. The stage root must be
 * the governed `.portable-runtime/staging/<target>` of a declared portable target, so a typo or a
 * hostile argument cannot point the smoke at an arbitrary tree.
 */
export function runPortableRipgrepSmokeCli(
  argv = process.argv,
  { smoke = smokePortableRipgrep, log = console.log } = {},
) {
  const targetName = requireArgument(argv, 3, "platform target");
  const expected = governedStageRoot(targetName);
  const supplied = requireArgument(argv, 2, "stage root");
  const candidate = isAbsolute(supplied) ? resolve(supplied) : resolve(REPOSITORY_ROOT, supplied);
  if (candidate !== expected) fail("stage root argument does not match the governed target");
  smoke(expected, targetName);
  log(`portable-ripgrep-smoke: PASS ${targetName}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPortableRipgrepSmokeCli();
}
