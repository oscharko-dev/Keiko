import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      // The editor package owns React/Monaco component shells with file-level jsdom tests. Include
      // them in package coverage so the branch ratchet measures the lifecycle code it gates.
      "packages/keiko-editor/src/**/*.test.tsx",
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
