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
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
console.log("${"KEIKO_STEP_NODE_PROBE_START"}");
const result = { uv: process.versions.uv, node: process.versions.node };
function listen(name) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => resolve("error:" + String(error.code)));
    server.listen(name, () => server.close(() => resolve("listening")));
  });
}
function forkEcho() {
  return new Promise((resolve) => {
    const child = fork(path.join(__dirname, "echo-child.js"), [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.once("message", (message) => { result.forkEcho = message.echo; });
    child.once("exit", (code) => resolve(code));
    child.send({ ping: 1 });
  });
}
async function main() {
  const spawned = spawnSync(process.execPath, ["-e", "process.stdout.write('child-ok')"], { encoding: "utf8", timeout: 60000 });
  result.spawnSync = { status: spawned.status, stdout: spawned.stdout };
  result.forkExit = await forkEcho();
  const tests = spawnSync(process.execPath, ["--test", "a.test.js", "b.test.js"], { cwd: __dirname, encoding: "utf8", timeout: 120000 });
  result.nodeTest = { status: tests.status, passes: (tests.stdout.match(/^# pass (\d+)/mu) ?? [])[1] };
  const stamp = String(process.pid);
  result.globalPipe = await listen("\\\\.\\pipe\\keiko-step-node-global-" + stamp);
  result.localPipe = await listen("\\\\.\\pipe\\LOCAL\\keiko-step-node-local-" + stamp);
  console.log("${"KEIKO_STEP_NODE_PROBE_RESULT "}" + JSON.stringify(result));
}
main().catch((error) => { console.log("probe-error:" + String(error)); process.exitCode = 1; });
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
    "probe.js": PROBE_SOURCE,
    "echo-child.js": ECHO_CHILD_SOURCE,
    "a.test.js": TEST_SOURCE,
    "b.test.js": TEST_SOURCE,
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
      [join(runtimeDirectory, "probe.js")],
      environment,
    ),
    grantsFrame([runtimeDirectory, supervisorDirectory]),
    openFrame(handle, gatewayPort),
  ]);
  return { supervisor, frames };
}

// Runs the probe in the supervisor's AppContainer. Resolves { started, result } once the probe
// printed its result or the deadline passed; the supervisor tree is always terminated afterwards.
async function runProbe(helper, nodeExecutable, deadlineMs) {
  const root = mkdtempSync(join(tmpdir(), "keiko-step-node-"));
  const gateway = await startGateway();
  let child;
  try {
    const { supervisor, frames } = stageRun(helper, nodeExecutable, root, gateway.address().port);
    child = spawn(supervisor, ["--relay-supervised"], {
      stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
    });
    child.stdio[3].write(frames);
    return await collect(child, deadlineMs);
  } finally {
    if (child !== undefined) await terminate(child);
    gateway.close();
    rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  }
}

function collect(child, deadlineMs) {
  return new Promise((resolve) => {
    let stdout = "";
    const outcome = () => {
      const line = stdout.split("\n").find((entry) => entry.startsWith(RESULT_MARK));
      return {
        started: stdout.includes(START_MARK),
        result: line === undefined ? undefined : JSON.parse(line.slice(RESULT_MARK.length)),
        stdout,
      };
    };
    const timer = setTimeout(() => resolve(outcome()), deadlineMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes(RESULT_MARK) && stdout.endsWith("\n")) {
        clearTimeout(timer);
        resolve(outcome());
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(outcome());
    });
  });
}

async function terminate(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdio[3].write(header("KRC1", 3, 0));
  const timer = setTimeout(() => child.kill(), 30_000);
  await exited;
  clearTimeout(timer);
}

function assertPatchedResult(outcome) {
  assert.equal(outcome.started, true, "the probe started inside the container");
  assert.notEqual(outcome.result, undefined, `the probe finished: ${outcome.stdout.slice(0, 400)}`);
  const result = outcome.result;
  assert.match(result.uv, PATCHED_UV, "process.versions.uv names the patched libuv");
  assert.deepEqual(result.spawnSync, { status: 0, stdout: "child-ok" }, "spawnSync child exits");
  assert.equal(result.forkExit, 0, "fork with IPC exits");
  assert.equal(result.forkEcho, 1, "the IPC round trip answered");
  assert.equal(result.nodeTest.status, 0, "node --test over two files exits clean");
  assert.equal(result.nodeTest.passes, "2", "both test files ran");
  assert.match(result.globalPipe, /^error:(EACCES|EPERM)$/u, "a global pipe is still refused");
  assert.equal(result.localPipe, "listening", "a LOCAL pipe is allowed (positive control)");
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
    assert.equal(
      outcome.result,
      undefined,
      "the stock Node.js does not finish inside the container",
    );
    control = "stock-hangs";
  }
  console.log(
    `windows-step-node: PASS uv=${result.uv} node=${result.node} globalPipe=${result.globalPipe} control=${control}`,
  );
}

await main();
