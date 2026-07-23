import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

import {
  REAL_BINARY_DEFAULT_UI_PORT,
  realBinaryStateDir,
} from "../support/coding-runtime-2483-real-binary.js";

// Issue #2483 — the #2386 Milestone-1 browser journey, now against the staged approved OpenCode
// payload. The web server supplies no resolver, ports, supervisor, or KEIKO_OPENCODE_REAL_* seam;
// buildUiHandlerDeps activates the binary through the production macOS dev-lane discovery path.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? String(REAL_BINARY_DEFAULT_UI_PORT));
const stateDir = realBinaryStateDir();
const prepareState = [
  "const fs = require('node:fs');",
  `fs.rmSync(${JSON.stringify(stateDir)}, { recursive: true, force: true });`,
  `fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });`,
].join(" ");
const serverEntry = join(
  "tests",
  "e2e",
  "servers",
  "dist",
  "tests",
  "e2e",
  "servers",
  "coding-runtime-2483-real-binary-server.mjs",
);

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "code-task-authority.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
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
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1100 } },
    },
  ],
  webServer: {
    cwd: root,
    command:
      `node -e ${JSON.stringify(prepareState)} && ` +
      "npm run build:packages && npm run build:ui && " +
      "node node_modules/@typescript/native/bin/tsc -p tests/e2e/servers/tsconfig.json && " +
      `node ${serverEntry}`,
    url: `http://127.0.0.1:${String(publicPort)}`,
    reuseExistingServer: false,
    timeout: 600_000,
    env: {
      KEIKO_E2E_STATE_DIR: stateDir,
      KEIKO_E2E_UI_PORT: String(publicPort),
      ...(process.env.KEIKO_2483_GATEWAY_OBSERVATION_PATH === undefined
        ? {}
        : {
            KEIKO_2483_GATEWAY_OBSERVATION_PATH: process.env.KEIKO_2483_GATEWAY_OBSERVATION_PATH,
          }),
    },
  },
});
