import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { copyPackageFixtureSources } from "../../scripts/__tests__/support/private-repository-fixture.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_READY_TIMEOUT_MS = 180_000;
const PUBLIC_READY_POLL_MS = 250;
const DEV_RUNNER_TEST_TIMEOUT_MS = 240_000;

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

async function listenOnPort(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  return server;
}

async function waitFor<T>(
  action: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await action();
  while (!predicate(value) && Date.now() < deadline) {
    await sleep(PUBLIC_READY_POLL_MS);
    value = await action();
  }
  if (!predicate(value)) throw new Error(errorMessage);
  return value;
}

/**
 * The runner rewrites this file in place, so a read can land mid-write and see a truncated
 * document. That is transient and indistinguishable from "not updated yet", so it has to keep the
 * caller's poll going instead of throwing a bare `SyntaxError` out of it — a partial read failed
 * the coverage shard while the runner under test was behaving correctly. Nothing is swallowed: a
 * file that never becomes parseable still fails, through the caller's own deadline and message.
 */
function readRunnerState(stateFile: string): {
  readonly children?: readonly unknown[];
  readonly nextPort?: unknown;
} {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as {
      readonly children?: readonly unknown[];
      readonly nextPort?: unknown;
    };
  } catch {
    return {};
  }
}

function childProcessIds(pid: number): readonly number[] {
  try {
    const output = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    return output
      .split("\n")
      .filter((value) => value.length > 0)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value));
  } catch {
    return [];
  }
}

function terminateProcessTree(pid: number): void {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    return;
  }
  for (const childPid of childProcessIds(pid)) {
    terminateProcessTree(childPid);
  }
  process.kill(pid, "SIGKILL");
}

function suspendProcess(pid: number): void {
  if (process.platform !== "win32") process.kill(pid, "SIGSTOP");
}

function resumeProcess(pid: number): void {
  if (process.platform !== "win32") process.kill(pid, "SIGCONT");
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

let fixtureRoot: string | undefined;
let fixturePrepared: Promise<string> | undefined;

async function prepareRunnerFixture(): Promise<string> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-dev-runner-source-"));
  fixtureRoot = root;
  await copyPackageFixtureSources(REPO_ROOT, root);
  return root;
}

function runnerFixture(): Promise<string> {
  fixturePrepared ??= prepareRunnerFixture();
  return fixturePrepared;
}

afterAll(() => {
  if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("scripts/dev-runner.mjs readiness gate", () => {
  let stateDir: string | undefined;
  let child: ChildProcess | undefined;
  let childPortCollision: Server | undefined;
  let childClosed: Promise<void> | undefined;

  function retainRunner(spawned: ChildProcess): void {
    child = spawned;
    childClosed = new Promise<void>((resolveClose) => spawned.once("close", resolveClose));
  }

  afterEach(async () => {
    killProcessTree(child);
    await childClosed;
    if (childPortCollision !== undefined) {
      const collision = childPortCollision;
      await new Promise<void>((resolvePromise) => {
        collision.close(() => {
          resolvePromise();
        });
      });
      childPortCollision = undefined;
    }
    if (stateDir !== undefined) {
      rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
    child = undefined;
    childClosed = undefined;
  });

  it(
    "does not proxy transient Next warmup 500s through the public port",
    async () => {
      const repositoryRoot = await runnerFixture();
      const runner = join(repositoryRoot, "scripts", "dev-runner.mjs");
      stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-dev-runner-"));
      const publicPort = await freePort();
      const bffPort = await freePort();
      const nextPort = await freePort();
      const output: string[] = [];

      const spawned = spawn(process.execPath, [runner], {
        cwd: repositoryRoot,
        detached: true,
        env: {
          ...process.env,
          KEIKO_DEV_UI_PORT: String(publicPort),
          KEIKO_DEV_BFF_PORT: String(bffPort),
          KEIKO_DEV_NEXT_PORT: String(nextPort),
          KEIKO_DEV_PID_FILE: join(stateDir, "dev-ui.pid.json"),
          KEIKO_DEV_TEST_SKIP_PACKAGE_WATCH: "1",
          KEIKO_STATE_DIR: stateDir,
          NODE_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      retainRunner(spawned);
      spawned.stdout.on("data", (chunk) => output.push(String(chunk)));
      spawned.stderr.on("data", (chunk) => output.push(String(chunk)));

      const statuses: number[] = [];
      const deadline = Date.now() + PUBLIC_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const status = await statusOf(publicPort);
        statuses.push(status);
        if (status === 500) {
          throw new Error(`public root returned 500 during warmup\n${output.join("")}`);
        }
        if (status === 200) break;
        await sleep(PUBLIC_READY_POLL_MS);
      }

      expect(statuses).toContain(200);
      expect(statuses).not.toContain(500);
      let healthStatus = await statusOf(publicPort, "/api/health");
      while (healthStatus !== 200 && Date.now() < deadline) {
        await sleep(PUBLIC_READY_POLL_MS);
        healthStatus = await statusOf(publicPort, "/api/health");
      }
      expect(healthStatus).toBe(200);
    },
    DEV_RUNNER_TEST_TIMEOUT_MS,
  );

  it(
    "recovers the public proxy after a Next.js respawn selects a new child port",
    async () => {
      const repositoryRoot = await runnerFixture();
      const runner = join(repositoryRoot, "scripts", "dev-runner.mjs");
      stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-dev-runner-"));
      const stateFile = join(stateDir, "dev-ui.pid.json");
      const publicPort = await freePort();
      const bffPort = await freePort();
      const nextPort = await freePort();

      const spawned = spawn(process.execPath, [runner], {
        cwd: repositoryRoot,
        detached: true,
        env: {
          ...process.env,
          KEIKO_DEV_UI_PORT: String(publicPort),
          KEIKO_DEV_BFF_PORT: String(bffPort),
          KEIKO_DEV_NEXT_PORT: String(nextPort),
          KEIKO_DEV_PID_FILE: stateFile,
          // SIGSTOP/SIGCONT freezes the POSIX runner while the old port is occupied. Windows
          // cannot suspend the process this way, so retain a long deterministic delay there.
          KEIKO_DEV_RESTART_DELAY_MS: "5000",
          KEIKO_DEV_TEST_SKIP_PACKAGE_WATCH: "1",
          KEIKO_STATE_DIR: stateDir,
          NODE_ENV: "test",
        },
        stdio: "ignore",
      });
      retainRunner(spawned);

      await waitFor(
        async () => statusOf(publicPort),
        (status) => status === 200,
        PUBLIC_READY_TIMEOUT_MS,
        "public proxy did not become ready",
      );
      const initialState = await waitFor(
        () => readRunnerState(stateFile),
        (state) => Number.isInteger(state.children?.at(-1)),
        PUBLIC_READY_TIMEOUT_MS,
        "dev runner state never reported a Next.js child",
      );
      const nextPid = initialState.children?.at(-1);
      expect(Number.isInteger(nextPid)).toBe(true);
      const runnerPid = spawned.pid;
      if (runnerPid === undefined) throw new Error("dev runner PID is unavailable");
      suspendProcess(runnerPid);
      try {
        terminateProcessTree(nextPid as number);
        childPortCollision = await waitFor(
          async () => {
            try {
              return await listenOnPort(nextPort);
            } catch {
              return undefined;
            }
          },
          (server) => server !== undefined,
          10_000,
          "could not occupy the terminated Next.js child port",
        );
      } finally {
        resumeProcess(runnerPid);
      }

      const recoveredState = await waitFor(
        () => readRunnerState(stateFile),
        (state) => typeof state.nextPort === "number" && state.nextPort !== nextPort,
        PUBLIC_READY_TIMEOUT_MS,
        "Next.js did not select a replacement child port",
      );
      expect(recoveredState.nextPort).not.toBe(nextPort);
      await waitFor(
        async () => statusOf(publicPort),
        (status) => status === 200,
        PUBLIC_READY_TIMEOUT_MS,
        "public proxy did not recover after the Next.js child port changed",
      );
    },
    DEV_RUNNER_TEST_TIMEOUT_MS,
  );
});
