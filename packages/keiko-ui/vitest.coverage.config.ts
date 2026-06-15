import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(here, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "src/app/**/*.test.ts",
      "src/app/**/*.test.tsx",
      "src/components/**/*.test.tsx",
      "src/lib/**/*.test.ts",
      "src/lib/**/*.test.tsx",
      "__tests__/**/*.test.ts",
    ],
    exclude: ["node_modules/**", "out/**", ".next/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.*",
        "**/__tests__/**",
        "**/_support.ts",
        "**/test-support.ts",
        "**/test-fixtures.ts",
        "**/testing.ts",
        ".next/**",
        "out/**",
      ],
    },
  },
});
