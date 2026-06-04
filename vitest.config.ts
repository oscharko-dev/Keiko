import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    // Fixture target-projects are standalone mini-projects copied to a tmp dir and run by the
    // integration tests via their OWN vitest config; their *.test.ts files (e.g. the
    // bug-investigation fixture's intentionally fail-before regression test) must not be collected
    // into this suite.
    exclude: [
      "**/node_modules/**",
      "tests/fixtures/**",
      "tests/upgrade-smoke/fixture/**",
      "packages/keiko-ui/**",
    ],
    // ADR-0013 D2 site 2 — `node:sqlite` requires --experimental-sqlite on Node 22.0–22.11 builds
    // and emits an ExperimentalWarning on every import on 22.22+ (where the flag is no longer
    // strictly required). The flag covers both, and the warning suppressor keeps test output clean.
    // In vitest 4 the worker-process flags live at test.execArgv (was test.poolOptions in vitest 1).
    execArgv: ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      exclude: ["dist/**", "node_modules/**", "**/*.config.ts"],
    },
  },
});
