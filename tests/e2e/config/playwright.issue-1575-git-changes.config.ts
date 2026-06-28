import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue #1575 (Epic #1571) — browser evidence that the Git "Changes" view renders all six file
// states (modified, added, deleted, renamed, untracked, conflicted), exposes the correct staging
// controls and header counters, opens a diff with scope controls, and surfaces the commit composer.
// Mirrors playwright.issue-475-git-delivery.config.ts: build the packaged CLI, boot the real UI
// server, run a single deterministic chromium worker. The webServer env flag
// KEIKO_GIT_DELIVERY_ENABLED=true makes the governed /api/git-delivery/staging/* routes live so the
// spec can also verify staging-mutation intercept for determinism on the mutation assertions.
// The read surface (/api/git/status + /api/git/diff) is intercepted with a deterministic fixture
// carrying all six change states, so the assertion is stable across environments and CI machines
// that may not have the git binary in the expected location.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32200");
const stateId = process.env.GITHUB_RUN_ID ?? `issue-1575-git-changes-${String(process.pid)}`;
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
  testMatch: "git-changes-view-1575.spec.ts",
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
      // A tall, wide viewport: the Git window is maximised so every panel (sidebar + diff pane +
      // commit composer) is visible without scrolling the fixed-positioned window chrome.
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
