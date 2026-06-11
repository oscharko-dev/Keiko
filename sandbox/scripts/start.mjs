import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshSandbox, sandboxRoot } from "./refresh.mjs";

const stateDir = join(sandboxRoot, ".keiko");
const pidFile = join(stateDir, "ui.pid.json");

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

mkdirSync(stateDir, { recursive: true });
const existingPid = readExistingPid();
if (existingPid !== null && isProcessRunning(existingPid)) {
  console.error(`[sandbox] Keiko UI already appears to be running as PID ${String(existingPid)}.`);
  console.error("[sandbox] Run `npm run stop` from the sandbox before starting it again.");
  process.exit(1);
}
rmSync(pidFile, { force: true });

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

const child = spawn(process.execPath, [cliEntry, "ui", ...process.argv.slice(2)], {
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
      command: [process.execPath, cliEntry, "ui", ...process.argv.slice(2)],
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
