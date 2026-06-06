// Cross-package version consistency gate (Epic #423 issue #433).
//
// Asserts:
//   1. Every workspace package (packages/*/package.json) reports the same version as the
//      root package.json's "version" field (the 0.2.0 baseline finalised in #427).
//   2. The KEIKO_PRODUCT_VERSION constant in @oscharko-dev/keiko-contracts/src/index.ts
//      matches that same root version.
//   3. Issue #426's removed shim/duplicate paths stay removed: src/sdk/** and the local
//      _sdk-version.ts mirrors under packages/keiko-cli/src and packages/keiko-server/src.
//   4. No drifted hardcoded version literal appears in packages/keiko-sdk/src/index.ts.
//
// Runs in the prepack chain after the build steps so the packed artifact cannot ship with
// a manifest/version mismatch. Pure Node 22+, no new runtime dependency.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  failures.push(message);
}

const rootManifest = readJson(join(repoRoot, "package.json"));
const expected = rootManifest.version;
if (typeof expected !== "string" || expected.length === 0) {
  console.error("version-consistency: root package.json has no version field.");
  process.exit(1);
}

const packagesDir = join(repoRoot, "packages");
for (const name of readdirSync(packagesDir)) {
  const pkgDir = join(packagesDir, name);
  if (!statSync(pkgDir).isDirectory()) continue;
  const manifestPath = join(pkgDir, "package.json");
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    continue;
  }
  if (manifest.version !== expected) {
    fail(`${name}: version ${manifest.version} does not match root ${expected}`);
  }
}

const contractsIndex = readFileSync(
  join(repoRoot, "packages", "keiko-contracts", "src", "index.ts"),
  "utf8",
);
const constMatch = contractsIndex.match(/KEIKO_PRODUCT_VERSION\s*=\s*"([^"]+)"\s+as\s+const/);
if (constMatch === null) {
  fail("keiko-contracts: KEIKO_PRODUCT_VERSION constant not found in src/index.ts");
} else if (constMatch[1] !== expected) {
  fail(`keiko-contracts KEIKO_PRODUCT_VERSION ${constMatch[1]} does not match root ${expected}`);
}

const REMOVED_PATHS = [
  "src/sdk",
  "packages/keiko-cli/src/_sdk-version.ts",
  "packages/keiko-server/src/_sdk-version.ts",
];

for (const target of REMOVED_PATHS) {
  if (existsSync(join(repoRoot, target))) {
    fail(`${target}: legacy Issue #426 path still exists.`);
  }
}

const sdkIndexPath = join(repoRoot, "packages", "keiko-sdk", "src", "index.ts");
const sdkIndex = readFileSync(sdkIndexPath, "utf8");
if (/SDK_VERSION\s*=\s*"[0-9.]+"/.test(sdkIndex)) {
  fail(
    "packages/keiko-sdk/src/index.ts: hardcoded SDK_VERSION literal detected. " +
      "The single authoritative source is KEIKO_PRODUCT_VERSION in @oscharko-dev/keiko-contracts.",
  );
}
if (!sdkIndex.includes("KEIKO_PRODUCT_VERSION")) {
  fail("packages/keiko-sdk/src/index.ts: SDK_VERSION is not sourced from KEIKO_PRODUCT_VERSION.");
}

if (failures.length > 0) {
  console.error("version-consistency: FAIL");
  for (const message of failures) {
    console.error(`  - ${message}`);
  }
  process.exit(1);
}

console.log(
  `version-consistency: PASS — every workspace package and KEIKO_PRODUCT_VERSION reports ${expected}.`,
);
