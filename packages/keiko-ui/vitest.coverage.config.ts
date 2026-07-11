import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const uiRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(uiRoot, "..", "..");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(uiRoot, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./packages/keiko-ui/vitest.setup.ts"],
    // GEN-TEST-FLAKE-001: align the CI-gated UI coverage run's per-test timeout with the root suite
    // (vitest.config.ts, 15s). jsdom + v8 instrumentation over 235 UI files makes the default 5s a
    // false-RED risk for the required coverage gate. Parity enforced by
    // scripts/__tests__/vitest-config-parity.test.mjs.
    testTimeout: 15_000,
    include: [
      "packages/keiko-ui/src/app/**/*.test.ts",
      "packages/keiko-ui/src/app/**/*.test.tsx",
      "packages/keiko-ui/src/components/**/*.test.tsx",
      "packages/keiko-ui/src/lib/**/*.test.ts",
      "packages/keiko-ui/src/lib/**/*.test.tsx",
      "packages/keiko-ui/__tests__/**/*.test.ts",
    ],
    exclude: ["node_modules/**", "packages/keiko-ui/out/**", "packages/keiko-ui/.next/**"],
    coverage: {
      provider: "v8",
      // "lcov" feeds SonarCloud CI-based analysis (ADR-0128, sonar.javascript.lcov.reportPaths);
      // the other reporters are unchanged and keep serving the local coverage-baseline ratchet.
      reporter: ["text", "json", "json-summary", "lcov"],
      // Emit the coverage summary even on test failure so the ratchet gate stays computable.
      reportOnFailure: true,
      reportsDirectory: resolve(repoRoot, "packages", "keiko-ui", "coverage"),
      include: ["packages/keiko-ui/src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.*",
        "**/__tests__/**",
        "**/_support.ts",
        "**/test-support.ts",
        "**/test-fixtures.ts",
        "**/testing.ts",
        "packages/keiko-ui/.next/**",
        "packages/keiko-ui/out/**",
      ],
    },
  },
});
