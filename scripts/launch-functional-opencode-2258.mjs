import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { stageFunctionalOpenCode } from "./functional-opencode-2258-support.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const staged = await stageFunctionalOpenCode({ repoRoot });
const child = spawn(
  "npm",
  ["exec", "vitest", "run", "tests/e2e/functional-opencode-2258-live-server.test.ts"],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      KEIKO_2258_LIVE_HARNESS: "1",
      KEIKO_OPENCODE_REAL_BINARY: staged.executable,
      KEIKO_OPENCODE_REAL_RESOURCE_ROOT: staged.stageRoot,
    },
    stdio: "inherit",
  },
);

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));

try {
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
  });
  process.exitCode = code;
} finally {
  staged.cleanup();
}
