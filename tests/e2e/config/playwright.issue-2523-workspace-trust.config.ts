import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config.js";

export default defineConfig(baseConfig, {
  testMatch: ["workspace-trust-2523.spec.ts"],
  timeout: 120_000,
});
