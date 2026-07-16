import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue #2253 - isolated unavailable-Codex browser evidence. The three ports deliberately do
// not overlap the #1990/#1991/#1992/#1994 Coding Workbench plans.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32353");
const bffPort = Number(process.env.KEIKO_E2E_BFF_PORT ?? "32354");
const nextPort = Number(process.env.KEIKO_E2E_NEXT_PORT ?? "32355");
const stateId = process.env.GITHUB_RUN_ID ?? `issue-2253-coding-workbench-${String(process.pid)}`;
const stateDir =
  process.env.KEIKO_E2E_STATE_DIR ?? join(realpathSync(tmpdir()), "keiko-e2e", stateId);
const fixtureConfigPath = join(root, "tests", "e2e", "fixtures", "keiko.e2e.config.json");
const runtimeConfigPath = join(stateDir, "keiko.e2e.config.json");
const prepareRuntimeConfig = [
  "const fs = require('node:fs');",
  `fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });`,
  `fs.copyFileSync(${JSON.stringify(fixtureConfigPath)}, ${JSON.stringify(runtimeConfigPath)});`,
].join(" ");

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "coding-workbench-2253.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(publicPort)}`,
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
    command:
      `node -e ${JSON.stringify(prepareRuntimeConfig)} && ` +
      "npm run build:packages && node scripts/dev-runner.mjs",
    url: `http://127.0.0.1:${String(publicPort)}`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      KEIKO_DEV_UI_PORT: String(publicPort),
      KEIKO_DEV_BFF_PORT: String(bffPort),
      KEIKO_DEV_NEXT_PORT: String(nextPort),
      KEIKO_DEV_MAX_RESTARTS: "0",
      KEIKO_DEV_NEXT_BUNDLER: "webpack",
      KEIKO_STATE_DIR: stateDir,
      KEIKO_UI_DATA_DIR: join(stateDir, "ui"),
      KEIKO_MEMORY_DIR: join(stateDir, "memory"),
      KEIKO_CONFIG_FILE: runtimeConfigPath,
    },
  },
});
