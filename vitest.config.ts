import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup/process-environment.ts"],
    include: [
      "tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      // Issue #287: the QI supply-chain gate is a Node ESM script (.mjs), so its harness
      // tests are .test.mjs and live under scripts/__tests__/ next to the script itself.
      "scripts/__tests__/**/*.test.mjs",
    ],
    // Fixture target-projects are standalone mini-projects copied to a tmp dir and run by the
    // integration tests via their OWN vitest config; their *.test.ts files (e.g. the
    // bug-investigation fixture's intentionally fail-before regression test) must not be collected
    // into this suite.
    exclude: ["**/node_modules/**", "tests/fixtures/**", "packages/keiko-ui/**"],
    // ADR-0013 D2 site 2 — `node:sqlite` requires --experimental-sqlite on Node 22.0–22.11 builds
    // and emits an ExperimentalWarning on every import on the Node.js 24 baseline (where the flag is no longer
    // strictly required). The flag covers both, and the warning suppressor keeps test output clean.
    // In vitest 4 the worker-process flags live at test.execArgv (was test.poolOptions in vitest 1).
    execArgv: ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"],
    // GEN-TEST-FLAKE-002: the root suite has integration tests that start servers, parse PDFs, and
    // create/remove large temporary fixture trees. Letting Vitest fan out across every local core can
    // starve those tests enough to false-RED the verify receipt, so keep file parallelism bounded.
    maxWorkers: 2,
    // The root suite includes integration-style tests that bind local servers, create git worktrees,
    // and parse binary documents. Keep a bounded timeout, but align the default with existing
    // integration-test allowances so full-suite scheduler load does not produce false red receipts.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      // lcov is additive: check-lcov-source-mapping.mjs reads coverage/lcov.info to prove
      // changed root-level scripts/*.mjs sources (outside packages/, which has its own scoped
      // coverage run) are exercised by their scripts/__tests__/*.test.mjs harness.
      reporter: ["text", "json", "lcov"],
      exclude: ["dist/**", "node_modules/**", "**/*.config.ts"],
    },
  },
});
