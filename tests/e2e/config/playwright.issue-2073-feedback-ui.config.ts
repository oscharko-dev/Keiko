import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue #2073 (Epic #2070) - packaged CLI/BFF proof for the governed feedback journey.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32213");
const stateId = process.env.GITHUB_RUN_ID ?? `issue-2073-feedback-ui-${String(process.pid)}`;
const stateDir = process.env.KEIKO_E2E_STATE_DIR ?? join(tmpdir(), "keiko-e2e", stateId);
const fixtureConfigPath = join(root, "tests", "e2e", "fixtures", "keiko.e2e.config.json");
const runtimeConfigPath = join(stateDir, "keiko.e2e.config.json");
const prepareRuntimeConfig = [
  "const fs = require('node:fs');",
  `fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });`,
  `fs.copyFileSync(${JSON.stringify(fixtureConfigPath)}, ${JSON.stringify(runtimeConfigPath)});`,
].join(" ");

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: /feedback-(?:flow|attachments|evidence)-2073\.spec\.ts/u,
  fullyParallel: false,
  workers: 1,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(publicPort)}`,
    actionTimeout: 20_000,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 980 } },
    },
  ],
  webServer: {
    cwd: root,
    command:
      `node -e ${JSON.stringify(prepareRuntimeConfig)} && ` +
      "npm run build && npm run prepare:bin && npm run build:ui && " +
      `node dist/cli/index.js ui --port ${String(publicPort)} ` +
      `--config ${runtimeConfigPath} ` +
      `--ui-db ${join(stateDir, "ui", "ui.sqlite")}`,
    url: `http://127.0.0.1:${String(publicPort)}`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      KEIKO_STATE_DIR: stateDir,
      KEIKO_UI_DATA_DIR: join(stateDir, "ui"),
      KEIKO_MEMORY_DIR: join(stateDir, "memory"),
      KEIKO_CONFIG_FILE: runtimeConfigPath,
    },
  },
});
