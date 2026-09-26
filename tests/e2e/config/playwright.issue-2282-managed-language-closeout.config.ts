import { defineConfig, devices } from "@playwright/test";
import { delimiter, join } from "node:path";
import { e2eStateDir } from "../support/e2e-state-dir.js";

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32282");
const bffPort = Number(process.env.KEIKO_E2E_BFF_PORT ?? "32283");
const nextPort = Number(process.env.KEIKO_E2E_NEXT_PORT ?? "32284");
const stateId = `issue-2282-managed-language-${process.env.GITHUB_RUN_ID ?? String(process.pid)}`;
const stateDir = e2eStateDir(stateId);
const binDir = join(stateDir, "managed-lsp-bin");
const fixtureConfigPath = join(root, "tests", "e2e", "fixtures", "keiko.e2e.config.json");
const runtimeConfigPath = join(stateDir, "keiko.e2e.config.json");
const lspFixturePath = join(root, "tests", "e2e", "support", "managed-lsp-closeout-server.mjs");

const prepareRuntime = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  `fs.mkdirSync(${JSON.stringify(binDir)}, { recursive: true });`,
  `fs.copyFileSync(${JSON.stringify(fixtureConfigPath)}, ${JSON.stringify(runtimeConfigPath)});`,
  `for (const name of ["pyright-langserver", "gopls"]) {`,
  `const target = path.join(${JSON.stringify(binDir)}, name);`,
  `fs.copyFileSync(${JSON.stringify(lspFixturePath)}, target);`,
  "fs.chmodSync(target, 0o755);",
  "}",
].join(" ");

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "managed-language-closeout-2282.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  preserveOutput: "always",
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(publicPort)}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
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
      `node -e ${JSON.stringify(prepareRuntime)} && ` +
      "npm run build:packages && node scripts/dev-runner.mjs",
    url: `http://127.0.0.1:${String(publicPort)}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "test",
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      KEIKO_DEV_UI_PORT: String(publicPort),
      KEIKO_DEV_BFF_PORT: String(bffPort),
      KEIKO_DEV_NEXT_PORT: String(nextPort),
      KEIKO_DEV_TEST_SKIP_PACKAGE_WATCH: "1",
      KEIKO_DEV_TEST_SKIP_BFF_WATCH: "1",
      KEIKO_DEV_MAX_RESTARTS: "0",
      KEIKO_DEV_NEXT_BUNDLER: "webpack",
      KEIKO_STATE_DIR: stateDir,
      KEIKO_UI_DATA_DIR: join(stateDir, "ui"),
      KEIKO_MEMORY_DIR: join(stateDir, "memory"),
      KEIKO_CONFIG_FILE: runtimeConfigPath,
    },
  },
});
