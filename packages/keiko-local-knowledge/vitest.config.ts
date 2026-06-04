import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // node:sqlite needs --experimental-sqlite on Node 22.0–22.11 and emits an
    // ExperimentalWarning on 22.22+. The flag covers both; the warning suppressor
    // keeps test output clean. Same pattern as packages/keiko-server/vitest.config.ts.
    execArgv: ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"],
  },
});
