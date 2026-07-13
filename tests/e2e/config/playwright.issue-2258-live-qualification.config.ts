import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const root = process.cwd();
const port = 32458;

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "coding-workbench-2258-live.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  outputDir: join(root, "test-results", "issue-2258-live"),
  use: {
    baseURL: `http://127.0.0.1:${String(port)}`,
    // Axe is injected by Playwright into the isolated test browser only. Keep the real server CSP
    // intact while allowing that test-only audit instrumentation to execute.
    bypassCSP: true,
    trace: "retain-on-failure",
    video: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: {
    cwd: root,
    command: "npm run launch:functional:opencode-2258",
    url: `http://127.0.0.1:${String(port)}`,
    reuseExistingServer: process.env.KEIKO_2258_REUSE_LIVE_SERVER === "1",
    timeout: 300_000,
  },
});
