import { defineConfig } from "vitest/config";

import packagesCoverageConfig from "./vitest.coverage.packages.config.js";

/**
 * Measurement configuration for a shard of the package coverage suite (Issue #2704).
 *
 * A shard measures; it does not judge (ADR-0156 D1). Vitest evaluates `coverage.thresholds` at the
 * end of every run against the coverage that run produced, so a shard executing a third of the test
 * files would compare its partial view against floors that describe the whole suite and fail on the
 * gate scripts its slice never touches. The floors are therefore evaluated exactly once, by the
 * finalizing `--mergeReports` run, which uses `vitest.coverage.packages.config.ts` unchanged.
 *
 * This file adds nothing. It is the judging configuration with the verdict removed, and
 * `scripts/__tests__/vitest-config-parity.test.mjs` fails if the two drift in any other key.
 *
 * Deliberately written as a single `export default` expression with no top-level statements, the
 * same shape as the judging configuration: a root `*.config.ts` is main scope for SonarCloud but is
 * excluded from every coverage report, so any executable line here would be permanently uncovered
 * new code.
 */
export default defineConfig({
  ...packagesCoverageConfig,
  test: {
    ...packagesCoverageConfig.test,
    coverage: Object.fromEntries(
      Object.entries(packagesCoverageConfig.test?.coverage ?? {}).filter(
        ([option]) => option !== "thresholds",
      ),
    ),
  },
});
