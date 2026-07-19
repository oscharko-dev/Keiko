import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config.js";

export default defineConfig(baseConfig, {
  testMatch: ["editor-profiles-2528.spec.ts"],
  timeout: 120_000,
});
