import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirror the tsconfig paths alias so vitest resolves @/* correctly. After the issue-167
      // src-directory move, both the alias and the include globs are rooted at ./src.
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
    ],
    exclude: ["node_modules/**", "out/**", ".next/**"],
  },
});
