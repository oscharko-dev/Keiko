import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const root = process.cwd();

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "editor-agent-1296.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: { trace: "off", video: "off", screenshot: "off" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
