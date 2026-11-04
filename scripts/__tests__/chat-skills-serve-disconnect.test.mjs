// The BFF the chat-skills lab forks (serve.mjs) must not outlive its parent. The parent's IPC channel
// closes when the parent dies, however it died (a crash, a kill -9 the interrupt handlers never see),
// and a server that nobody can stop any more would hold its port and its state directory for good.
// This runs the real server on a private state directory and closes the channel from the parent's side.
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { URL, fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT, importBuilt } from "../testing/coding-workbench-lab/lab-common.mjs";

const SERVE = fileURLToPath(new URL("../testing/chat-skills-lab/serve.mjs", import.meta.url));
const START_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 20_000;
const MODEL = "serve-disconnect-model";

function gatewayConfig() {
  return {
    providers: [
      {
        modelId: MODEL,
        baseUrl: "http://127.0.0.1:9/v1",
        timeoutMs: 1000,
        maxRetries: 0,
        retryBaseDelayMs: 100,
        capability: {
          kind: "chat",
          contextWindow: 32768,
          maxOutputTokens: 2048,
          toolCalling: false,
          structuredOutput: false,
          streaming: true,
          supportsImageInput: false,
          supportsDocumentInput: false,
          workflowEligible: false,
          costClass: "low",
          latencyClass: "standard",
          throughputHint: "local",
          preferredUseCases: ["Chat"],
          knownLimitations: [],
        },
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 1 },
  };
}

async function serverEnvironment(dir) {
  const { CODING_APP_SESSION_LAUNCHER_SECRET_ENV } = await importBuilt(
    "keiko-contracts",
    "coding-app-session.js",
  );
  mkdirSync(join(dir, "project"), { recursive: true });
  const configPath = join(dir, "gateway.json");
  writeFileSync(configPath, JSON.stringify(gatewayConfig()), { mode: 0o600 });
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    KEIKO_STATE_DIR: join(dir, "state"),
    KEIKO_UI_DATA_DIR: join(dir, "ui"),
    KEIKO_MEMORY_DIR: join(dir, "memory"),
    KEIKO_EVIDENCE_DIR: join(dir, "evidence"),
    KEIKO_CONFIG_FILE: configPath,
    KEIKO_INITIAL_PROJECT_PATH: realpathSync(join(dir, "project")),
    KEIKO_MEMORY_KEY: randomBytes(32).toString("base64"),
    [`KEIKO_MODEL_${MODEL.toUpperCase().replaceAll("-", "_")}_API_KEY`]: "lab",
    [CODING_APP_SESSION_LAUNCHER_SECRET_ENV]: randomBytes(32).toString("hex"),
  };
}

function ready(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the server did not start")), START_TIMEOUT_MS);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("the server exited before it was ready"));
    });
  });
}

function exited(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => resolve("timeout"), EXIT_TIMEOUT_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("the chat-skills BFF", () => {
  let dir;
  let child;
  beforeEach(() => {
    if (!existsSync(join(REPO_ROOT, "packages", "keiko-server", "dist", "index.js")))
      throw new Error("the BFF needs built packages; run npm run build:packages");
    dir = mkdtempSync(join(tmpdir(), "chat-skills-serve-disconnect-"));
  });
  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await gone;
    }
    child = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "stops when its parent's IPC channel closes",
    async () => {
      child = fork(SERVE, [], {
        cwd: REPO_ROOT,
        env: await serverEnvironment(dir),
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const message = await ready(child);
      expect(message).toMatchObject({ kind: "ready" });
      expect(typeof message.port).toBe("number");
      // What a parent that died leaves behind: a closed channel and nobody to send "stop".
      child.disconnect();
      const outcome = await exited(child);
      expect(outcome, "the server stayed alive after its parent went away").toEqual({
        code: 0,
        signal: null,
      });
    },
    START_TIMEOUT_MS + EXIT_TIMEOUT_MS + 10_000,
  );
});
