import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // KEIKO-0932: dropped the redundant `exclude` line. It replaced vitest's built-in default
    // exclude set (which already covers node_modules and dist) rather than extending it, and the
    // anchored `include: ["src/**/*.test.ts"]` above already prevents any node_modules/dist file
    // from being collected — so the extra declaration was unreachable configuration.
    //
    // KEIKO-0889: node:sqlite requires --experimental-sqlite on Node 22.0–22.11 and emits
    // ExperimentalWarning on 22.12+ (ADR-0013 D2). This package owns
    // src/local-knowledge-schema.test.ts which imports `node:sqlite`, so the flags must be set
    // here — matching the identical block in packages/keiko-local-knowledge/vitest.config.ts.
    execArgv: ["--experimental-sqlite", "--disable-warning=ExperimentalWarning"],
  },
});
