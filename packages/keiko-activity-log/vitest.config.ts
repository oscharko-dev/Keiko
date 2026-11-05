import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // GEN-TEST-FLAKE-001/002: the moved reader suites retain the CLI harness allowance they ran
    // under before extraction. They use real temporary stores and subprocesses, so preserve the
    // repository's 15-second bound and two-worker cap rather than Vitest's 5-second default.
    testTimeout: 15_000,
    maxWorkers: 2,
    setupFiles: [
      fileURLToPath(new URL("../../tests/support/activity-log-test-writer.ts", import.meta.url)),
    ],
  },
});
