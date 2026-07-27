import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { URL, fileURLToPath } from "node:url";

import {
  USEARCH_RUNTIME_MANIFEST,
  usearchRuntimeTargetKey,
} from "../packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts";
import { portableTargetByName } from "./portable-runtime.mjs";

const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_NATIVE_BINARY_BYTES = 128 * 1024 * 1024;
const USEARCH_BINARY_PATH = "runtime/native/usearch.node";
const USEARCH_LICENSE_PATH = "runtime/licenses/usearch/LICENSE";
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function fail(message) {
  throw new Error(`portable-usearch-smoke: ${message}`);
}

export function requiredStageRoot(value) {
  const root = resolve(value);
  let entry;
  try {
    entry = lstatSync(root);
  } catch {
    fail("stage root is missing");
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail("stage root is unsafe");
  return realpathSync(root);
}

function assertContained(stageRoot, candidate, label) {
  const stageRelative = relative(stageRoot, candidate);
  if (stageRelative === ".." || stageRelative.startsWith(`..${sep}`) || isAbsolute(stageRelative)) {
    fail(`unsafe ${label}`);
  }
}

function requiredRegularFile(path, label, maxBytes) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    fail(`missing ${label}`);
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) fail(`unsafe ${label}`);
  if (entry.size <= 0 || entry.size > maxBytes) fail(`${label} has an invalid bounded size`);
}

export function requiredContainedFile(stageRoot, candidate, label, maxBytes) {
  const absoluteCandidate = resolve(candidate);
  assertContained(stageRoot, absoluteCandidate, label);
  requiredRegularFile(absoluteCandidate, label, maxBytes);
  const canonicalCandidate = realpathSync(absoluteCandidate);
  assertContained(stageRoot, canonicalCandidate, label);
  return canonicalCandidate;
}

export function readContainedText(stageRoot, candidate, label) {
  const path = requiredContainedFile(stageRoot, candidate, label, MAX_EVIDENCE_BYTES);
  return readFileSync(path, "utf8");
}

export function containedDigest(stageRoot, candidate, label, maxBytes) {
  const path = requiredContainedFile(stageRoot, candidate, label, maxBytes);
  return {
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function requireArgument(index, name) {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) fail(`${name} is required`);
  return value;
}

function governedStageRoot(targetName) {
  switch (targetName) {
    case "windows-x64":
      return join(REPOSITORY_ROOT, ".portable-runtime", "staging", "windows-x64");
    case "macos-arm64":
      return join(REPOSITORY_ROOT, ".portable-runtime", "staging", "macos-arm64");
    case "macos-x64":
      return join(REPOSITORY_ROOT, ".portable-runtime", "staging", "macos-x64");
    default:
      fail("platform target is unsupported");
  }
}

function requiredCliStageRoot(value, targetName) {
  const expected = governedStageRoot(targetName);
  if (resolve(value) !== expected) {
    fail("stage root argument does not match the governed target");
  }
  return expected;
}

function addonFrom(manifest, targetName, runtimeManifest) {
  if (!Array.isArray(manifest.nativeAddons) || manifest.nativeAddons.length !== 1) {
    fail("manifest must bind exactly one native addon");
  }
  const addon = manifest.nativeAddons[0];
  if (
    addon.name !== "usearch" ||
    addon.version !== runtimeManifest.version ||
    addon.platformTarget !== targetName ||
    addon.executablePath !== USEARCH_BINARY_PATH ||
    addon.licensePath !== USEARCH_LICENSE_PATH
  ) {
    fail("manifest native addon identity is invalid");
  }
  return addon;
}

function resourceRoot(stageRoot, target) {
  const payload = join(stageRoot, "payload", "Keiko");
  return target.nodePlatform === "darwin"
    ? join(payload, "Keiko.app", "Contents", "Resources")
    : payload;
}

function assertEvidence(stageRoot, addon, runtimeManifest) {
  const sbom = JSON.parse(
    readContainedText(
      stageRoot,
      join(stageRoot, "evidence", "sbom.cdx.json"),
      "portable SBOM evidence",
    ),
  );
  const matches = (sbom.components ?? []).filter(
    (component) => component?.["bom-ref"] === addon.sbomBomRef,
  );
  if (
    matches.length !== 1 ||
    matches[0].hashes?.some(
      (hash) => hash?.alg === "SHA-256" && hash.content === addon.shippedSha256,
    ) !== true
  ) {
    fail("SBOM does not bind the shipped native addon");
  }
  const notices = readContainedText(
    stageRoot,
    join(stageRoot, "evidence", "third-party-notices.txt"),
    "portable third-party notices",
  );
  if (!notices.includes(`USearch ${runtimeManifest.version}`)) {
    fail("third-party notice does not identify USearch");
  }
}

function loadAndSearch(binaryPath, runtimeVersion) {
  const require = createRequire(import.meta.url);
  const runtime = require(binaryPath);
  if (runtime.version !== runtimeVersion) fail("runtime version mismatch");
  const index = new runtime.CompiledIndex(2, "cos", "f32", 8, 32, 64, false);
  index.add(new BigUint64Array([0n, 1n]), new Float32Array([1, 0, 0, 1]), 1);
  const [keys, , counts] = index.search(new Float32Array([1, 0]), 1, 1);
  if (counts[0] !== 1 || keys[0] !== 0n) fail("runtime search result is invalid");
}

function requireTarget(targetName) {
  const target = portableTargetByName(targetName);
  if (target === undefined) fail("platform target is unsupported");
  return target;
}

function hasVerifiedProductionSignature(manifest, addon) {
  return (
    manifest.security?.verificationStatus === "verified-production" &&
    manifest.security?.signatureVerified === true &&
    addon.signing?.verificationStatus === "verified-production" &&
    addon.signing?.signatureVerified === true
  );
}

function requireApprovedAddon(manifest, target, targetName, runtimeManifest) {
  if (manifest.artifact?.platformTarget !== targetName) fail("manifest target mismatch");
  const addon = addonFrom(manifest, targetName, runtimeManifest);
  const targetKey = usearchRuntimeTargetKey(target.nodePlatform, target.nodeArchitecture);
  const approved = targetKey === undefined ? undefined : runtimeManifest.targets[targetKey];
  if (approved === undefined || addon.unsignedSha256 !== approved.binarySha256) {
    fail("manifest upstream digest is not approved");
  }
  const signedProduction = hasVerifiedProductionSignature(manifest, addon);
  return { addon, approvedBinarySha256: approved.binarySha256, signedProduction };
}

function assertShippedRuntime(
  stageRoot,
  target,
  addon,
  runtimeManifest,
  approvedBinarySha256,
  signedProduction,
) {
  const root = resourceRoot(stageRoot, target);
  const binary = containedDigest(
    stageRoot,
    join(root, ...USEARCH_BINARY_PATH.split("/")),
    "shipped native addon",
    MAX_NATIVE_BINARY_BYTES,
  );
  const license = containedDigest(
    stageRoot,
    join(root, ...USEARCH_LICENSE_PATH.split("/")),
    "shipped USearch license",
    MAX_EVIDENCE_BYTES,
  );
  if (binary.sha256 !== addon.shippedSha256) {
    fail("shipped native addon digest mismatch");
  }
  // Platform signing changes Mach-O/PE bytes. Before that boundary, bind the bytes directly to the
  // immutable target digest. After it, the preceding platform verifier and verified-production
  // manifest state become the trust anchor while shippedSha256 continues to bind the loaded file.
  if (!signedProduction && binary.sha256 !== approvedBinarySha256) {
    fail("staged native addon digest is not approved");
  }
  if (license.sha256 !== runtimeManifest.licenseSha256) {
    fail("shipped USearch license digest mismatch");
  }
  return binary.path;
}

export function smokePortableUsearch(stageRootValue, targetName, options = {}) {
  const runtimeManifest = options.runtimeManifest ?? USEARCH_RUNTIME_MANIFEST;
  const loadRuntime = options.loadRuntime ?? loadAndSearch;
  const stageRoot = requiredStageRoot(stageRootValue);
  const target = requireTarget(targetName);
  const manifest = JSON.parse(
    readContainedText(
      stageRoot,
      join(stageRoot, "manifest", "portable-manifest.json"),
      "portable manifest",
    ),
  );
  const approved = requireApprovedAddon(manifest, target, targetName, runtimeManifest);
  const { addon } = approved;
  const binaryPath = assertShippedRuntime(
    stageRoot,
    target,
    addon,
    runtimeManifest,
    approved.approvedBinarySha256,
    approved.signedProduction,
  );
  assertEvidence(stageRoot, addon, runtimeManifest);
  loadRuntime(binaryPath, runtimeManifest.version);
}

function main() {
  const targetName = requireArgument(3, "platform target");
  const stageRoot = requiredCliStageRoot(requireArgument(2, "stage root"), targetName);
  smokePortableUsearch(stageRoot, targetName);
  console.log(`portable-usearch-smoke: PASS ${targetName}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
