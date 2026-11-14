import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { vitestMaxWorkers } from "../../scripts/lib/vitest-workers.mjs";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // GEN-TEST-FLAKE-001/002: the moved reader suites retain the CLI harness allowance they ran
    // under before extraction. They use real temporary stores and subprocesses, so preserve the
    // repository's 15-second bound and a bounded worker count (shared helper: 2 under CI, 4 locally,
    // KEIKO_VITEST_MAX_WORKERS to choose) rather than Vitest's 5-second default and unbounded fan-out.
    testTimeout: 15_000,
    maxWorkers: vitestMaxWorkers(),
    setupFiles: [
      fileURLToPath(new URL("../../tests/support/activity-log-test-writer.ts", import.meta.url)),
      fileURLToPath(new URL("../../tests/support/test-state-dirs.ts", import.meta.url)),
    ],
  },
});
