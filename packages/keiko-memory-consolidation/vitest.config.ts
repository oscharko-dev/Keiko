import { defineConfig } from "vitest/config";

// Consolidation-layer tests are pure-function — no node:sqlite, no fs, no clock, no randomness.
// The per-package vitest runner lets contributors iterate on a single package without paying for
// the root-level build:packages chain on every save.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
