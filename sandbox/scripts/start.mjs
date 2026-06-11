import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { refreshSandbox, sandboxRoot } from "./refresh.mjs";

const stateDir = join(sandboxRoot, ".keiko");
const pidFile = join(stateDir, "ui.pid.json");
const host = "127.0.0.1";
const defaultPort = 1983;

function readExistingPid() {
  try {
    const parsed = JSON.parse(readFileSync(pidFile, "utf8"));
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readFlagValue(args, index) {
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function parsePort(raw) {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

function explicitCliPort(args) {
  const index = args.indexOf("--port");
  if (index === -1) return undefined;
  return readFlagValue(args, index);
}

function withoutPortFlag(args) {
  const next = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--port") {
      i += 1;
      continue;
    }
    next.push(args[i]);
  }
  return next;
}

function isPortAvailable(port) {
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
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No free loopback port found at or above ${String(start)}.`);
}

async function resolveLaunchArgs(rawArgs) {
  const cliPortRaw = explicitCliPort(rawArgs);
  const envPortRaw = process.env.KEIKO_UI_PORT;
  const explicitPortRaw = cliPortRaw ?? envPortRaw;
  const explicitPort = explicitPortRaw === undefined ? undefined : parsePort(explicitPortRaw);
  if (explicitPortRaw !== undefined && explicitPort === null) {
    throw new Error(`[sandbox] Invalid port: ${explicitPortRaw}`);
  }

  const requestedPort = explicitPort ?? defaultPort;
  if (await isPortAvailable(requestedPort)) {
    return [...withoutPortFlag(rawArgs), "--port", String(requestedPort)];
  }
  if (explicitPort !== undefined) {
    throw new Error(
      `[sandbox] Port ${host}:${String(requestedPort)} is already in use. Stop the existing process or pass another port with \`npm start -- --port <port>\`.`,
    );
  }

  const fallbackPort = await findAvailablePort(defaultPort + 1);
  console.log(
    `[sandbox] default port ${host}:${String(defaultPort)} is busy; using ${host}:${String(
      fallbackPort,
    )}`,
  );
  return [...withoutPortFlag(rawArgs), "--port", String(fallbackPort)];
}

mkdirSync(stateDir, { recursive: true });
const existingPid = readExistingPid();
if (existingPid !== null && isProcessRunning(existingPid)) {
  console.error(`[sandbox] Keiko UI already appears to be running as PID ${String(existingPid)}.`);
  console.error("[sandbox] Run `npm run stop` from the sandbox before starting it again.");
  process.exit(1);
}
rmSync(pidFile, { force: true });

let launchArgs;
try {
  launchArgs = await resolveLaunchArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

try {
  refreshSandbox();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const cliEntry = join(
  sandboxRoot,
  "node_modules",
  "@oscharko-dev",
  "keiko",
  "dist",
  "cli",
  "index.js",
);

if (!existsSync(cliEntry)) {
  console.error(`[sandbox] Missing built Keiko CLI at ${cliEntry}`);
  process.exit(1);
}

const child = spawn(process.execPath, [cliEntry, "ui", ...launchArgs], {
  cwd: sandboxRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    KEIKO_STATE_DIR: process.env.KEIKO_STATE_DIR ?? join(sandboxRoot, ".keiko"),
  },
});

if (child.pid === undefined) {
  console.error("[sandbox] Failed to start Keiko UI.");
  process.exit(1);
}

writeFileSync(
  pidFile,
  `${JSON.stringify(
    {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      command: [process.execPath, cliEntry, "ui", ...launchArgs],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

function cleanupPidFile() {
  const currentPid = readExistingPid();
  if (currentPid === child.pid) {
    rmSync(pidFile, { force: true });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  cleanupPidFile();
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  cleanupPidFile();
  console.error(error.message);
  process.exit(1);
});
