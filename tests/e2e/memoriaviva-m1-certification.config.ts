import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32551");
const bffPort = Number(process.env.KEIKO_E2E_BFF_PORT ?? "32552");
const nextPort = Number(process.env.KEIKO_E2E_NEXT_PORT ?? "32553");
const modelPort = Number(process.env.KEIKO_E2E_MODEL_PORT ?? "32554");
const stateId = `memoriaviva-m1-${process.env.GITHUB_RUN_ID ?? String(process.pid)}`;
const stateDir =
  process.env.KEIKO_E2E_STATE_DIR ?? join(realpathSync(tmpdir()), "keiko-e2e", stateId);
const fixtureConfigPath = join(root, "tests", "e2e", "fixtures", "keiko.e2e.config.json");
const runtimeConfigPath = join(stateDir, "keiko.e2e.config.json");
const modelMock = join(
  root,
  "tests",
  "e2e",
  "support",
  "memoriaviva-m1-certification-model-mock.mjs",
);
const modelBaseUrl = `http://127.0.0.1:${String(modelPort)}/v1`;
const prepareRuntimeConfig = [
  "const fs = require('node:fs');",
  `fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });`,
  `const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(fixtureConfigPath)}, 'utf8'));`,
  `for (const provider of cfg.providers ?? []) { provider.baseUrl = ${JSON.stringify(modelBaseUrl)}; }`,
  `fs.writeFileSync(${JSON.stringify(runtimeConfigPath)}, JSON.stringify(cfg, null, 2));`,
].join(" ");

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "memoriaviva-m1-certification.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(publicPort)}`,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 1000 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      cwd: root,
      command: `node ${JSON.stringify(modelMock)}`,
      url: `http://127.0.0.1:${String(modelPort)}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { KEIKO_E2E_MODEL_PORT: String(modelPort) },
    },
    {
      cwd: root,
      command:
        `node -e ${JSON.stringify(prepareRuntimeConfig)} && ` +
        "npm run build:packages && node scripts/dev-runner.mjs",
      url: `http://127.0.0.1:${String(publicPort)}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: "test",
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
        KEIKO_CODING_DEPLOYMENT_CEILING: "autonomous-delivery",
      },
    },
  ],
});
