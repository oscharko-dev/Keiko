import { defineConfig, devices } from "@playwright/test";

const port = 4216;

export default defineConfig({
  testDir: "..",
  testMatch: "maintainer-review-2076.spec.ts",
  timeout: 30_000,
  reporter: [["line"], ["../support/maintainer-review-2076-reporter.ts"]],
  projects: [
    {
      name: "chromium",
      use: { baseURL: `http://127.0.0.1:${String(port)}`, ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      "cd ../../.. && npm run build --workspace @oscharko-dev/keiko-feedback-intake && node tests/e2e/support/maintainer-review-2076-server.mjs",
    port,
    reuseExistingServer: false,
  },
});
