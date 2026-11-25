// #4493 (ADR-0043 D20/D21): runs project commands inside the per-run AppContainer and Job Object of
// `keiko-runtime-supervisor.exe --relay-supervised`, for the account that starts this script, and
// records what each command did. It speaks the server's wire protocol (lib/windows-relay-frames.mjs),
// needs no service and no elevation, and changes no product behaviour. A plan file names the extra
// grants, the PATH inside the tree and the steps; docs/qa/opencode-windows-qualification.md records
// the plans run and their results.
//
//   node scripts/testing/probe-windows-project-commands.mjs --helper <supervisor.exe> --plan <plan.json> --out <report.json>
//
// Plan: { "grants": [{ "access": "read" | "modify", "path": "C:\\..." }], "path": ["C:\\..."],
//         "env": { "NAME": "value" }, "cwd": "C:\\...",
//         "steps": [{ "id": "...", "file": "C:\\...", "args": [], "cwd": "C:\\...", "timeoutMs": 60000 },
//                   { "id": "...", "kind": "read" | "write" | "list", "path": "C:\\..." },
//                   { "id": "...", "kind": "detached", "file": "C:\\...", "args": [] }] }
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, release, tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

import {
  GRANT_MODIFY,
  GRANT_READ,
  grantsFrame,
  launchFrame,
  openFrame,
  terminateFrame,
} from "./lib/windows-relay-frames.mjs";

const DEADLINE_MS = 30 * 60_000;
const OUTPUT_HEAD = 240;

// Runs inside the tree: every step in order, synchronously, then announces a port so the host knows
// the results file is complete. The supervisor keeps the tree alive until the host terminates it.
const RUNNER_SOURCE = String.raw`const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const head = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, ${OUTPUT_HEAD});
const fault = (error) => (error === undefined ? undefined : error.code ?? error.message);
// Output goes to files, never to pipes: inside an AppContainer, libuv's anonymous stdio pipes are
// named pipes it may not create, and it retries that refusal without end (#4493).
function command(step) {
  const started = Date.now();
  const paths = ["out", "err"].map((name) => require("node:path").join(process.env.TEMP, step.id + "." + name));
  const fds = [fs.openSync("\\\\.\\NUL", "r"), ...paths.map((path) => fs.openSync(path, "w"))];
  const run = spawnSync(step.file, step.args ?? [], {
    cwd: step.cwd ?? plan.cwd, stdio: fds, timeout: step.timeoutMs ?? 120000, windowsHide: true,
  });
  fds.forEach((fd) => fs.closeSync(fd));
  const [stdout, stderr] = paths.map((path) => fs.readFileSync(path, "utf8"));
  return { exit: run.status, signal: run.signal, error: fault(run.error), ms: Date.now() - started,
    stdout: head(stdout), stderr: head(stderr) };
}
function file(step) {
  try {
    if (step.kind === "read") return { ok: true, bytes: fs.readFileSync(step.path).length };
    if (step.kind === "list") return { ok: true, entries: fs.readdirSync(step.path).length };
    fs.writeFileSync(step.path, "probe " + step.id + "\n");
    return { ok: true };
  } catch (error) { return { ok: false, error: fault(error) }; }
}
function detached(step) {
  try {
    const child = spawn(step.file, step.args ?? [], { cwd: plan.cwd, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) { return { ok: false, error: fault(error) }; }
}
const run = (step) => (step.kind === undefined ? command(step) : step.kind === "detached" ? detached(step) : file(step));
const progress = process.argv[3] + ".progress";
const results = plan.steps.map((step) => {
  fs.appendFileSync(progress, step.id + "\n");
  return { id: step.id, ...run(step) };
});
fs.writeFileSync(process.argv[3], JSON.stringify(results));
const server = http.createServer((req, res) => res.end("done"));
server.listen(0, "127.0.0.1", () => console.log("opencode server listening on http://127.0.0.1:" + server.address().port));
`;

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined)
    throw new Error("usage: --helper <supervisor.exe> --plan <plan.json> --out <report.json>");
  return value;
}

// Plan values name the run's state as `${state}`, the account's profile as `${home}` and this run's
// marker as `${marker}`, so one plan runs unchanged for any account on any machine.
function substitute(value, state, marker) {
  const escaped = (path) => path.replaceAll("\\", "\\\\");
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll("${state}", escaped(state))
      .replaceAll("${home}", escaped(homedir()))
      .replaceAll("${marker}", marker),
  );
}

function treeEnvironment(plan, state) {
  const system = process.env.SystemRoot ?? String.raw`C:\Windows`;
  const path = [...(plan.path ?? []), join(system, "System32"), system].join(";");
  const fixed = {
    ComSpec: join(system, "System32", "cmd.exe"),
    HOME: join(state, "home"),
    PATH: path,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: join(state, "tmp"),
    TMP: join(state, "tmp"),
    USERPROFILE: join(state, "home"),
    npm_config_cache: join(state, "npm-cache"),
  };
  return Object.entries({ ...fixed, ...(plan.env ?? {}) }).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function stage(helper, root, rawPlan, gatewayPort) {
  const runtime = join(root, "runtime");
  const supervisorDirectory = join(root, "supervisor");
  const state = join(root, "state");
  for (const directory of [runtime, supervisorDirectory, state]) mkdirSync(directory);
  for (const directory of ["home", "tmp", "npm-cache"]) mkdirSync(join(state, directory));
  const handle = randomBytes(16).toString("hex");
  const plan = substitute(rawPlan, state, handle);
  const supervisor = join(supervisorDirectory, "keiko-runtime-supervisor.exe");
  copyFileSync(helper, supervisor);
  copyFileSync(process.execPath, join(runtime, "node.exe"));
  writeFileSync(join(runtime, "runner.js"), RUNNER_SOURCE);
  writeFileSync(join(runtime, "plan.json"), JSON.stringify(plan));
  const results = join(state, "results.json");
  const args = ["--preserve-symlinks-main", "--preserve-symlinks", join(runtime, "runner.js")];
  const grants = [
    { access: GRANT_READ, path: runtime },
    { access: GRANT_READ, path: supervisorDirectory },
    { access: GRANT_MODIFY, path: state },
    ...(plan.grants ?? []).map(({ access, path }) => ({
      access: access === "modify" ? GRANT_MODIFY : GRANT_READ,
      path,
    })),
  ];
  const launch = launchFrame(
    handle,
    join(runtime, "node.exe"),
    plan.cwd ?? state,
    [...args, join(runtime, "plan.json"), results],
    treeEnvironment(plan, state),
  );
  const frames = Buffer.concat([launch, grantsFrame(grants), openFrame(handle, gatewayPort)]);
  return { supervisor, frames, results, plan, marker: handle };
}

function announced(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (/http:\/\/127\.0\.0\.1:\d+/u.test(stdout)) resolve();
    });
    child.on("exit", (code) =>
      reject(new Error(`supervisor exited before the runner finished: ${String(code)}`)),
    );
  });
}

// Processes still running with this run's marker on their command line after the tree was ended.
function markedSurvivors(marker) {
  // Split, so the query's own command line never carries the marker it counts.
  const pattern = `('*' + '${marker.slice(0, 8)}' + '${marker.slice(8)}' + '*')`;
  const query = `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ${pattern} }).Count`;
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {
    encoding: "utf8",
  });
  return run.status === 0 ? Number(run.stdout.trim()) : `query-failed:${String(run.status)}`;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function supervise(staged) {
  const child = spawn(staged.supervisor, ["--relay-supervised"], {
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  try {
    child.stdio[3].write(staged.frames);
    await announced(child);
    const steps = JSON.parse(readFileSync(staged.results, "utf8"));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdio[3].write(terminateFrame());
    const supervisorExit = await exited;
    const survivors = steps.filter((step) => step.pid !== undefined && alive(step.pid));
    return {
      supervisorExit,
      steps,
      survivingDetachedPids: survivors.map((step) => step.pid),
      markedSurvivors: markedSurvivors(staged.marker),
    };
  } catch (error) {
    return { failure: error.message, supervisorStderr: stderr.slice(0, 2000) };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill();
  }
}

async function main() {
  if (process.platform !== "win32") {
    console.log("probe-windows-project-commands: SKIP (requires native Windows)");
    return;
  }
  const plan = JSON.parse(readFileSync(argument("--plan"), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "keiko-project-commands-"));
  const gateway = createServer((_request, response) => response.end("gateway"));
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  try {
    const staged = stage(argument("--helper"), root, plan, gateway.address().port);
    const outcome = await supervise(staged);
    const report = {
      osRelease: release(),
      arch: process.arch,
      user: process.env.USERNAME,
      ...outcome,
    };
    writeFileSync(argument("--out"), `${JSON.stringify(report, undefined, 2)}\n`);
    for (const step of report.steps ?? []) console.log(JSON.stringify(step));
    console.log(
      `probe-windows-project-commands: ${report.failure === undefined ? "DONE" : `FAILED ${report.failure}`}`,
    );
  } finally {
    gateway.close();
    rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  }
}

await main();
