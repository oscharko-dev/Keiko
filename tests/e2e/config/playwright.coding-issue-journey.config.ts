import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { e2eStateDir } from "../support/e2e-state-dir.js";

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
// Live-run bug: `runUiCli`'s `--ui-db` argument goes through the SAME workspace-containment guard
// production enforces (`packages/keiko-server/src/store/paths.ts`'s `resolveUiDbPath` ->
// `resolveConfiguredPath`), which checks the REAL Node process's `process.cwd()` -- not the
// `cwd` option `coding-issue-journey-server.mts` hands `runUiCli` for the connected project, and
// not overridable by it, since that option is a value threaded through the CLI, never an actual
// `process.chdir()`. Because Playwright's `webServer.cwd` is this repository's root, ANY
// `--ui-db` path under `<root>/.keiko-e2e-state/...` fails closed as "must not be inside the
// current workspace" (the ONLY exemption the guard grants is the literal `<cwd>/.keiko`
// directory). Every scripted sibling harness in `tests/e2e/servers/` builds `UiHandlerDeps`
// directly and never goes through this CLI-level guard, so this is the only lane that hits it.
// Nesting the state dir under `.keiko` (already the default runtime-state directory name and
// already `.gitignore`d) satisfies the SAME exemption `resolveConfiguredPath` grants its own
// default `.keiko` runtime state root, without weakening or bypassing the guard itself.
const stateDir = e2eStateDir("coding-issue-journey-e2e", root, ".keiko");

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

// Runbook gap 6: a bare `npm run test:e2e:coding-issue-journey:live` otherwise launches the server
// clamped to the `governed-assist` default ceiling (`deps.ts`'s `resolveDeploymentCeiling`), so
// the spec's own "Full access" mode selection would fail against that ceiling rather than
// degrading visibly. ADR-0138 D2 makes the effective mode independently selectable at or below the
// ceiling through the Settings -> Security radios, so setting the ceiling to the highest value
// here still lets the spec drive every ADR-0138 mode from ONE server process.
const deploymentCeiling = process.env.KEIKO_CODING_DEPLOYMENT_CEILING ?? "autonomous-delivery";

// The receipts directory every scenario `test()` writes its `<scenarioId>.receipt.json` +
// `.artifact` pair into (`recordScenarioReceipt`, `support/coding-issue-journey-scenarios.ts`).
// Resolved once here (operator override honoured, defaulted otherwise) and written back into
// `process.env` BEFORE `defineConfig` returns, mirroring the launcher-secret pattern above, so the
// spec's own worker process reads the SAME value. Defaults to the exact path this evidence is
// committed under (Part 3.4 of the qualification runbook) so an operator invocation with no
// override still lands the receipts where `check:coding-issue-journey-evidence:3390` reads them.
const receiptsDir =
  process.env.KEIKO_QUALIFICATION_RECEIPTS_DIR ??
  resolve(root, "docs", "qa", "evidence", "coding-issue-journey", "3390", "receipts");
process.env.KEIKO_QUALIFICATION_RECEIPTS_DIR = receiptsDir;
// The live worker checks body-free production activity evidence for a useful repository-search
// result on the exact run. Pass the production log location explicitly instead of restating the
// state-directory formula in the worker.
process.env.KEIKO_QUALIFICATION_ACTIVITY_LOG_PATH = join(stateDir, "state", "logs", "server.log");
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
  // Each scenario test waits on a real model's own tool-call sequence (implement, verify, commit,
  // push, draft PR, and for the CI-repair/mark-ready scenarios also CI observation and repair) --
  // generously bounded per internal wait (up to 25 minutes, see
  // `support/coding-issue-journey-live.ts`), so the outer Playwright test timeout must exceed the
  // longest of those, not the sibling scripted specs' much shorter fixture-driven timeout.
  timeout: 30 * 60_000,
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
      // Live-run bug: a real GitHub issue body has unpredictable, often much longer, content than
      // `coding-issue-intake.spec.ts`'s small scripted fixture -- the Coding Workbench window's
      // stored layout is a fixed 1120x1400 (see `coding-issue-journey.spec.ts`'s
      // `keiko.workspace.v4` init script), so a long real issue body pushes "Use this issue" past
      // the bottom of a 1100px viewport with no further internal scroll room, and Playwright
      // refuses to click a target outside the viewport no matter how long it retries. That same
      // spec (`captureModes`) already established the fix for exactly this class of content in
      // this codebase: grow the viewport tall enough to contain the whole window, never guess a
      // content-dependent height.
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 2200 } },
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
      KEIKO_CODING_DEPLOYMENT_CEILING: deploymentCeiling,
      KEIKO_QUALIFICATION_RECEIPTS_DIR: receiptsDir,
    },
  },
});
