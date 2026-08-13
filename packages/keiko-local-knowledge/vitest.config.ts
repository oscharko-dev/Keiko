import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // node:sqlite requires --experimental-sqlite on Node 22.0–22.11 and emits
    // ExperimentalWarning on 22.12+. The flag is a no-op once Node 24 stabilises the
    // API; the warning suppressor keeps test output clean in the interim.
    execArgv: ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"],
    // GEN-TEST-FLAKE-002: this package parses PDFs (pdfjs-dist) and owns sqlite-backed
    // capsule-store tests; keep file parallelism bounded to avoid scheduler starvation
    // producing false-red receipts on the package-scoped narrow-gate workflow AGENTS.md
    // recommends over running the full suite.
    maxWorkers: 2,
    // GEN-TEST-FLAKE-001: align the default with the root suite's hardened timeout so
    // package-scoped runs of the PDF / progressive-document / sqlite tests do not fall
    // back to vitest's 5s default under scheduler load.
    testTimeout: 15_000,
  },
});
