import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeD12MeasurementToolchainDigest } from "./d12-measurement-toolchain.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

const ROOT = resolve(import.meta.dirname, "..");
export const CODING_PERFORMANCE_COMMAND = "perf:evidence:coding-runtime";
export const CODING_PERFORMANCE_TOOLCHAIN_PATHS = Object.freeze([
  "scripts/coding-runtime-performance-evidence.mjs",
  "scripts/coding-runtime-performance-harness.mjs",
  "scripts/coding-runtime-performance-producer.mjs",
  "scripts/coding-runtime-performance-toolchain.mjs",
  "scripts/check-perf-evidence.mjs",
  "scripts/check-runtime-toolchain.mjs",
  "scripts/d12-measurement-toolchain.mjs",
  "scripts/lib/compare-strings.mjs",
  "scripts/lib/git-changed-paths.mjs",
  "scripts/lib/host-executable.mjs",
  "scripts/lib/is-main-module.mjs",
  "scripts/lib/json.mjs",
  "packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional/_support.ts",
  "packages/keiko-server/src/coding-app-session/_support.ts",
  "packages/keiko-server/src/ui-test-server/_support.ts",
  "tests/e2e/servers/tsconfig.json",
  "tsconfig.base.json",
  "portable-runtime-approvals.json",
]);

export function codingPerformanceToolchainDigest(
  readPath = (path) => readFileSync(join(ROOT, path)),
) {
  const commands = JSON.parse(String(readPath("package.json"))).scripts;
  const command = commands?.[CODING_PERFORMANCE_COMMAND];
  if (typeof command !== "string" || command.length === 0)
    throw new TypeError("coding performance producer command is missing");
  const commandPath = `package.json#scripts.${CODING_PERFORMANCE_COMMAND}`;
  // Reuse the existing byte-framed, order-independent file digest. The virtual labelled member
  // binds only the producer command; unrelated package metadata does not move this ruler.
  return computeD12MeasurementToolchainDigest(
    (path) => (path === commandPath ? command : readPath(path)),
    [...CODING_PERFORMANCE_TOOLCHAIN_PATHS, commandPath],
  );
}

export function codingPerformanceSubjectPath(path) {
  if (
    /(?:^|\/)(?:__tests__|dist|node_modules|coverage)\/|\.(?:test|spec)\.|\/_support\.[cm]?ts$/u.test(
      path,
    )
  )
    return false;
  if (path.startsWith("packages/keiko-ui/") || path.startsWith("packages/keiko-editor/"))
    return false;
  return (
    path.startsWith("packages/") ||
    path.startsWith("src/") ||
    path.startsWith("native/") ||
    path === "package-lock.json" ||
    path === "tsconfig.json" ||
    path === "tsconfig.base.json"
  );
}

function git(root, args) {
  return execFileSync(resolveHostExecutable("git"), args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

export function codingPerformanceSource(root = ROOT) {
  const paths = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(codingPerformanceSubjectPath);
  return {
    commit: git(root, ["rev-parse", "HEAD"]).trim(),
    sourceTreeSha256: computeD12MeasurementToolchainDigest(
      (path) => readFileSync(join(root, path)),
      paths,
    ),
    lockfileSha256: createHash("sha256")
      .update(readFileSync(join(root, "package-lock.json")))
      .digest("hex"),
  };
}

export function dirtyCodingPerformanceInputs(root = ROOT) {
  const changed = git(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"])
    .split("\0")
    .filter(Boolean);
  const ruler = new Set([...CODING_PERFORMANCE_TOOLCHAIN_PATHS, "package.json"]);
  // Include both sides of renames: porcelain -z places the old path in a separate field.
  return changed
    .map((entry) => (/^[ MADRCU?!]{2} /u.test(entry) ? entry.slice(3) : entry))
    .filter((path) => codingPerformanceSubjectPath(path) || ruler.has(path));
}

export function codingPerformanceRulerChanged(paths, commands = {}) {
  return (
    paths.some((path) => CODING_PERFORMANCE_TOOLCHAIN_PATHS.includes(path)) ||
    (paths.includes("package.json") &&
      (commands.beforeCommand === undefined ||
        commands.afterCommand === undefined ||
        commands.beforeCommand !== commands.afterCommand))
  );
}
