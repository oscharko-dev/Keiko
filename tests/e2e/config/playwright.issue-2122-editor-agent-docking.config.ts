import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config.js";

export default defineConfig(baseConfig, {
  testMatch: ["editor-chat-roundtrip-2119.spec.ts", "editor-agent-docking-2122.spec.ts"],
  timeout: 120_000,
});
