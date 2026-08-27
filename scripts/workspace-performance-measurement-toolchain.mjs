import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const DOMAIN = "keiko-workspace-performance-measurement-toolchain-v1\0";

// These inputs shape the workspace-performance evidence itself. The production UI belongs to the
// separately stamped subject digest; this list is deliberately only the ruler that collects and
// judges that subject, so ordinary product changes do not demand a re-measurement.
export const WORKSPACE_PERFORMANCE_MEASUREMENT_TOOLCHAIN_PATHS = Object.freeze([
  "scripts/check-perf-evidence.mjs",
  "scripts/workspace-performance-evidence-gate.mjs",
  "scripts/workspace-performance-measurement-toolchain.mjs",
  "tests/e2e/config/playwright.workspace-performance.config.ts",
  "tests/e2e/fixtures/keiko.e2e.config.json",
  "tests/e2e/workspace-performance.spec.ts",
]);

function updateDigest(hash, path, contents) {
  const pathBytes = Buffer.from(path, "utf8");
  const contentBytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  hash.update(`${String(pathBytes.length)}:`, "utf8");
  hash.update(pathBytes);
  hash.update(`${String(contentBytes.length)}:`, "utf8");
  hash.update(contentBytes);
}

export function computeWorkspacePerformanceMeasurementToolchainDigest(readPath) {
  const hash = createHash("sha256");
  hash.update(DOMAIN, "utf8");
  for (const path of WORKSPACE_PERFORMANCE_MEASUREMENT_TOOLCHAIN_PATHS) {
    updateDigest(hash, path, readPath(path));
  }
  return hash.digest("hex");
}

export function selectWorkspacePerformanceMeasurementToolchainPaths(paths) {
  const toolchainPaths = new Set(WORKSPACE_PERFORMANCE_MEASUREMENT_TOOLCHAIN_PATHS);
  return paths.filter((path) => toolchainPaths.has(path)).sort();
}
