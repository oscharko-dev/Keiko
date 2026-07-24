import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config.js";

export default defineConfig(baseConfig, {
  testMatch: ["multi-root-editor-2525.spec.ts"],
  timeout: 120_000,
});
