import { defineConfig } from "vitest/config";

// KEIKO-0887 (GEN-TEST-FLAKE-001/002): keiko-cli is the repository's most subprocess-heavy
// package suite — 22 of 35 test files use real mkdtemp trees, spawned launcher/server
// processes, or bind loopback ports. The 5s Vitest default timeout and unbounded worker
// fan-out are calibrated for pure-function siblings; here they turn a benign spawn or a
// slow disk into a flake. Pin testTimeout: 15_000 and maxWorkers: 2 to match the numbers
// every CI runner already uses for these files.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 15_000,
    maxWorkers: 2,
  },
});
