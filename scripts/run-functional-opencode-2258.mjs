import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { stageFunctionalOpenCode } from "./functional-opencode-2258-support.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const staged = await stageFunctionalOpenCode({ repoRoot });

try {
  execFileSync(
    "npm",
    [
      "exec",
      "vitest",
      "run",
      "packages/keiko-server/src/coding-runtime/opencodeRuntime.real.test.ts",
      "packages/keiko-server/src/coding-runtime/productionOpenCodeRuntime.functional.test.ts",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        KEIKO_OPENCODE_REAL_BINARY: staged.executable,
        KEIKO_OPENCODE_REAL_RESOURCE_ROOT: staged.stageRoot,
      },
      stdio: "inherit",
    },
  );
} finally {
  staged.cleanup();
}
