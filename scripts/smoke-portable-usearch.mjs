import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  USEARCH_RUNTIME_MANIFEST,
  usearchRuntimeTargetKey,
} from "../packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts";
import { portableTargetByName } from "./portable-runtime.mjs";

function fail(message) {
  throw new Error(`portable-usearch-smoke: ${message}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireArgument(index, name) {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) fail(`${name} is required`);
  return value;
}

function addonFrom(manifest, targetName) {
  if (!Array.isArray(manifest.nativeAddons) || manifest.nativeAddons.length !== 1) {
    fail("manifest must bind exactly one native addon");
  }
  const addon = manifest.nativeAddons[0];
  if (
    addon.name !== "usearch" ||
    addon.version !== USEARCH_RUNTIME_MANIFEST.version ||
    addon.platformTarget !== targetName ||
    addon.executablePath !== "runtime/native/usearch.node" ||
    addon.licensePath !== "runtime/licenses/usearch/LICENSE"
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

function assertEvidence(stageRoot, addon) {
  const sbom = JSON.parse(readFileSync(join(stageRoot, "evidence", "sbom.cdx.json"), "utf8"));
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
  const notices = readFileSync(join(stageRoot, "evidence", "third-party-notices.txt"), "utf8");
  if (!notices.includes(`USearch ${USEARCH_RUNTIME_MANIFEST.version}`)) {
    fail("third-party notice does not identify USearch");
  }
}

function loadAndSearch(binaryPath) {
  const require = createRequire(import.meta.url);
  const runtime = require(binaryPath);
  if (runtime.version !== USEARCH_RUNTIME_MANIFEST.version) fail("runtime version mismatch");
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

function requireApprovedAddon(manifest, target, targetName) {
  if (manifest.artifact?.platformTarget !== targetName) fail("manifest target mismatch");
  const addon = addonFrom(manifest, targetName);
  const targetKey = usearchRuntimeTargetKey(target.nodePlatform, target.nodeArchitecture);
  const approved =
    targetKey === undefined ? undefined : USEARCH_RUNTIME_MANIFEST.targets[targetKey];
  if (approved === undefined || addon.unsignedSha256 !== approved.binarySha256) {
    fail("manifest upstream digest is not approved");
  }
  return addon;
}

function assertShippedRuntime(stageRoot, target, addon) {
  const root = resourceRoot(stageRoot, target);
  const binaryPath = join(root, ...addon.executablePath.split("/"));
  const licensePath = join(root, ...addon.licensePath.split("/"));
  if (!existsSync(binaryPath) || sha256(binaryPath) !== addon.shippedSha256) {
    fail("shipped native addon digest mismatch");
  }
  if (!existsSync(licensePath) || sha256(licensePath) !== USEARCH_RUNTIME_MANIFEST.licenseSha256) {
    fail("shipped USearch license digest mismatch");
  }
  return binaryPath;
}

function main() {
  const stageRoot = resolve(requireArgument(2, "stage root"));
  const targetName = requireArgument(3, "platform target");
  const target = requireTarget(targetName);
  const manifest = JSON.parse(
    readFileSync(join(stageRoot, "manifest", "portable-manifest.json"), "utf8"),
  );
  const addon = requireApprovedAddon(manifest, target, targetName);
  const binaryPath = assertShippedRuntime(stageRoot, target, addon);
  assertEvidence(stageRoot, addon);
  loadAndSearch(binaryPath);
  console.log(`portable-usearch-smoke: PASS ${targetName}`);
}

main();
