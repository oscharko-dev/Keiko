import { describe, expect, it } from "vitest";

describe("Local Knowledge Playwright configuration", () => {
  it("keeps the prebuilt package graph and BFF stable for hermetic E2E", async () => {
    const originalCorpusRoot = process.env.KEIKO_LK_E2E_CORPUS;
    try {
      const { default: localKnowledgeConfig } =
        await import("../e2e/config/playwright.local-knowledge-regression.config.js");
      const webServer = localKnowledgeConfig.webServer;
      if (webServer === undefined || Array.isArray(webServer)) {
        throw new Error("Expected one Local Knowledge Playwright web server");
      }

      expect(webServer.env).toMatchObject({
        NODE_ENV: "test",
        KEIKO_DEV_TEST_SKIP_PACKAGE_WATCH: "1",
        KEIKO_DEV_TEST_SKIP_BFF_WATCH: "1",
      });
    } finally {
      if (originalCorpusRoot === undefined) {
        delete process.env.KEIKO_LK_E2E_CORPUS;
      } else {
        process.env.KEIKO_LK_E2E_CORPUS = originalCorpusRoot;
      }
    }
  });
});
