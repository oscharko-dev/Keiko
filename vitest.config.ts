import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Fixture target-projects are standalone mini-projects copied to a tmp dir and run by the
    // integration tests via their OWN vitest config; their *.test.ts files (e.g. the
    // bug-investigation fixture's intentionally fail-before regression test) must not be collected
    // into this suite.
    exclude: ["**/node_modules/**", "tests/fixtures/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      exclude: ["dist/**", "node_modules/**", "**/*.config.ts"],
    },
  },
});
