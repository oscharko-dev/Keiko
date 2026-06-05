import { defineConfig } from "vitest/config";

// node:sqlite is a Node 22 built-in surfaced behind `--experimental-sqlite`. Surfacing the flag
// on the per-package vitest runner matches the keiko-server/store pattern so the test runner does
// not depend on a parent process having set the flag.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
