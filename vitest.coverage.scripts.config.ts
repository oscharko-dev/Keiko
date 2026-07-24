import { defineConfig } from "vitest/config";

const packageCoverageGateScripts = [
  "scripts/keiko-for-quality-core.mjs",
  "scripts/keiko-for-quality-worker.mjs",
  "scripts/check-lcov-source-mapping.mjs",
  "scripts/check-mutation-quality.mjs",
  "scripts/check-mutation-scope.mjs",
  "scripts/check-sonar-analysis-log.mjs",
  "scripts/check-sonar-main-quality-gate.mjs",
  "scripts/check-sonar-pr-quality-gate.mjs",
  "scripts/sonar-analysis-scope.mjs",
  "scripts/sonar-quality-gate-contract.mjs",
  // Wave-2 audit #2627: arch-check-negative.mjs is a top-level orchestration script that runs
  // dep-cruiser and the import-policy checker via `spawnSync`; v8 coverage never crosses the
  // subprocess boundary, so a unit-test harness cannot exercise its lines directly. Its testable
  // logic (the bare-specifier visibility probe) is extracted into
  // `scripts/lib/bare-specifier-visibility-probe.mjs` and exercised by its own pod. The
  // remaining orchestration is exercised end-to-end by `npm run arch:check:negative` in CI.
  "scripts/arch-check-negative.mjs",
];

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/__tests__/**/*.test.mjs"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    execArgv: ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"],
    maxWorkers: 2,
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "lcov"],
      reportOnFailure: true,
      reportsDirectory: "coverage/scripts",
      include: ["scripts/**/*.{js,mjs}"],
      exclude: [
        ...packageCoverageGateScripts,
        "scripts/__tests__/**",
        "scripts/**/*.config.{js,mjs}",
      ],
    },
  },
});
