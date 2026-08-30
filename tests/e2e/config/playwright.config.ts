import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { e2eStateDir } from "../support/e2e-state-dir.js";

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32183");
const bffPort = Number(process.env.KEIKO_E2E_BFF_PORT ?? "32184");
const nextPort = Number(process.env.KEIKO_E2E_NEXT_PORT ?? "32185");
// GEN-TEST-RELEASE-GATE-002: deterministic loopback model provider port for the chat send smoke.
const modelPort = Number(process.env.KEIKO_E2E_MODEL_PORT ?? "32186");
const modelMockScript = join(root, "tests", "e2e", "support", "model-mock-server.mjs");
const modelBaseUrl = `http://127.0.0.1:${String(modelPort)}/v1`;
// The state directory must be UNIQUE PER BROWSER RUN, not per workflow run. `GITHUB_RUN_ID` is
// identical for every step of a job, so the chromium and firefox smoke lanes — two separate
// `playwright test` invocations — resolved the SAME directory and the second inherited the first's
// memory database, UI data and workspace state. A journey that asserts an empty starting state
// ("disabled capture stays empty") then reads the previous engine's leftovers and fails for a
// reason that has nothing to do with the engine under test.
//
// Derived from `--project=` on the command line rather than a new env var each script must remember
// to set: the flag is already how the lanes differ, so isolation cannot be forgotten. Falls back to
// the plain id when no project is pinned (a local full run), which is a single invocation and so
// needs no split.
const projectArgument = process.argv
  .find((argument) => argument.startsWith("--project="))
  ?.slice("--project=".length);
const stateId = `${process.env.GITHUB_RUN_ID ?? String(process.pid)}${
  projectArgument === undefined || projectArgument.length === 0 ? "" : `-${projectArgument}`
}`;
const stateDir = e2eStateDir(stateId);
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
  // Playwright's default testMatch also collects *.test.ts, which are vitest suites here
  // (e.g. the *.static.test.ts source-shape tests) and crash at collection time.
  testMatch: "**/*.spec.ts",
  // Issue #2474 — the Code-task journeys (#2385/#2386) boot dedicated TEST-ONLY server entries
  // through their owned configs (playwright.code-task-*.config.ts); collected here they would run
  // against this dev-runner server and fail. Run them via the test:e2e:code-task:* scripts.
  testIgnore: "code-task-*.spec.ts",
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
    // Firefox is a DECLARED support target (keiko-ui's browserslist) and, on the Windows fleets this
    // product is deployed to, the one real second engine next to Edge/Chrome — which are both
    // Chromium and therefore already covered by the project above. Until now nothing exercised Gecko
    // at all: 45 Playwright configs, none with Firefox, and CI installed only the Chromium binary. A
    // support claim no test can fail is a claim, not a guarantee. The first run of this project
    // found four real cross-engine defects in the specs (see support/window-chrome.ts).
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
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
        // Node's internal watch restarts do not emit an exit from the outer watcher process, so the
        // proxy can retain a stale ready=true state while the BFF port is briefly unavailable.
        // E2E runs against a prebuilt graph and must keep one stable BFF process for the whole suite.
        KEIKO_DEV_TEST_SKIP_BFF_WATCH: "1",
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
