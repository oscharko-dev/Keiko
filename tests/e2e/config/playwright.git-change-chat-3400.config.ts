import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { e2eStateDir } from "../support/e2e-state-dir.js";

// Issue #3400 (epic #3384) — browser evidence for "Connect a Git change to Chat": the Git
// window's toolbar exposes a "Connect to Chat" action, the resulting dialog resolves the active
// repository's chats and current branch, and a successful connect surfaces the git-change scope
// pill (comparison label, current/stale status, refresh/disconnect) in the target Chat's header.
// Mirrors playwright.issue-1575-git-changes.config.ts: build the packaged CLI, boot the real UI
// server, run a single deterministic chromium worker against a real git fixture and a real chat.

const root = process.cwd();
const publicPort = Number(process.env.KEIKO_E2E_UI_PORT ?? "32211");
const modelPort = publicPort - 1;
const stateId =
  process.env.KEIKO_E2E_GIT_CHANGE_CHAT_STATE_ID ??
  (process.env.KEIKO_E2E_GIT_CHANGE_CHAT_STATE_ID = `git-change-chat-3400-${randomUUID()}`);
const stateDir = e2eStateDir(stateId);
process.env.KEIKO_QUALIFICATION_ACTIVITY_LOG_PATH = join(stateDir, "logs", "server.log");
const providerBin = join(stateDir, "provider-bin");
const providerStatePath = join(stateDir, "git-change-chat-provider.json");
const providerScript = join(root, "tests", "e2e", "support", "git-change-chat-3400-gh.mjs");
const providerModuleUrl = pathToFileURL(providerScript).href;
const modelMockScript = join(root, "tests", "e2e", "support", "model-mock-server.mjs");
const serverEntry = join(
  root,
  "tests/e2e/servers/dist/tests/e2e/servers/git-change-chat-3400-server.mjs",
);
process.env.KEIKO_GIT_CHANGE_CHAT_PROVIDER_STATE = providerStatePath;
const prepareRuntimeConfig = [
  "const fs = require('node:fs');",
  `fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });`,
  `fs.mkdirSync(${JSON.stringify(providerBin)}, { recursive: true });`,
  `try { fs.unlinkSync(${JSON.stringify(providerStatePath)}); } catch (error) { if (error?.code !== "ENOENT") throw error; }`,
  `fs.writeFileSync(${JSON.stringify(join(providerBin, "gh"))}, ${JSON.stringify(`#!${process.execPath}\nprocess.env.KEIKO_GIT_CHANGE_CHAT_PROVIDER_STATE = ${JSON.stringify(providerStatePath)};\nimport(${JSON.stringify(providerModuleUrl)});\n`)});`,
  `fs.chmodSync(${JSON.stringify(join(providerBin, "gh"))}, 0o755);`,
].join(" ");

export default defineConfig({
  testDir: join(root, "tests", "e2e"),
  testMatch: "git-change-chat-3400.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 20_000,
  },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(publicPort)}`,
    // The shared browser axe runner injects the checked-in axe-core bundle after navigation.
    // Bypass CSP inside this isolated Playwright context only; the production response retains
    // and exercises its actual CSP in every ordinary browser context.
    bypassCSP: true,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "chromium",
      // Wide enough for the Git window and the Chat window to sit side by side, matching the
      // seeded window layout (git-change-chat-3400.ts).
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 900 } },
    },
  ],
  webServer: [
    {
      cwd: root,
      command: `node ${JSON.stringify(modelMockScript)}`,
      url: `http://127.0.0.1:${String(modelPort)}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { KEIKO_E2E_MODEL_PORT: String(modelPort) },
    },
    {
      cwd: root,
      command:
        `node -e ${JSON.stringify(prepareRuntimeConfig)} && ` +
        "npm run build:packages && npm run build:ui && " +
        "node node_modules/@typescript/native/bin/tsc -p tests/e2e/servers/tsconfig.json && " +
        `node ${serverEntry}`,
      url: `http://127.0.0.1:${String(publicPort)}`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        PATH: `${providerBin}${delimiter}${process.env.PATH ?? ""}`,
        KEIKO_GIT_CHANGE_CHAT_PROVIDER_STATE: providerStatePath,
        KEIKO_STATE_DIR: stateDir,
        KEIKO_E2E_UI_PORT: String(publicPort),
        KEIKO_E2E_MODEL_PORT: String(modelPort),
      },
    },
  ],
});
