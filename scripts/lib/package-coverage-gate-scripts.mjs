// The eight top-level Node ESM gate scripts whose per-file coverage floors are ratcheted from
// the packages coverage run and enforced by scripts/check-package-coverage.mjs. Both root
// coverage configurations reference this list — the packages config to INCLUDE them in
// coverage/packages/lcov.info, and the scripts config to EXCLUDE them from
// coverage/scripts/lcov.info. Keeping the two halves in one place means a new gate script
// (or removing one) touches exactly one file, and scripts/__tests__/vitest-config-parity
// enforces the partition property so a stray addition to one side fails closed instead of
// drifting silently. arch-check-negative.mjs is deliberately excluded from BOTH runs (v8
// coverage cannot cross its spawnSync subprocess boundary); its testable logic lives in
// scripts/lib/bare-specifier-visibility-probe.mjs, and it stays as a separate entry only in
// the scripts-run exclude list, backed by NON_LCOV_SCRIPTS in scripts/sonar-analysis-scope.mjs.
export const PACKAGE_COVERAGE_GATE_SCRIPTS = Object.freeze([
  "scripts/check-lcov-source-mapping.mjs",
  "scripts/check-mutation-quality.mjs",
  "scripts/check-mutation-scope.mjs",
  "scripts/check-sonar-analysis-log.mjs",
  "scripts/check-sonar-main-quality-gate.mjs",
  "scripts/check-sonar-pr-quality-gate.mjs",
  "scripts/sonar-analysis-scope.mjs",
  "scripts/sonar-quality-gate-contract.mjs",
]);
