// Cross-package version consistency gate (Epic #423 issue #433).
//
// Asserts:
//   1. Every workspace package (packages/*/package.json) reports the same version as the
//      root package.json's "version" field (the 0.2.0 baseline finalised in #427).
//   2. The KEIKO_PRODUCT_VERSION constant in @oscharko-dev/keiko-contracts/src/index.ts
//      matches that same root version.
//   3. Issue #426's removed shim/duplicate paths stay removed: src/sdk/** and the local
//      _sdk-version.ts mirrors under packages/keiko-cli/src and packages/keiko-server/src.
//   4. packages/keiko-sdk/src/index.ts directly re-exports KEIKO_PRODUCT_VERSION as SDK_VERSION.
//
// Runs in the prepack chain after the build steps. This validates the source/build inputs the
// publish path depends on; tarball contents are separately enforced by check:package-surface and
// the install/runtime smoke gates.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const APPROVED_ROOT_SRC_FILES = ["src/cli/index.ts", "src/index.ts"];
const APPROVED_ROOT_SRC_SHA256 = new Map([
  ["src/index.ts", "751c1c0fae45a8bf68ba099ecd0706a74d64661f8fc1b9bd7f05d4abd1beb20b"],
  ["src/cli/index.ts", "35b598c19db4adcd9fe40618f289200463d361d109f951c9e70b99db8db25863"],
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listFilesRecursively(rootDir, prefix = "") {
  const dirPath = join(rootDir, prefix);
  const entries = readdirSync(dirPath, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix === "" ? entry.name : join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(rootDir, relativePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath.replaceAll("\\", "/"));
    }
  }
  return files;
}

function sha256(relativePath) {
  return createHash("sha256").update(readFileSync(join(repoRoot, relativePath))).digest("hex");
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

const rootSrcFiles = listFilesRecursively(join(repoRoot, "src")).map((relativePath) =>
  `src/${relativePath}`,
);
if (JSON.stringify(rootSrcFiles) !== JSON.stringify(APPROVED_ROOT_SRC_FILES)) {
  fail(
    `root src/ must stay minimal: expected ${APPROVED_ROOT_SRC_FILES.join(", ")} but found ${rootSrcFiles.join(", ")}`,
  );
}

for (const [relativePath, approvedHash] of APPROVED_ROOT_SRC_SHA256) {
  const actualHash = sha256(relativePath);
  if (actualHash !== approvedHash) {
    fail(`${relativePath}: root facade drifted beyond the approved minimal facade.`);
  }
}

const sdkIndexPath = join(repoRoot, "packages", "keiko-sdk", "src", "index.ts");
const sdkIndex = readFileSync(sdkIndexPath, "utf8");
if (
  !/^import\s+\{\s*KEIKO_PRODUCT_VERSION\s*\}\s+from\s+"@oscharko-dev\/keiko-contracts";$/m.test(
    sdkIndex,
  )
) {
  fail(
    "packages/keiko-sdk/src/index.ts: missing KEIKO_PRODUCT_VERSION import from " +
      "@oscharko-dev/keiko-contracts.",
  );
}
if (!/^export\s+const\s+SDK_VERSION(?:\s*:\s*string)?\s*=\s*KEIKO_PRODUCT_VERSION;$/m.test(sdkIndex)) {
  fail(
    "packages/keiko-sdk/src/index.ts: SDK_VERSION does not directly re-export " +
      "KEIKO_PRODUCT_VERSION.",
  );
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
