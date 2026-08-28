import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue #1386 — Files-window coverage for status/diff rendering and the transition from a
// non-repository parent into a nested Git project. The spec intercepts the status and diff reads;
// this owned config keeps it collected and runs it against the same packaged UI shape as the
// adjacent #1575 Git Changes suite.
const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32210");
const stateId = process.env.GITHUB_RUN_ID ?? `issue-1386-git-status-${String(process.pid)}`;
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
  testMatch: "git-status-1386.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(publicPort)}`,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
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
