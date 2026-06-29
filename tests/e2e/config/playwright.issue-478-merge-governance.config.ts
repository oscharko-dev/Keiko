import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue #478 (Epic #470) — browser evidence that the governed merge surface reaches the governed BFF
// merge path and cannot bypass the readiness/policy gates. Mirrors
// tests/e2e/config/playwright.issue-477-pr-command-center.config.ts: build the packaged CLI, boot the real UI server, run
// a single deterministic chromium worker. The webServer env flag KEIKO_GIT_DELIVERY_ENABLED=true makes
// the governed /api/git-delivery/merge/* routes live in the running app (the spec intercepts the merge
// routes for determinism, but the gate proves the surface reaches the governed BFF merge path rather than
// a no-op stub). Non-gating: ci.yml does not reference this config; it is coordinator evidence.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32199");
const stateId = process.env.GITHUB_RUN_ID ?? `issue-478-merge-governance-${String(process.pid)}`;
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
  testMatch: "merge-governance-478.spec.ts",
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
      // A tall viewport so the maximized merge window's controls are within the page — the desktop
      // window is fixed-positioned, so vertical room must come from the viewport itself.
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
      KEIKO_GIT_DELIVERY_ENABLED: "true",
    },
  },
});
