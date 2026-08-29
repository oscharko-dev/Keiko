import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

import { PACKAGE_COVERAGE_GATE_SCRIPTS } from "./scripts/lib/package-coverage-gate-scripts.mjs";

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
    // GEN-TEST-FLAKE-002: coverage instrumentation is substantially more CPU-intensive than the
    // root suite. Keep the same bounded worker count so performance guardrails and subprocess-heavy
    // release tests measure the product instead of scheduler contention on high-core hosts.
    maxWorkers: 2,
    // GEN-TEST-FLAKE-001: keep the CI-gated coverage run's per-test timeout aligned with the root
    // suite (vitest.config.ts) at 15s. v8 instrumentation + forked workers make this the run MOST
    // likely to exceed vitest's 5s default under scheduler load, so a drift here false-REDs the
    // release-blocking coverage gate. scripts/__tests__/vitest-config-parity.test.mjs enforces parity.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      // "lcov" feeds SonarCloud CI-based analysis (ADR-0134, sonar.javascript.lcov.reportPaths);
      // the other reporters are unchanged and keep serving the local coverage-baseline ratchet.
      reporter: ["text", "json", "json-summary", "lcov"],
      // Emit the coverage summary even when some tests fail, so the ratchet gate can still be
      // computed and regenerated (the reality-guard tests depend on a fresh summary existing).
      reportOnFailure: true,
      reportsDirectory: "coverage/packages",
      include: [
        "packages/*/src/**/*.{ts,tsx}",
        "src/**/*.{ts,tsx}",
        ...PACKAGE_COVERAGE_GATE_SCRIPTS,
      ],
      exclude: [
        "packages/keiko-ui/**",
        "**/*.test.*",
        "**/*.bench.*",
        "**/__tests__/**",
        "**/_support.ts",
        "**/test-support.ts",
        // KEIKO-0130: shared per-package test-fixture modules live under `src/test-support/`
        // and are never bundled into the package's public surface. Excluded for the same
        // reason `**/test-support.ts` is.
        "**/test-support/**",
        "**/test-fixtures.ts",
        "**/testing.ts",
        "**/*.config.ts",
        "dist/**",
        "node_modules/**",
      ],
      // ADR-0158 D1: this configuration declares NO `coverage.thresholds`. The ten gate-script
      // per-file floors it used to hold live in `docs/qa/package-coverage-baseline.json` as
      // `governance: "absolute"` entries — one per-file floor engine, one storage location. Keeping
      // a second copy here would restore exactly the two-engine split this consolidation removed.
      // Because no vitest configuration judges any more, a shard cannot reach a verdict on its
      // partial view by construction rather than by a derived shard configuration (ADR-0157 D1).
    },
  },
});
