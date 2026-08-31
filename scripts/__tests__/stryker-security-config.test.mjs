import { globSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const OPENCODE_FUNCTIONAL_TEST =
  "packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional.test.ts";

async function loadSecurityMutationConfig() {
  return JSON.parse(await readFile("stryker.security.conf.json", "utf8"));
}

describe("security mutation Stryker configuration", () => {
  it("runs the focused security test matrix instead of Vitest related-test discovery", async () => {
    const config = await loadSecurityMutationConfig();

    expect(config.vitest).toMatchObject({
      configFile: "vitest.config.ts",
      related: false,
    });
    expect(config.coverageAnalysis).toBe("perTest");
    expect(config.testFiles).toEqual(
      expect.arrayContaining([
        "packages/keiko-evidence/src/**/*.test.ts",
        "packages/keiko-model-gateway/src/**/*.test.ts",
        "packages/keiko-sandbox/src/backends.test.ts",
        "packages/keiko-sandbox/src/index.test.ts",
        "packages/keiko-sandbox/src/plan.test.ts",
        "packages/keiko-sandbox/src/probe.test.ts",
        "packages/keiko-sandbox/src/select.test.ts",
        "packages/keiko-server/src/coding-runtime/**/!(*.functional).test.ts",
        "packages/keiko-server/src/qualityIntelligence/**/*.test.ts",
        "packages/keiko-workflows/src/**/*.test.ts",
      ]),
    );
    expect(config.testFiles).not.toContain("packages/keiko-sandbox/src/egress.test.ts");
    expect(config.concurrency).toBe(16);
  });

  it("keeps the OpenCode functional pipeline out of the mutation dry-run", async () => {
    const config = await loadSecurityMutationConfig();
    const codingRuntimePattern =
      "packages/keiko-server/src/coding-runtime/**/!(*.functional).test.ts";

    expect(globSync(OPENCODE_FUNCTIONAL_TEST)).toEqual([OPENCODE_FUNCTIONAL_TEST]);
    expect(config.ignorePatterns).toBeUndefined();
    expect(config.testFiles).toContain(codingRuntimePattern);
    expect(globSync("packages/keiko-server/src/coding-runtime/**/*.test.ts")).toContain(
      OPENCODE_FUNCTIONAL_TEST,
    );
    expect(globSync(codingRuntimePattern)).not.toContain(OPENCODE_FUNCTIONAL_TEST);
    const codingRuntimeTests = globSync("packages/keiko-server/src/coding-runtime/**/*.test.ts");
    const selectedCodingRuntime = globSync(codingRuntimePattern);
    expect(selectedCodingRuntime.length).toBeGreaterThan(0);
    for (const file of codingRuntimeTests) {
      if (file.endsWith(".functional.test.ts")) {
        expect(selectedCodingRuntime).not.toContain(file);
      } else {
        expect(selectedCodingRuntime).toContain(file);
      }
    }
    expect(config.testFiles.flatMap((pattern) => globSync(pattern))).not.toContain(
      OPENCODE_FUNCTIONAL_TEST,
    );
  });
});
