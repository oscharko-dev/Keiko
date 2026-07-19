import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config.js";

export default defineConfig(baseConfig, {
  testMatch: ["per-root-settings-2527.spec.ts"],
  timeout: 120_000,
});
