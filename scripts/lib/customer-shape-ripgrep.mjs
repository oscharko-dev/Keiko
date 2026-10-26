// The pinned ripgrep for the customer-shape qualification (Epic #3897).
//
// The qualifier installs the staged npm package into a fresh project and starts it from there, so
// the repository's `.ripgrep/` (npm run provision:ripgrep) is not inside the tree the runtime
// launches from. This hands the runtime the provisioned executable explicitly, through the
// override the launch verifies against the pinned digest like any other location, and fails the
// qualification up front - before the expensive pack and install - when that executable is absent
// or not the pinned release. OpenCode would otherwise try to download ripgrep on first use, which
// the loopback-only runtime and an offline runner cannot do, and its glob and grep would fail.

import { dirname, resolve } from "node:path";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

import {
  RIPGREP_OVERRIDE_ENV,
  ripgrepProvisionedBinaryPath,
  ripgrepRuntimeTargetKey,
  verifyRipgrepExecutable,
} from "../../packages/keiko-server/src/coding-runtime/ripgrepRuntime.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function customerShapeRipgrepEnvironment({
  repoRoot = REPO_ROOT,
  hostPlatform = platform,
  hostArchitecture = arch,
  verify = verifyRipgrepExecutable,
} = {}) {
  const targetKey = ripgrepRuntimeTargetKey(hostPlatform, hostArchitecture);
  if (targetKey === undefined) {
    throw new Error(
      `customer-shape: no pinned ripgrep for ${hostPlatform}-${hostArchitecture}; the qualification host is unsupported`,
    );
  }
  const path = ripgrepProvisionedBinaryPath(repoRoot, targetKey);
  const verified = verify(path, targetKey);
  if (!verified.ok) {
    throw new Error(
      `customer-shape: the pinned ripgrep is not provisioned (${verified.reason}); run npm run provision:ripgrep`,
    );
  }
  return { [RIPGREP_OVERRIDE_ENV]: path };
}
