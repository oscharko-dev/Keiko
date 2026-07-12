import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

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
        "packages/keiko-server/src/qualityIntelligence/**/*.test.ts",
        "packages/keiko-workflows/src/**/*.test.ts",
      ]),
    );
    expect(config.concurrency).toBe(16);
  });
});
