import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = join(REPO_ROOT, "scripts", "dev-runner.mjs");
const DEFAULT_DEV_PID_FILE = join(REPO_ROOT, ".keiko", "dev", "dev-ui.pid.json");
const UI_TSCONFIG = join(REPO_ROOT, "packages", "keiko-ui", "tsconfig.json");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise();
    });
  });
  const address = server.address();
  await new Promise<void>((resolvePromise) => {
    server.close(() => {
      resolvePromise();
    });
  });
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind to an IPv4 port");
  }
  return address.port;
}

async function statusOf(port: number, path = "/"): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      cache: "no-store",
    });
    return response.status;
  } catch {
    return 0;
  }
}

function killProcessTree(child: ChildProcess | undefined): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}

function processIsRunning(pid: unknown): boolean {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultDevUiIsRunning(): boolean {
  if (!existsSync(DEFAULT_DEV_PID_FILE)) return false;
  try {
    const parsed = JSON.parse(readFileSync(DEFAULT_DEV_PID_FILE, "utf8")) as {
      readonly runnerPid?: unknown;
    };
    return processIsRunning(parsed.runnerPid);
  } catch {
    return false;
  }
}

describe("scripts/dev-runner.mjs readiness gate", () => {
  let stateDir: string | undefined;
  let child: ChildProcess | undefined;
  let uiTsconfigBefore: string | undefined;

  afterEach(async () => {
    killProcessTree(child);
    await sleep(500);
    if (stateDir !== undefined) {
      rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
    if (uiTsconfigBefore !== undefined) {
      writeFileSync(UI_TSCONFIG, uiTsconfigBefore, "utf8");
      uiTsconfigBefore = undefined;
    }
    child = undefined;
  });

  it("does not proxy transient Next warmup 500s through the public port", async () => {
    if (defaultDevUiIsRunning()) {
      return;
    }

    uiTsconfigBefore = readFileSync(UI_TSCONFIG, "utf8");
    stateDir = mkdtempSync(join(tmpdir(), "keiko-dev-runner-"));
    const publicPort = await freePort();
    const bffPort = await freePort();
    const nextPort = await freePort();
    const output: string[] = [];

    const spawned = spawn(process.execPath, [RUNNER], {
      cwd: REPO_ROOT,
      detached: true,
      env: {
        ...process.env,
        KEIKO_DEV_UI_PORT: String(publicPort),
        KEIKO_DEV_BFF_PORT: String(bffPort),
        KEIKO_DEV_NEXT_PORT: String(nextPort),
        KEIKO_DEV_PID_FILE: join(stateDir, "dev-ui.pid.json"),
        KEIKO_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;
    spawned.stdout.on("data", (chunk) => output.push(String(chunk)));
    spawned.stderr.on("data", (chunk) => output.push(String(chunk)));

    const statuses: number[] = [];
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const status = await statusOf(publicPort);
      statuses.push(status);
      if (status === 500) {
        throw new Error(`public root returned 500 during warmup\n${output.join("")}`);
      }
      if (status === 200) break;
      await sleep(250);
    }

    expect(statuses).toContain(200);
    expect(statuses).not.toContain(500);
    expect(await statusOf(publicPort, "/api/health")).toBe(200);
  }, 45_000);
});
