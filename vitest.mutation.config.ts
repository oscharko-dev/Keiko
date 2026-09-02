import { defineConfig, mergeConfig } from "vitest/config";

import rootConfig from "./vitest.config";

/**
 * The vitest configuration the security mutation lanes run (ADR-0148).
 *
 * Stryker's `testFiles` list is bookkeeping for runners that support it; the vitest runner does not
 * filter with it — it hands execution to vitest, which collects from the vitest config's own
 * `include`. So the `!(*.functional)` exclusion the Stryker configs declare never applied, and a
 * 120-second end-to-end OpenCode pipeline ran inside the mutation DRY RUN, where a single failure
 * aborts the whole lane before a single mutant is scored. That is what broke the scheduled lane on
 * `dev` (#3349): the suite did not regress, it never started.
 *
 * The declared scope is enforced here, where vitest actually reads it. Functional pipelines are
 * end-to-end journeys with child processes and their own timeouts; they cover none of the mutated
 * security modules, so excluding them narrows nothing that the mutation score measures.
 */
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      exclude: ["**/*.functional.test.ts"],
    },
  }),
);
