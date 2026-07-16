import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

import { TRACER_DEFAULT_UI_PORT, tracerStateDir } from "../support/coding-runtime-2385-tracer.js";

// Issue #2385 — Code Task OpenCode tracer. Boots the dedicated TEST-ONLY server entry
// (tests/e2e/servers/coding-runtime-2385-server.mts): the REAL buildUiHandlerDeps/createUiServer
// composition over the real static UI export, with the coding runtime resolved through the scripted
// OpenCode harness (in-process loopback HTTP/SSE child + scripted model gateway) exactly as
// packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional.test.ts wires it.
// Mirrors the issue-446/issue-2257 harness conventions: repository paths from process.cwd(),
// absolute testDir at tests/e2e, webServer.cwd at the repository root, one deterministic chromium
// worker. The entry is compiled by an e2e-scoped tsconfig (tests/e2e/servers/tsconfig.json) because
// the scripted harness lives in *_support.ts files that are deliberately excluded from the package
// build and therefore absent from dist.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? String(TRACER_DEFAULT_UI_PORT));
const stateDir = tracerStateDir();
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
  "coding-runtime-2385-server.mjs",
);

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "code-task-opencode-tracer.spec.ts",
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
