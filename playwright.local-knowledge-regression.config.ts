import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const publicPort = Number(process.env.KEIKO_LK_E2E_UI_PORT ?? "42183");
const bffPort = Number(process.env.KEIKO_LK_E2E_BFF_PORT ?? "42184");
const nextPort = Number(process.env.KEIKO_LK_E2E_NEXT_PORT ?? "42185");
const corpusRoot =
  process.env.KEIKO_LK_E2E_CORPUS ?? "/Users/oscharko-dev/Keiko-Test-Data/Local-Knowledge-E2E";
const stateDir = process.env.KEIKO_LK_E2E_STATE_DIR ?? join(corpusRoot, "state");

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /local-knowledge-regression\.spec\.ts/u,
  fullyParallel: false,
  workers: 1,
  timeout: 90 * 60_000,
  expect: {
    timeout: 30_000,
  },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(publicPort)}`,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run build:packages && node scripts/dev-runner.mjs",
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
      // Issue #1286: drive the bounded large-document path for any PDF so the regression exercises
      // progressive extraction + bounded chunk/embed + the large-document health UI without needing
      // a multi-hundred-MiB binary fixture.
      KEIKO_LK_LARGE_DOC_THRESHOLD_BYTES: process.env.KEIKO_LK_LARGE_DOC_THRESHOLD_BYTES ?? "1024",
    },
  },
});
