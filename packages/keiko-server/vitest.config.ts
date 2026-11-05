import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // #3532: explicit Activity Log test-writer injection, identical to the root suite.
    setupFiles: [
      fileURLToPath(new URL("../../tests/support/activity-log-test-writer.ts", import.meta.url)),
    ],
  },
});
