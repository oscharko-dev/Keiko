import { defineConfig } from "@playwright/test";

import { FILE_HISTORY_APP_SESSION_LAUNCHER_SECRET } from "../support/file-history-2531.js";
import baseConfig from "./playwright.config.js";

const baseWebServer = baseConfig.webServer;
if (!Array.isArray(baseWebServer)) throw new Error("Issue #2533 requires the shared web servers.");

const webServer = baseWebServer.map((server, index) =>
  index === baseWebServer.length - 1
    ? {
        ...server,
        env: {
          ...server.env,
          KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET: FILE_HISTORY_APP_SESSION_LAUNCHER_SECRET,
        },
      }
    : server,
);

export default defineConfig({
  ...baseConfig,
  testMatch: ["editor-m11-closeout-2533.spec.ts"],
  timeout: 180_000,
  webServer,
});
