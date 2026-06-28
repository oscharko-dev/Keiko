import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue #1576 (Epic #1571) — browser evidence for the Git client Branch, History, and
// Sync workflows. The harness builds the packaged CLI, boots the real UI server, seeds the real
// governedGit window, and uses a hermetic local bare repository fixture. The read/sync routes are
// intercepted with deterministic JSON derived from the local fixture shape so no external remote,
// credentials, or provider API is used.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32201");
const stateId = process.env.GITHUB_RUN_ID ?? `issue-1576-git-branch-sync-${String(process.pid)}`;
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
  testMatch: "git-branch-sync-1576.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(publicPort)}`,
    trace: "off",
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
      KEIKO_GIT_DELIVERY_ENABLED: "true",
    },
  },
});
