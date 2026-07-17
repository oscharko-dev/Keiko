import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const D12_MEASUREMENT_TOOLCHAIN_DOMAIN = "keiko-d12-measurement-toolchain-v1\0";

export const D12_MEASUREMENT_TOOLCHAIN_PATHS = Object.freeze([
  "scripts/__tests__/build-d12-bundle-input.test.mjs",
  "scripts/__tests__/build-d12-perf-comparison.test.mjs",
  "scripts/__tests__/check-perf-evidence.test.mjs",
  "scripts/__tests__/d12-measurement-toolchain.test.mjs",
  "scripts/__tests__/run-d12-perf-comparison.test.mjs",
  "scripts/build-d12-bundle-input.mjs",
  "scripts/build-d12-perf-comparison.mjs",
  "scripts/check-perf-evidence.mjs",
  "scripts/d12-measurement-toolchain.mjs",
  "scripts/d12-runtime-environment.mjs",
  "scripts/editor-bundle-size.mjs",
  "scripts/editor-release-evidence.mjs",
  "scripts/run-d12-perf-comparison.mjs",
  "tests/e2e/config/playwright.editor-performance.config.ts",
  "tests/e2e/config/playwright.issue-2348-editor-debugging.config.ts",
  "tests/e2e/editor-debugging-2348.static.test.ts",
  "tests/e2e/editor-debugging-2348.spec.ts",
  "tests/e2e/editor-performance.spec.ts",
  "tests/e2e/fixtures/editor-debugging-2348/dap-socket-adapter.fixture",
  "tests/e2e/fixtures/editor-debugging-2348/package.json",
  "tests/e2e/fixtures/editor-debugging-2348/program.ts",
  "tests/e2e/fixtures/editor-debugging-2348/throws.ts",
  "tests/e2e/fixtures/keiko.e2e.config.json",
  "tests/e2e/support/dapOperatorProvisioning.ts",
  "tests/e2e/support/editorWorkspace.ts",
]);

function updateDigest(hash, path, contents) {
  const pathBytes = Buffer.from(path, "utf8");
  const contentBytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  hash.update(`${pathBytes.length}:`, "utf8");
  hash.update(pathBytes);
  hash.update(`${contentBytes.length}:`, "utf8");
  hash.update(contentBytes);
}

function sortPaths(paths) {
  return [...new Set(paths)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}

export function computeD12MeasurementToolchainDigest(
  readPath,
  paths = D12_MEASUREMENT_TOOLCHAIN_PATHS,
) {
  const hash = createHash("sha256");
  hash.update(D12_MEASUREMENT_TOOLCHAIN_DOMAIN, "utf8");
  for (const path of sortPaths(paths)) updateDigest(hash, path, readPath(path));
  return hash.digest("hex");
}

export function selectD12MeasurementToolchainPaths(paths) {
  const toolchainPaths = new Set(D12_MEASUREMENT_TOOLCHAIN_PATHS);
  return sortPaths(paths.filter((path) => toolchainPaths.has(path)));
}
