import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = resolve(process.env.KEIKO_STATE_DIR ?? join(repoRoot, ".keiko", "dev"));
const pidFile = join(stateDir, "dev-ui.pid.json");
const logFile = join(stateDir, "dev-ui.log");
const host = "127.0.0.1";
const explicitPublicPort = process.env.KEIKO_DEV_UI_PORT ?? process.env.KEIKO_UI_PORT;
let publicPort = Number(explicitPublicPort ?? "1983");
const runnerScript = join(repoRoot, "scripts", "dev-runner.mjs");

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, cwd) {
  console.log(`[dev:start] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (result.status !== 0) {
    const code = result.status === null ? result.signal : result.status;
    throw new Error(`${command} ${args.join(" ")} failed (${String(code)})`);
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function dependenciesNeedInstall() {
  const nodeModules = join(repoRoot, "node_modules");
  const lock = join(repoRoot, "package-lock.json");
  const installedLock = join(nodeModules, ".package-lock.json");
  if (!existsSync(nodeModules) || !existsSync(installedLock)) return true;
  const installed = statSync(installedLock).mtimeMs;
  return (
    statSync(join(repoRoot, "package.json")).mtimeMs > installed ||
    statSync(lock).mtimeMs > installed
  );
}

function ensureDependencies() {
  if (!dependenciesNeedInstall()) {
    console.log("[dev:start] dependencies already installed");
    return;
  }
  run(npmCommand(), ["ci", "--no-audit", "--no-fund"], repoRoot);
}

function checkPortAvailable(port) {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => resolveAvailable(false));
    server.listen(port, host, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

async function findAvailablePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await checkPortAvailable(port)) return port;
  }
  throw new Error(`No free loopback port found at or above ${String(start)}`);
}

async function waitForHealth(port, child) {
  const url = `http://${host}:${String(port)}/api/health`;
  const deadline = Date.now() + 60_000;
  let lastError = "not started";
  while (Date.now() <= deadline) {
    if (child.exitCode !== null) {
      throw new Error(`development server exited early; see ${logFile}`);
    }
    try {
      const response = await globalThis.fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`development server did not become healthy: ${lastError}; see ${logFile}`);
}

if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
  console.error(`Invalid KEIKO_DEV_UI_PORT/KEIKO_UI_PORT: ${String(publicPort)}`);
  process.exit(2);
}

let spawnedChild;
const state = readState();
if (state !== undefined && isAlive(state.runnerPid)) {
  console.log(
    `Keiko dev UI already running on http://${host}:${String(state.publicPort ?? publicPort)} (pid ${String(
      state.runnerPid,
    )}).`,
  );
  process.exit(0);
}
rmSync(pidFile, { force: true });

try {
  ensureDependencies();
  run(npmCommand(), ["run", "build"], repoRoot);
  if (!(await checkPortAvailable(publicPort))) {
    if (explicitPublicPort !== undefined) {
      throw new Error(`Port ${host}:${String(publicPort)} is already in use.`);
    }
    const fallbackPort = await findAvailablePort(publicPort + 1);
    console.log(
      `[dev:start] default port ${host}:${String(publicPort)} is busy; using ${host}:${String(
        fallbackPort,
      )}`,
    );
    publicPort = fallbackPort;
  }
  const bffPort = await findAvailablePort(
    Number(process.env.KEIKO_DEV_BFF_PORT ?? String(publicPort + 1)),
  );
  const nextStart = Number(process.env.KEIKO_DEV_NEXT_PORT ?? String(publicPort + 2));
  const nextPort = await findAvailablePort(nextStart === bffPort ? bffPort + 1 : nextStart);

  mkdirSync(stateDir, { recursive: true });
  const logFd = openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, [runnerScript], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      KEIKO_DEV_UI_PORT: String(publicPort),
      KEIKO_DEV_BFF_PORT: String(bffPort),
      KEIKO_DEV_NEXT_PORT: String(nextPort),
      KEIKO_DEV_PID_FILE: pidFile,
      KEIKO_STATE_DIR: stateDir,
    },
  });
  spawnedChild = child;
  closeSync(logFd);
  child.unref();
  if (child.pid === undefined) throw new Error("failed to spawn development runner");
  await waitForHealth(publicPort, child);
  console.log(
    `Keiko dev UI running on http://${host}:${String(publicPort)} (pid ${String(child.pid)}).`,
  );
  console.log(`State: ${stateDir}`);
  console.log(`Logs: ${logFile}`);
  console.log(`Stop: npm run dev:stop`);
} catch (error) {
  if (spawnedChild?.pid !== undefined && isAlive(spawnedChild.pid)) {
    try {
      process.kill(spawnedChild.pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
