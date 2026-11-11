import { join } from "node:path";

export interface DevServerEnvOptions {
  readonly publicPort: number;
  readonly bffPort: number;
  readonly nextPort: number;
  readonly stateDir: string;
  readonly runtimeConfigPath: string;
}

/** The environment every Playwright suite gives the dev runner it starts on a prebuilt graph. */
export function devServerEnv(options: DevServerEnvOptions): Record<string, string> {
  return {
    KEIKO_OS_KEYCHAIN: "off",
    NODE_ENV: "test",
    KEIKO_DEV_UI_PORT: String(options.publicPort),
    KEIKO_DEV_BFF_PORT: String(options.bffPort),
    KEIKO_DEV_NEXT_PORT: String(options.nextPort),
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
    KEIKO_STATE_DIR: options.stateDir,
    KEIKO_UI_DATA_DIR: join(options.stateDir, "ui"),
    KEIKO_MEMORY_DIR: join(options.stateDir, "memory"),
    // #4213: a journey learns right after its turn instead of after the product's pause.
    KEIKO_MEMORY_LEARNING_IDLE_MS: "0",
    KEIKO_CONFIG_FILE: options.runtimeConfigPath,
  };
}
