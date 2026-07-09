import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadPortableRuntimeApprovals,
  PORTABLE_RUNTIME_APPROVALS_FILE,
} from "./portable-runtime-approvals.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function checkPortableRuntimeApprovals(root = repoRoot) {
  const approvals = loadPortableRuntimeApprovals(root);
  const sidecarNames = approvals.sidecarRuntimes.map((runtime) => runtime.name);
  return {
    nodeVersion: approvals.node.version,
    sidecarRuntimes: sidecarNames,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const summary = checkPortableRuntimeApprovals();
    console.log(
      `portable-approvals: PASS - node ${summary.nodeVersion}; sidecars: ${
        summary.sidecarRuntimes.length === 0 ? "none" : summary.sidecarRuntimes.join(", ")
      } (${PORTABLE_RUNTIME_APPROVALS_FILE})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
