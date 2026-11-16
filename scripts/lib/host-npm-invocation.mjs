// Shell-free npm invocation for an executable that resolveHostExecutable already selected.
//
// It lives apart from host-executable.mjs for a measured reason: that file is a member of
// D12_MEASUREMENT_TOOLCHAIN_PATHS and of the #1300 evidence source inputs, and both digests are
// file-granular. Nothing here shapes a measured number or a captured frame, so an edit to it must
// not invalidate either body of evidence (the same split scripts/perf-evidence-gate.mjs documents).

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function isContained(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function trustedCli(candidate, workspaceRoot) {
  try {
    accessSync(candidate, constants.X_OK);
    const real = realpathSync(candidate);
    return isContained(realpathSync(workspaceRoot), real) ? undefined : real;
  } catch {
    return undefined;
  }
}

/** Build a shell-free invocation from an npm executable resolved by host-executable.mjs. */
export function hostNpmInvocation(
  executable,
  {
    platform = process.platform,
    runtimeExecutable = process.execPath,
    workspaceRoot = repoRoot,
  } = {},
) {
  if (platform !== "win32") return { command: executable, args: [] };
  // Windows cannot spawn npm.cmd directly. Use its installed CLI, never npm_execpath from the
  // environment. Keep both the workspace exclusion and containment within the selected npm tree.
  const npmRoot = dirname(executable);
  const cli = trustedCli(join(npmRoot, "node_modules", "npm", "bin", "npm-cli.js"), workspaceRoot);
  if (cli === undefined || !isContained(npmRoot, cli) || !statSync(cli).isFile()) {
    throw new Error("trusted host npm CLI is unavailable");
  }
  return { command: runtimeExecutable, args: [cli] };
}
