import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config.js";

export default defineConfig(baseConfig, {
  testMatch: ["multi-root-search-2526.spec.ts"],
  timeout: 120_000,
});
