import { defineConfig } from "vitest/config";

// Capture-layer tests are pure-function — no node:sqlite, no fs, no clock. The per-package
// vitest runner exists so contributors can iterate on a single package without paying for the
// root-level build:packages chain on every save.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
