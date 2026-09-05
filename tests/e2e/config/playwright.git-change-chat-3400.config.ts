import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { e2eStateDir } from "../support/e2e-state-dir.js";

// Issue #3400 (epic #3384) — browser evidence for "Connect a Git change to Chat": the Git
// window's toolbar exposes a "Connect to Chat" action, the resulting dialog resolves the active
// repository's chats and current branch, and a successful connect surfaces the git-change scope
// pill (comparison label, current/stale status, refresh/disconnect) in the target Chat's header.
// Mirrors playwright.issue-1575-git-changes.config.ts: build the packaged CLI, boot the real UI
// server, run a single deterministic chromium worker against a real git fixture and a real chat.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32211");
const stateId = process.env.GITHUB_RUN_ID ?? `git-change-chat-3400-${String(process.pid)}`;
const stateDir = e2eStateDir(stateId);
const fixtureConfigPath = join(root, "tests", "e2e", "fixtures", "keiko.e2e.config.json");
const runtimeConfigPath = join(stateDir, "keiko.e2e.config.json");
const prepareRuntimeConfig = [
  "const fs = require('node:fs');",
  `fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });`,
  `fs.copyFileSync(${JSON.stringify(fixtureConfigPath)}, ${JSON.stringify(runtimeConfigPath)});`,
].join(" ");

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "git-change-chat-3400.spec.ts",
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
      // Wide enough for the Git window and the Chat window to sit side by side, matching the
      // seeded window layout (git-change-chat-3400.ts).
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 900 } },
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
