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
      reporter: ["text", "json", "json-summary"],
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
