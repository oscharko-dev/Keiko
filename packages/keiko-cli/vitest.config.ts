import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { vitestMaxWorkers } from "../../scripts/lib/vitest-workers.mjs";

// KEIKO-0887 (GEN-TEST-FLAKE-001/002): keiko-cli is the repository's most subprocess-heavy
// package suite — 22 of 35 test files use real mkdtemp trees, spawned launcher/server
// processes, or bind loopback ports. The 5s Vitest default timeout and unbounded worker
// fan-out are calibrated for pure-function siblings; here they turn a benign spawn or a
// slow disk into a flake. Pin testTimeout: 15_000 and take the worker bound from the shared
// scripts/lib/vitest-workers.mjs: 2 under CI, where the starvation was observed on the small runner,
// 4 on a development machine, KEIKO_VITEST_MAX_WORKERS (1 to 16) to choose, =2 to reproduce CI.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 15_000,
    maxWorkers: vitestMaxWorkers(),
    // #3532: explicit Activity Log test-writer injection, identical to the root suite.
    setupFiles: [
      fileURLToPath(new URL("../../tests/support/activity-log-test-writer.ts", import.meta.url)),
      fileURLToPath(new URL("../../tests/support/test-state-dirs.ts", import.meta.url)),
    ],
  },
});
