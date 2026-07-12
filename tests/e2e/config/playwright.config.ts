import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32183");
const bffPort = Number(process.env.KEIKO_E2E_BFF_PORT ?? "32184");
const nextPort = Number(process.env.KEIKO_E2E_NEXT_PORT ?? "32185");
// GEN-TEST-RELEASE-GATE-002: deterministic loopback model provider port for the chat send smoke.
const modelPort = Number(process.env.KEIKO_E2E_MODEL_PORT ?? "32186");
const modelMockScript = join(root, "tests", "e2e", "support", "model-mock-server.mjs");
const modelBaseUrl = `http://127.0.0.1:${String(modelPort)}/v1`;
const stateId = process.env.GITHUB_RUN_ID ?? String(process.pid);
const stateDir =
  process.env.KEIKO_E2E_STATE_DIR ?? join(realpathSync(tmpdir()), "keiko-e2e", stateId);
const fixtureConfigPath = join(root, "tests", "e2e", "fixtures", "keiko.e2e.config.json");
const runtimeConfigPath = join(stateDir, "keiko.e2e.config.json");
// GEN-TEST-RELEASE-GATE-002: copy the fixture config but repoint every provider baseUrl at the
// deterministic loopback mock so a real chat send reaches a reachable, byte-deterministic provider
// instead of the intentionally-unreachable https://provider.invalid. The gateway egress policy
// permits loopback and the config schema permits http:// for loopback hosts, so no product code
// changes. Non-sending smoke specs are unaffected (they never dispatch a model call).
const prepareRuntimeConfig = [
  "const fs = require('node:fs');",
  `fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });`,
  `const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(fixtureConfigPath)}, 'utf8'));`,
  `for (const provider of cfg.providers ?? []) { provider.baseUrl = ${JSON.stringify(modelBaseUrl)}; }`,
  `fs.writeFileSync(${JSON.stringify(runtimeConfigPath)}, JSON.stringify(cfg, null, 2));`,
].join(" ");

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(publicPort)}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    // GEN-TEST-RELEASE-GATE-002: the deterministic model provider must be up before a chat send
    // dispatches. It is a tiny loopback HTTP server (no build), so it starts fast and independently.
    {
      cwd: root,
      command: `node ${JSON.stringify(modelMockScript)}`,
      url: `http://127.0.0.1:${String(modelPort)}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        KEIKO_E2E_MODEL_PORT: String(modelPort),
      },
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
        // The Playwright webServer command already runs a deterministic one-shot package build
        // before starting the dev runner. Starting the dev runner's package watch in the same E2E
        // process can rewrite packages/*/dist while the BFF is running under node --watch, producing
        // transient API 502s exactly as browser tests begin. Keep E2E on the hermetic, prebuilt graph.
        KEIKO_DEV_TEST_SKIP_PACKAGE_WATCH: "1",
        KEIKO_DEV_MAX_RESTARTS: "0",
        KEIKO_DEV_NEXT_BUNDLER: "webpack",
        KEIKO_STATE_DIR: stateDir,
        KEIKO_UI_DATA_DIR: join(stateDir, "ui"),
        KEIKO_MEMORY_DIR: join(stateDir, "memory"),
        KEIKO_CONFIG_FILE: runtimeConfigPath,
      },
    },
  ],
});
