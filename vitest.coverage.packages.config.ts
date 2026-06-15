import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "scripts/__tests__/**/*.test.mjs",
    ],
    exclude: ["**/node_modules/**", "tests/fixtures/**", "packages/keiko-ui/**"],
    execArgv: ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "coverage/packages",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: [
        "packages/keiko-ui/**",
        "**/*.test.*",
        "**/__tests__/**",
        "**/_support.ts",
        "**/test-support.ts",
        "**/test-fixtures.ts",
        "**/testing.ts",
        "**/*.config.ts",
        "dist/**",
        "node_modules/**",
      ],
    },
  },
});
