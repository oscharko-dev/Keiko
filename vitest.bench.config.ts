// Benchmark-only Vitest project (CodSpeed).
//
// Held separate from vitest.config.ts on purpose: the test suite's worker bounds, timeouts and
// include globs exist for integration tests that start servers and parse documents, none of which
// applies to the pure-function benchmarks under bench/. Keeping them apart also means the CodSpeed
// plugin is never loaded by an ordinary `npm test` run.
//
// The benchmarks import the workspace packages through their published `exports` surface, so
// `npm run build:packages` must have produced packages/*/dist before this config runs (the `bench`
// script does that; in CI the build is a separate step so it is not measured).
import { defineConfig } from "vitest/config";

import codspeed from "@codspeed/vitest-plugin";

export default defineConfig({
  plugins: [codspeed()],
  test: {
    environment: "node",
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
});
