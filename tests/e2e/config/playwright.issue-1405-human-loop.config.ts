import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const root = process.cwd();

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "human-loop-1405.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
