// Cross-package version consistency gate (Epic #423 issue #433).
//
// Asserts:
//   1. Every workspace package (packages/*/package.json) reports the same version as the
//      root package.json's "version" field (the 0.2.0 baseline finalised in #427).
//   2. The KEIKO_PRODUCT_VERSION constant in @oscharko-dev/keiko-contracts/src/index.ts
//      matches that same root version.
//   3. No drifted hardcoded version literal appears in src/sdk/index.ts or the two
//      _sdk-version.ts mirrors under packages/keiko-cli/src and packages/keiko-server/src.
//
// Runs in the prepack chain after the build steps so the packed artifact cannot ship with
// a manifest/version mismatch. Pure Node 22+, no new runtime dependency.

import { readdirSync, readFileSync, statSync } from "node:fs";
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

const FORBIDDEN_LITERAL_PATTERNS = [
  { path: "src/sdk/index.ts", marker: /SDK_VERSION\s*=\s*"[0-9.]+"/, name: "src/sdk/index.ts" },
  {
    path: "packages/keiko-cli/src/_sdk-version.ts",
    marker: /SDK_VERSION\s*=\s*"[0-9.]+"/,
    name: "packages/keiko-cli/src/_sdk-version.ts",
  },
  {
    path: "packages/keiko-server/src/_sdk-version.ts",
    marker: /SDK_VERSION\s*=\s*"[0-9.]+"/,
    name: "packages/keiko-server/src/_sdk-version.ts",
  },
];

for (const target of FORBIDDEN_LITERAL_PATTERNS) {
  const content = readFileSync(join(repoRoot, target.path), "utf8");
  if (target.marker.test(content)) {
    fail(
      `${target.name}: hardcoded SDK_VERSION literal detected. ` +
        "The single authoritative source is KEIKO_PRODUCT_VERSION in @oscharko-dev/keiko-contracts.",
    );
  }
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
