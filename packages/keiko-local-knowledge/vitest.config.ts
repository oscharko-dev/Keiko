import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // node:sqlite requires --experimental-sqlite on Node 22.0–22.11 and emits
    // ExperimentalWarning on 22.12+. The flag is a no-op once Node 24 stabilises the
    // API; the warning suppressor keeps test output clean in the interim.
    execArgv: ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"],
  },
});
