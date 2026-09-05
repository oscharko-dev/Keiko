import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// Issue #3390: the real-model production-composition harness. Unlike every sibling
// `playwright.coding-issue-*.config.ts`, `webServer.command` never runs a scripted server -- it
// runs `coding-issue-journey-server.mts`, which launches the actual `keiko ui` production factory
// and fails closed (non-zero exit, no server ever bound) when no real Model Gateway/LiteLLM
// profile and controlled repository are configured through
// `tests/e2e/support/coding-issue-journey-config.ts`. Playwright then reports the whole run as
// failed ("Process from config.webServer was not able to start") rather than silently skipping,
// so `npm run test:e2e:coding-issue-journey:live` cannot go green against an unconfigured
// environment.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "4390");
const stateDir = join(root, ".keiko-e2e-state", "coding-issue-journey");

// Live-run pairing fix: `coding-issue-journey-server.mts` and `coding-issue-journey.spec.ts` run
// in SEPARATE processes (the webServer's launched `keiko ui` process, and this test runner's own
// worker process), so the ONE launcher pairing secret both sides must agree on -- the spec mints
// an attestation against it, the launched server verifies it -- can only be handed to both from
// here. Resolved once (operator override honoured, generated otherwise) and written back into
// `process.env` BEFORE `defineConfig` returns: Playwright forks worker processes after this module
// finishes evaluating, inheriting this process's env exactly like `dotenv`-style config setup does,
// so the spec's own `process.env.KEIKO_QUALIFICATION_LAUNCHER_SECRET` read sees the SAME value
// `webServer.env` below hands the launched server. Never logged.
const launcherSecret =
  process.env.KEIKO_QUALIFICATION_LAUNCHER_SECRET ?? randomBytes(32).toString("hex");
process.env.KEIKO_QUALIFICATION_LAUNCHER_SECRET = launcherSecret;
const serverEntry = join(
  "tests",
  "e2e",
  "servers",
  "dist",
  "tests",
  "e2e",
  "servers",
  "coding-issue-journey-server.mjs",
);

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "coding-issue-journey.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 600_000,
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
      "npm run build:packages && npm run build:ui && " +
      "node node_modules/@typescript/native/bin/tsc -p tests/e2e/servers/tsconfig.json && " +
      `node ${serverEntry}`,
    url: `http://127.0.0.1:${String(publicPort)}`,
    reuseExistingServer: process.env.KEIKO_E2E_REUSE_SERVER === "1",
    timeout: 600_000,
    env: {
      KEIKO_E2E_UI_PORT: String(publicPort),
      KEIKO_E2E_STATE_DIR: stateDir,
      KEIKO_STATE_DIR: join(stateDir, "state"),
      KEIKO_LOG_LEVEL: "debug",
      KEIKO_QUALIFICATION_LAUNCHER_SECRET: launcherSecret,
    },
  },
});
