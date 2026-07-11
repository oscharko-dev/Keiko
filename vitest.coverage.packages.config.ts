import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      // The editor package owns React/Monaco component shells with file-level jsdom tests. Include
      // them in package coverage so the branch ratchet measures the lifecycle code it gates.
      "packages/keiko-editor/src/**/*.test.tsx",
      "scripts/__tests__/**/*.test.mjs",
    ],
    exclude: ["**/node_modules/**", "tests/fixtures/**", "packages/keiko-ui/**"],
    execArgv: ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"],
    // GEN-TEST-FLAKE-001: keep the CI-gated coverage run's per-test timeout aligned with the root
    // suite (vitest.config.ts) at 15s. v8 instrumentation + forked workers make this the run MOST
    // likely to exceed vitest's 5s default under scheduler load, so a drift here false-REDs the
    // release-blocking coverage gate. scripts/__tests__/vitest-config-parity.test.mjs enforces parity.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      // "lcov" feeds SonarCloud CI-based analysis (ADR-0128, sonar.javascript.lcov.reportPaths);
      // the other reporters are unchanged and keep serving the local coverage-baseline ratchet.
      reporter: ["text", "json", "json-summary", "lcov"],
      // Emit the coverage summary even when some tests fail, so the ratchet gate can still be
      // computed and regenerated (the reality-guard tests depend on a fresh summary existing).
      reportOnFailure: true,
      reportsDirectory: "coverage/packages",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: [
        "packages/keiko-ui/**",
        "**/*.test.*",
        "**/__tests__/**",
        "**/_support.ts",
        "**/test-support.ts",
        "**/test-fixtures.ts",
        "**/testing.ts",
        "**/*.config.ts",
        "dist/**",
        "node_modules/**",
      ],
    },
  },
});
