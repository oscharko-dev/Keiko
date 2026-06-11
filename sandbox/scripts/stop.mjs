import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { sandboxRoot } from "./refresh.mjs";

const pidFile = join(sandboxRoot, ".keiko", "ui.pid.json");
const force = process.argv.includes("--force");

function readPid() {
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

const pid = readPid();
if (pid === null) {
  console.log("[sandbox] No Keiko UI PID file found.");
  process.exit(0);
}

if (!isProcessRunning(pid)) {
  rmSync(pidFile, { force: true });
  console.log(`[sandbox] Removed stale PID file for PID ${String(pid)}.`);
  process.exit(0);
}

console.log(`[sandbox] Stopping Keiko UI PID ${String(pid)}...`);
process.kill(pid, "SIGTERM");

for (let i = 0; i < 50; i += 1) {
  await sleep(100);
  if (!isProcessRunning(pid)) {
    rmSync(pidFile, { force: true });
    console.log("[sandbox] Keiko UI stopped.");
    process.exit(0);
  }
}

if (force) {
  process.kill(pid, "SIGKILL");
  rmSync(pidFile, { force: true });
  console.log("[sandbox] Keiko UI force-stopped.");
  process.exit(0);
}

console.error("[sandbox] Keiko UI did not stop within 5s. Retry with `npm run stop -- --force`.");
process.exit(1);
