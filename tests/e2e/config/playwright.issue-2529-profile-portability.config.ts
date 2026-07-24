import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config.js";

export default defineConfig(baseConfig, {
  testMatch: ["profile-portability-2529.spec.ts"],
  timeout: 120_000,
});
