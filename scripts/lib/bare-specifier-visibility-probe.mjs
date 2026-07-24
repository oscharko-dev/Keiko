import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bare-specifier visibility probe (Wave-2 audit #2627).
 *
 * Writes a temporary source file under a keiko-security src path, imports
 * `@oscharko-dev/keiko-harness` by its workspace package name, invokes
 * dependency-cruiser against the probe file, and verifies rule 2 fires with the
 * exact resolved target `packages/keiko-harness/dist/index.js`. The probe file
 * is unconditionally removed in a `finally` block so it never survives a run.
 *
 * The probe is pure enough to unit-test: the only side effects are the
 * short-lived probe file and one subprocess invocation. Callers inject the
 * spawn/write/remove primitives so tests can validate the assertion path
 * without shelling out to a real dep-cruiser binary.
 *
 * @param {object} options
 * @param {string} options.repoRoot           Absolute path to the repository root.
 * @param {string} options.rulesFile          Path to the dep-cruiser config.
 * @param {string} options.hostPackageSrc     Repo-relative path of the host package src directory
 *                                            (e.g. `packages/keiko-security/src`).
 * @param {string} options.probeFileBasename  Basename of the temporary probe source file.
 * @param {string} options.targetSpecifier    Bare specifier to import inside the probe (the
 *                                            resolved destination is asserted below).
 * @param {string} options.expectedRule       Rule name that MUST fire against the resolved edge.
 * @param {string} options.expectedResolved   Repo-relative resolved destination expected in
 *                                            dep-cruiser's stdout.
 * @param {(command: string, args: readonly string[], opts: object) =>
 *   {status: number | null, stdout: string, stderr: string, error?: Error}} options.runDepcruise
 *   Injected subprocess runner (defaults to `spawnSync` when omitted).
 * @param {(path: string, contents: string) => void} [options.writeProbeFile]
 *   Injected file writer (defaults to `writeFileSync` when omitted).
 * @param {(path: string) => void} [options.removeProbeFile]
 *   Injected file remover (defaults to `rmSync` when omitted).
 * @returns {{ok: true} | {ok: false, reason: string, stdout?: string, stderr?: string}}
 *   `{ok: true}` when the expected rule fired against the expected resolved edge.
 *   `{ok: false, reason}` otherwise; `reason` names the failure mode and `stdout`/`stderr`
 *   carry dep-cruiser's raw output when spawn succeeded.
 */
export function runBareSpecifierVisibilityProbe({
  repoRoot,
  rulesFile,
  hostPackageSrc,
  probeFileBasename,
  targetSpecifier,
  expectedRule,
  expectedResolved,
  runDepcruise = defaultRunDepcruise,
  writeProbeFile = defaultWriteProbeFile,
  removeProbeFile = defaultRemoveProbeFile,
}) {
  const probePath = join(repoRoot, hostPackageSrc, probeFileBasename);
  const probeSource =
    "// Bare-specifier visibility probe written by scripts/arch-check-negative.mjs (Wave-2 audit\n" +
    "// #2627). This file is created, verified, and removed within a single run - it MUST NOT be\n" +
    "// committed. If you find it in a diff, the probe crashed before cleanup; delete it and rerun\n" +
    "// `npm run arch:check:negative` to reproduce the failure.\n" +
    `import { violationTarget } from "${targetSpecifier}";\n` +
    "export const bareSpecifierVisibilityProbe: unknown = violationTarget;\n";
  writeProbeFile(probePath, probeSource);
  try {
    const result = runDepcruise(
      process.execPath,
      [
        join(repoRoot, "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs"),
        "--validate",
        rulesFile,
        probePath,
      ],
      { encoding: "utf8" },
    );
    if (result.status === null) {
      return { ok: false, reason: "spawn-failed" };
    }
    const relativeProbePath = probePath.slice(repoRoot.length + 1);
    const expectedSubstring = `${expectedRule}: ${relativeProbePath} → ${expectedResolved}`;
    if (result.status === 0 || !result.stdout.includes(expectedSubstring)) {
      return {
        ok: false,
        reason: "rule-not-fired",
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    return { ok: true };
  } finally {
    removeProbeFile(probePath);
  }
}

/** @param {string} command @param {readonly string[]} args @param {object} opts */
function defaultRunDepcruise(command, args, opts) {
  return spawnSync(command, args, opts);
}

/** @param {string} path @param {string} contents */
function defaultWriteProbeFile(path, contents) {
  writeFileSync(path, contents, "utf8");
}

/** @param {string} path */
function defaultRemoveProbeFile(path) {
  rmSync(path, { force: true });
}
