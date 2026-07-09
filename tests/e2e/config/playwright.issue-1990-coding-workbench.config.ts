import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32290");
const bffPort = Number(process.env.KEIKO_E2E_BFF_PORT ?? "32291");
const nextPort = Number(process.env.KEIKO_E2E_NEXT_PORT ?? "32292");
const stateId = process.env.GITHUB_RUN_ID ?? `issue-1990-coding-workbench-${String(process.pid)}`;
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
  testMatch: "coding-workbench-1990.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(publicPort)}`,
    trace: "retain-on-failure",
    video: "off",
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
    timeout: 120_000,
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
