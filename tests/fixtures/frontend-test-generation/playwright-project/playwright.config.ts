import { defineConfig } from "@playwright/test";

// Presence of this config is one of the signals the detector uses to recognise a Playwright project.
export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:3000",
  },
});
