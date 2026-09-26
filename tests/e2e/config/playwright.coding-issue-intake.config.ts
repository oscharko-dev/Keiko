import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

import { ISSUE_INTAKE_PORT, issueIntakeStateDir } from "../support/coding-issue-intake.js";

// Issue #3385: actual mounted preview/provision/run routes, real temporary Git worktrees,
// deterministic provider boundary, and browser visual/accessibility evidence.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? String(ISSUE_INTAKE_PORT));
const stateDir = issueIntakeStateDir();
const prepareState = [
  "const fs = require('node:fs');",
  `fs.rmSync(${JSON.stringify(stateDir)}, { recursive: true, force: true });`,
  `fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });`,
].join(" ");
const serverEntry = join(
  "tests",
  "e2e",
  "servers",
  "dist",
  "tests",
  "e2e",
  "servers",
  "coding-issue-intake-server.mjs",
);

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "coding-issue-intake.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 360_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    actionTimeout: 30_000,
    baseURL: `http://127.0.0.1:${String(publicPort)}`,
    trace: "retain-on-failure",
    video: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1100 } },
    },
  ],
  webServer: {
    cwd: root,
    command:
      `node -e ${JSON.stringify(prepareState)} && ` +
      "npm run build:packages && npm run build:ui && " +
      "node node_modules/@typescript/native/bin/tsc -p tests/e2e/servers/tsconfig.json && " +
      `node ${serverEntry}`,
    url: `http://127.0.0.1:${String(publicPort)}`,
    reuseExistingServer: process.env.KEIKO_E2E_REUSE_SERVER === "1",
    timeout: 600_000,
    env: {
      KEIKO_E2E_STATE_DIR: stateDir,
      KEIKO_E2E_UI_PORT: String(publicPort),
      KEIKO_STATE_DIR: join(stateDir, "bff-state", "state"),
      KEIKO_LOG_LEVEL: "debug",
    },
  },
});
