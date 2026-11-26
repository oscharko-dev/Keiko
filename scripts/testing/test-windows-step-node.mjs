// #4492 (ADR-0043 D20/D21): proof that the patched Windows step Node.js (libuv#5181, built by
// .github/workflows/windows-step-node.yml) works inside the run's AppContainer. It starts the
// patched node.exe through the real runtime supervisor (`--relay-supervised`) exactly as a confined
// verification step is started, and the probe running inside the container must show that
// spawnSync, fork with IPC and `node --test` over two files all exit, that `process.versions.uv`
// names the patched libuv, and that a pipe in the global namespace is still refused while a LOCAL
// one works. With --stock-node the same probe runs under the unpatched official binary and must
// NOT finish: that is the positive control proving the container really reproduces the defect.
//
//   node scripts/testing/test-windows-step-node.mjs --helper <keiko-runtime-supervisor.exe> \
//     --node <patched node.exe> [--stock-node <official node.exe>]
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import {
  grantsFrame,
  header,
  launchFrame,
  openFrame,
} from "../lib/windows-supervisor-protocol.mjs";

const PROBE_DEADLINE_MS = 240_000;
const STOCK_DEADLINE_MS = 60_000;
const START_MARK = "KEIKO_STEP_NODE_PROBE_START";
const RESULT_MARK = "KEIKO_STEP_NODE_PROBE_RESULT ";
const PATCHED_UV = /^1\.52\.1-keiko\.5181$/u;

const PROBE_SOURCE = String.raw`const { spawnSync, fork } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
console.log(${JSON.stringify(START_MARK)});
const result = { uv: process.versions.uv, node: process.versions.node, exec: process.execPath };
const attempt = (fn) => { try { return brief(fn()); } catch (error) { return { threw: String(error.code) + "/" + String(error.syscall) + "/" + String(error.message) }; } };
const brief = (r) => ({ status: r.status, stdout: r.stdout, error: r.error ? String(r.error.code) + "/" + String(r.error.syscall) : undefined });
function listen(name) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => resolve("error:" + String(error.code)));
    server.listen(name, () => server.close(() => resolve("listening")));
  });
}
function forkEcho() {
  return new Promise((resolve) => {
    const child = fork(path.join(__dirname, "echo-child.cjs"), [], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
    child.once("message", (message) => { result.forkEcho = message.echo; });
    child.once("error", (error) => resolve("error:" + String(error.code)));
    child.once("exit", (code) => resolve(code));
    child.send({ ping: 1 });
  });
}
async function main() {
  const args = ["-e", "process.stdout.write('child-ok')"];
  result.ignoreStdioInfo = attempt(() => spawnSync(process.execPath, args, { stdio: "ignore", timeout: 60000 }));
  result.spawnSync = attempt(() => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000 }));
  result.forkExit = await forkEcho();
  const tests = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "a.test.cjs", "b.test.cjs"], { cwd: __dirname, encoding: "utf8", timeout: 120000 });
  result.nodeTest = { status: tests.status, error: brief(tests).error, passes: ((tests.stdout ?? "").match(/^# pass (\d+)/mu) ?? [])[1] };
  const stamp = String(process.pid);
  result.globalPipe = await listen("\\\\.\\pipe\\keiko-step-node-global-" + stamp);
  result.localPipe = await listen("\\\\.\\pipe\\LOCAL\\keiko-step-node-local-" + stamp);
  console.log(${JSON.stringify(RESULT_MARK)} + JSON.stringify(result));
}
main().catch((error) => {
  result.probeError = String(error);
  console.log(${JSON.stringify(RESULT_MARK)} + JSON.stringify(result));
  process.exitCode = 1;
});
`;

const ECHO_CHILD_SOURCE = `process.on("message", (message) => {
  process.send({ echo: message.ping }, () => process.exit(0));
});
`;

const TEST_SOURCE = `const test = require("node:test");
const assert = require("node:assert/strict");
test("pass", () => assert.equal(1 + 1, 2));
`;

function argument(name, required) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (required && value === undefined) throw new Error(`missing ${name}`);
  return value;
}

function startGateway() {
  const server = createServer((_request, response) => response.end("ok"));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Owner-held directories: the supervisor grants the tree access to them by its own token.
function stageRun(helper, nodeExecutable, root, gatewayPort) {
  const runtimeDirectory = join(root, "runtime");
  const supervisorDirectory = join(root, "supervisor");
  for (const directory of [runtimeDirectory, supervisorDirectory]) mkdirSync(directory);
  const supervisor = join(supervisorDirectory, "keiko-runtime-supervisor.exe");
  copyFileSync(helper, supervisor);
  copyFileSync(nodeExecutable, join(runtimeDirectory, "node.exe"));
  const files = {
    "probe.cjs": PROBE_SOURCE,
    "echo-child.cjs": ECHO_CHILD_SOURCE,
    "a.test.cjs": TEST_SOURCE,
    "b.test.cjs": TEST_SOURCE,
  };
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(runtimeDirectory, name), source);
  }
  const handle = randomBytes(16).toString("hex");
  // Node.js resolves C:\ itself unless told to keep symlinked paths, which an AppContainer may not read.
  const preserve = "--preserve-symlinks-main --preserve-symlinks";
  const environment = [
    ["NODE_OPTIONS", preserve],
    ["TEMP", runtimeDirectory],
    ["TMP", runtimeDirectory],
  ].sort(([left], [right]) => left.localeCompare(right));
  const frames = Buffer.concat([
    launchFrame(
      handle,
      join(runtimeDirectory, "node.exe"),
      runtimeDirectory,
      [join(runtimeDirectory, "probe.cjs")],
      environment,
    ),
    grantsFrame([runtimeDirectory, supervisorDirectory]),
    openFrame(handle, gatewayPort),
  ]);
  return { supervisor, frames };
}

// Counts the node.exe processes running from this run's staged directory. The unique directory name
// avoids 8.3 short-name mismatches of the temp path.
function stagedNodeProcesses(root) {
  const token = basename(root);
  const filter = `$_.ExecutablePath -like '*\\${token}\\runtime\\*'`;
  const query = `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { ${filter} }).Count`;
  const answer = spawnSync("powershell.exe", ["-NoProfile", "-Command", query], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return answer.status === 0 ? Number(answer.stdout.trim()) : Number.NaN;
}

async function waitUntilGone(root) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (stagedNodeProcesses(root) === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return stagedNodeProcesses(root) === 0;
}

// Runs the probe in the supervisor's AppContainer. Resolves { started, result, timedOut, ... } once
// the probe printed its result, the supervisor ended or the deadline passed; the supervisor tree is
// always terminated afterwards, and the staged node.exe must be gone once the KRC1 frame was sent.
async function runProbe(helper, nodeExecutable, deadlineMs) {
  const root = mkdtempSync(join(tmpdir(), "keiko-step-node-"));
  const gateway = await startGateway();
  let child;
  try {
    const { supervisor, frames } = stageRun(helper, nodeExecutable, root, gateway.address().port);
    child = spawn(supervisor, ["--relay-supervised"], {
      stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
    });
    child.on("error", () => undefined);
    child.stdio[3].on("error", () => undefined);
    child.stdio[3].write(frames);
    const outcome = await collect(child, deadlineMs);
    // Positive control for the process query: the staged node.exe runs now unless the probe ended.
    outcome.stagedBefore = stagedNodeProcesses(root);
    await terminate(child);
    outcome.reaped = await waitUntilGone(root);
    return outcome;
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill();
    gateway.close();
    rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  }
}

function collect(child, deadlineMs) {
  return new Promise((resolve) => {
    let stdout = "";
    const outcome = (timedOut) => {
      const line = stdout.split("\n").find((entry) => entry.startsWith(RESULT_MARK));
      return {
        started: stdout.includes(START_MARK),
        result: line === undefined ? undefined : JSON.parse(line.slice(RESULT_MARK.length)),
        stdout,
        timedOut,
        supervisorAlive: child.exitCode === null && child.signalCode === null,
      };
    };
    const timer = setTimeout(() => resolve(outcome(true)), deadlineMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(RESULT_MARK) && stdout.endsWith("\n")) {
        clearTimeout(timer);
        resolve(outcome(false));
      }
    });
    // close, not exit: stdout is drained before the outcome is read.
    child.once("close", () => {
      clearTimeout(timer);
      resolve(outcome(false));
    });
  });
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  const control = child.stdio[3];
  if (control.writable) control.write(header("KRC1", 3, 0));
  const timer = setTimeout(() => child.kill(), 30_000);
  await closed;
  clearTimeout(timer);
}

function assertPatchedResult(outcome) {
  assert.equal(outcome.started, true, "the probe started inside the container");
  assert.notEqual(outcome.result, undefined, `the probe finished: ${outcome.stdout.slice(0, 400)}`);
  const result = outcome.result;
  assert.equal(result.probeError, undefined, `the probe ran every step: ${JSON.stringify(result)}`);
  assert.match(result.uv, PATCHED_UV, "process.versions.uv names the patched libuv");
  assert.deepEqual(
    result.spawnSync,
    { status: 0, stdout: "child-ok" },
    `spawnSync child exits: ${JSON.stringify(result)}`,
  );
  assert.equal(result.ignoreStdioInfo.status, null, "ignored stdio does not run a child");
  assert.match(
    result.ignoreStdioInfo.error,
    /^EPERM\/spawnSync /u,
    "ignored stdio opens NUL, which the AppContainer refuses (expected EPERM)",
  );
  assert.equal(result.forkExit, 0, "fork with IPC exits");
  assert.equal(result.forkEcho, 1, "the IPC round trip answered");
  assert.equal(result.nodeTest.status, 0, "node --test over two files exits clean");
  assert.equal(result.nodeTest.passes, "2", "both test files ran");
  assert.match(
    result.globalPipe,
    // libuv reports ERROR_ACCESS_DENIED from CreateNamedPipe as EADDRINUSE on a pipe bind.
    /^error:(EACCES|EPERM|EADDRINUSE)$/u,
    `a global pipe is still refused: ${JSON.stringify(result)}`,
  );
  assert.equal(result.localPipe, "listening", "a LOCAL pipe is allowed (positive control)");
  assert.equal(outcome.reaped, true, "the patched node.exe is gone after the KRC1 frame");
  return result;
}

async function main() {
  if (process.platform !== "win32") {
    console.log("windows-step-node: SKIP (requires native Windows)");
    return;
  }
  const helper = argument("--helper", true);
  const patched = argument("--node", true);
  const stock = argument("--stock-node", false);
  const result = assertPatchedResult(await runProbe(helper, patched, PROBE_DEADLINE_MS));
  let control = "not-run";
  if (stock !== undefined) {
    const outcome = await runProbe(helper, stock, STOCK_DEADLINE_MS);
    assert.equal(outcome.started, true, "the stock probe started inside the container");
    assert.equal(outcome.timedOut, true, "the stock probe ran to the deadline");
    assert.equal(outcome.supervisorAlive, true, "the supervisor was still alive at the deadline");
    assert.equal(
      outcome.result,
      undefined,
      "the stock Node.js does not finish inside the container",
    );
    assert.equal(
      outcome.stagedBefore >= 1,
      true,
      "the stock node.exe was running (positive control)",
    );
    assert.equal(outcome.reaped, true, "the stock node.exe is gone after the KRC1 frame");
    control = "stock-hangs";
  }
  console.log(
    `windows-step-node: PASS uv=${result.uv} node=${result.node} globalPipe=${result.globalPipe} control=${control}`,
  );
}

await main();
