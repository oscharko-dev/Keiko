import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { e2eStateDir } from "../support/e2e-state-dir.js";

const root = process.cwd();
// The UI listens on `port`, the Jira and model fixtures on the two ports above it. Like every other
// E2E default, all three stay below 32768: Linux hands out outbound ports from 32768 upwards, so a
// fixed port there can already be held by an unrelated connection (EADDRINUSE on 33582, PR #4150).
const port = Number(process.env.KEIKO_E2E_UI_PORT ?? "32381");
const directory = process.env.KEIKO_E2E_JIRA_STATE ?? e2eStateDir(`jira-chat-4081-${randomUUID()}`);
process.env.KEIKO_E2E_JIRA_STATE = directory;
process.env.KEIKO_QUALIFICATION_ACTIVITY_LOG_DIR = join(directory, "logs");

export default defineConfig({
  testDir: join(root, "tests/e2e"),
  testMatch: "jira-chat-4081.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${String(port)}`,
    trace: "off",
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
      "npm run build:packages && npm run build:ui && node tests/e2e/support/jira-chat-4081-server.mjs",
    url: `http://127.0.0.1:${String(port)}`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { KEIKO_E2E_JIRA_STATE: directory, KEIKO_E2E_UI_PORT: String(port) },
  },
});
