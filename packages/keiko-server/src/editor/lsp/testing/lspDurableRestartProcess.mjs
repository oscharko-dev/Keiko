import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { PassThrough } from "node:stream";

import { createLspProcessManager } from "../../../../dist/editor/lsp/lspProcessManager.js";
import { createLspRuntimeStatePort } from "../../../../dist/editor/lsp/lspRuntimeStateStore.js";

const [mode, stateDir, workspaceRoot, childPidPath, resultPath, spawnMarkerPath] =
  process.argv.slice(2);
if (
  mode === undefined ||
  stateDir === undefined ||
  workspaceRoot === undefined ||
  childPidPath === undefined ||
  resultPath === undefined ||
  spawnMarkerPath === undefined
) {
  process.exit(2);
}

const executableName = basename(process.execPath);
const runtimeState = createLspRuntimeStatePort({
  stateDir,
  workspaceRoot,
  managerId: "durable-restart-integration",
  configurationRevision: 1,
});

function config() {
  return {
    managerId: "durable-restart-integration",
    executableName,
    executableArgs: [],
    envAllowlist: [],
    initializeTimeoutMs: 60_000,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    restartWindowMs: 60_000,
    maxRestartsInWindow: 2,
    maxFrameBytes: 1_048_576,
  };
}

function workspace() {
  return {
    root: workspaceRoot,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

function survivingSpawn() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("fixture child pid unavailable");
  child.unref();
  writeFileSync(childPidPath, String(child.pid), "utf8");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdin: { write: () => undefined },
    stdout,
    stderr,
    pid: child.pid,
    kill: (signal) => child.kill(signal),
    onExit: () => undefined,
    onError: () => undefined,
  };
}

function forbiddenReplacementSpawn() {
  writeFileSync(spawnMarkerPath, "spawned", "utf8");
  throw new Error("replacement spawn must remain blocked");
}

const manager = createLspProcessManager({
  config: config(),
  workspace: workspace(),
  processEnv: { PATH: dirname(process.execPath) },
  commandRules: [{ executable: executableName }],
  runtimeState,
  spawn: mode === "owner" ? survivingSpawn : forbiddenReplacementSpawn,
});

if (mode === "owner") {
  if (manager.getLspProcessStatus() !== "INITIALIZING") process.exit(3);
} else if (mode === "replacement") {
  writeFileSync(
    resultPath,
    JSON.stringify({
      status: manager.getLspProcessStatus(),
      retained: manager.hasRetainedProcessOwnership(),
    }),
    "utf8",
  );
} else {
  process.exit(4);
}

process.exit(0);
