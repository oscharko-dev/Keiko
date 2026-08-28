import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { createE2eDapOperatorProvisioning } from "../support/dapOperatorProvisioning.js";
import { e2eStateDir } from "../support/e2e-state-dir.js";

const root = process.cwd();
const port = Number(process.env.KEIKO_E2E_DEBUG_UI_PORT ?? "32283");
const stateId = process.env.GITHUB_RUN_ID ?? `editor-debugging-2348-${String(process.pid)}`;
const stateDir = e2eStateDir(stateId);
const fixtureDir = join(root, "tests", "e2e", "fixtures", "editor-debugging-2348");
const runtimeConfigPath = join(stateDir, "keiko.e2e.config.json");
const provisioning = createE2eDapOperatorProvisioning({
  adapterFixturePath: join(fixtureDir, "dap-socket-adapter.fixture"),
  stateDir,
});
const fixtureConfigPath = join(root, "tests", "e2e", "fixtures", "keiko.e2e.config.json");
const prepareRuntimeConfig = [
  "const fs = require('node:fs');",
  `fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true, mode: 0o700 });`,
  `fs.copyFileSync(${JSON.stringify(fixtureConfigPath)}, ${JSON.stringify(runtimeConfigPath)});`,
].join(" ");

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "editor-debugging-2348.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(port)}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    cwd: root,
    command:
      `node -e ${JSON.stringify(prepareRuntimeConfig)} && ` +
      "npm run build && npm run prepare:bin && npm run build:ui && " +
      `node dist/cli/index.js ui --port ${String(port)} --config ${runtimeConfigPath} ` +
      `--ui-db ${join(stateDir, "ui", "ui.sqlite")}`,
    url: `http://127.0.0.1:${String(port)}`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      KEIKO_DAP_OPERATOR_PROVISIONING_JSON: provisioning,
      KEIKO_MEMORY_DIR: join(stateDir, "memory"),
      KEIKO_STATE_DIR: stateDir,
      KEIKO_UI_DATA_DIR: join(stateDir, "ui"),
    },
  },
});
