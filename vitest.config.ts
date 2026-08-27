import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  // KEIKO-0251: the editor's component tests are .test.tsx and need JSX transformed. Without this
  // plugin the include entry below collects the files and then fails to parse them.
  plugins: [react()],
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      // KEIKO-0251: the editor package owns React/Monaco component shells whose tests are
      // file-level jsdom .test.tsx. They were collected only by vitest.coverage.packages.config.ts,
      // so `npm test` and `conversation:release-check` went green without ever running the two
      // a11y suites or the GEN-PERF-EDITOR-005 per-keystroke allocation pin. Keep this entry and
      // the coverage config's in lockstep — vitest-config-parity.test.mjs pins that they match.
      "packages/keiko-editor/src/**/*.test.tsx",
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
      // The root vitest config's coverage output is not consumed by any gate — the three LCOV
      // reports SonarCloud and check-lcov-source-mapping.mjs ingest are produced by the scoped
      // configs vitest.coverage.packages.config.ts, packages/keiko-ui/vitest.coverage.config.ts,
      // and vitest.coverage.scripts.config.ts (see scripts/check-lcov-source-mapping.mjs's
      // defaultReports and sonar-project.properties). Pin the reports directory so an unscoped
      // `vitest run --coverage` against this config cannot recursively delete `coverage/packages`
      // or `coverage/scripts` (KEIKO-0580).
      reportsDirectory: "coverage/root",
      reporter: ["text", "json"],
      exclude: ["dist/**", "node_modules/**", "**/*.config.ts", "**/*.test.*", "**/__tests__/**"],
    },
  },
});
