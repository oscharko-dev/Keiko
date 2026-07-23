import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

import {
  RESEARCH_DEFAULT_UI_PORT,
  researchStateDir,
} from "../support/coding-runtime-2387-research.js";

// Issue #2387 — governed research / skills / read-only subagents journey. Boots the dedicated
// TEST-ONLY server entry (tests/e2e/servers/coding-runtime-2387-server.mts): the REAL
// buildUiHandlerDeps/createUiServer composition over the real static UI export, with the coding
// runtime resolved through the scripted OpenCode harness in script mode "research" and the
// research egress transport replaced by a hermetic in-process responder (no real network). The
// journey drives: model asks to fetch one public URL → network-egress approval → grant chip →
// governed fetch succeeds → operator revoke → the next ask requires a fresh approval. Mirrors the
// #2386 authority harness conventions; the entry is compiled by the e2e-scoped tsconfig
// (tests/e2e/servers/tsconfig.json) because the scripted harness lives in *_support.ts files that
// are deliberately excluded from the package build.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? String(RESEARCH_DEFAULT_UI_PORT));
const stateDir = researchStateDir();
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
  "coding-runtime-2387-server.mjs",
);

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "code-task-research-skills-subagents.spec.ts",
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
    reuseExistingServer: process.env.KEIKO_E2E_REUSE_SERVER === "1",
    timeout: 600_000,
    env: {
      KEIKO_E2E_STATE_DIR: stateDir,
      KEIKO_E2E_UI_PORT: String(publicPort),
    },
  },
});
