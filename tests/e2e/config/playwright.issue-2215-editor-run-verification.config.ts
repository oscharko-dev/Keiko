import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config.js";

export default defineConfig(baseConfig, {
  testMatch: ["editor-run-verification-2215.spec.ts"],
  timeout: 120_000,
});
