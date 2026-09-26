import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const DOMAIN = "keiko-workspace-performance-measurement-toolchain-v2\0";
const WORKSPACE_PERFORMANCE_SCRIPT = "test:e2e:workspace-perf";
const WORKSPACE_PERFORMANCE_SCRIPT_INPUT = "package.json#scripts.test:e2e:workspace-perf";

// These inputs shape the workspace-performance evidence itself. The production UI belongs to the
// separately stamped subject digest; this list is deliberately only the ruler that collects and
// judges that subject, so ordinary product changes do not demand a re-measurement.
// The canonical npm command is bound separately below, rather than digesting all package metadata.
export const WORKSPACE_PERFORMANCE_MEASUREMENT_TOOLCHAIN_PATHS = Object.freeze([
  "scripts/check-perf-evidence.mjs",
  "scripts/lib/git-changed-paths.mjs",
  "scripts/lib/host-executable.mjs",
  "scripts/lib/is-main-module.mjs",
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

function workspacePerformanceScriptCommand(readPath) {
  const packageJson = JSON.parse(Buffer.from(readPath("package.json")).toString("utf8"));
  const command = packageJson.scripts?.[WORKSPACE_PERFORMANCE_SCRIPT];
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError(
      `package.json must define a non-empty ${WORKSPACE_PERFORMANCE_SCRIPT} script`,
    );
  }
  // Do not digest all package metadata: only the command that invokes the measurement harness is
  // part of its ruler. The JSON serialization supplies a stable, labelled input rather than
  // relying on an implicit position in package.json.
  return JSON.stringify({ script: WORKSPACE_PERFORMANCE_SCRIPT, command });
}

export function computeWorkspacePerformanceMeasurementToolchainDigest(readPath) {
  const hash = createHash("sha256");
  hash.update(DOMAIN, "utf8");
  for (const path of WORKSPACE_PERFORMANCE_MEASUREMENT_TOOLCHAIN_PATHS) {
    updateDigest(hash, path, readPath(path));
  }
  updateDigest(
    hash,
    WORKSPACE_PERFORMANCE_SCRIPT_INPUT,
    workspacePerformanceScriptCommand(readPath),
  );
  return hash.digest("hex");
}

export function selectWorkspacePerformanceMeasurementToolchainPaths(paths) {
  const toolchainPaths = new Set(WORKSPACE_PERFORMANCE_MEASUREMENT_TOOLCHAIN_PATHS);
  return paths.filter((path) => toolchainPaths.has(path)).sort();
}
