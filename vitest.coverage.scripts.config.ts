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
];

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/__tests__/**/*.test.mjs"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "scripts/__tests__/check-package-surface.test.mjs",
    ],
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
