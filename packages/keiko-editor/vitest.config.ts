import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The package ships pure, framework-free helpers (node-testable) plus the React-based
// `KeikoCodeEditor` shell (#1194), which requires a DOM. Both run under one jsdom config:
// the existing pure `*.test.ts` suites are environment-agnostic and behave identically in
// jsdom, while the component `*.test.tsx` suites need the DOM + the React JSX transform.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // GEN-TEST-FLAKE-001: align with the hardened 15s timeout; parity enforced by
    // scripts/__tests__/vitest-config-parity.test.mjs.
    testTimeout: 15_000,
  },
});
