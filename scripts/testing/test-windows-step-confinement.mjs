// #4496 (ADR-0043 D21, step mode): end-to-end proof of a governed verification step on Windows. It
// speaks keiko-tools' wire protocol (KRP1 launch and KGG1 grants on descriptor 3, KRS1 answers on
// descriptor 4, KRC1 terminate) to the supervisor under test with `--step-supervised`, which needs no
// installed service and no elevation. The step is Node.js in the run's AppContainer, and it names
// its execution root and its Node.js through `subst` drive letters, as keiko-server maps a step's
// granted directories: no capability Windows grants an AppContainer lists `C:\`, and Node.js walks
// every parent of its main module. The grants keep the real paths. The proof holds only when the
// step writes its execution root, cannot read a sibling folder, reaches neither the internet nor
// the host's loopback, ends with its own exit code, and a step that never ends is ended by KRC1
// with 137.
//
// Canaries for the #4496 acceptance criteria, each printed as a body-free PASS/FAIL line and, with
// `--json <file>`, written as booleans and error codes only:
//   (a) from inside a step the internet (a TEST-NET address, so no outside host is touched) is
//       refused with the AppContainer's EACCES, the host's loopback and another process's named
//       pipe are refused with an error code, and the
//       loopback listener and the pipe server, each reached once by the harness as a positive
//       control, see no connection from the step;
//   (b) a detached child and an `fs.watch` watcher a step started are gone when the step ends,
//       whether it exited by itself or KRC1 ended it; `tasklist` first finds a running process and
//       the children before KRC1, so "gone" is a state it can tell apart;
//   (c) a file outside the execution root and the private state can be neither read nor written,
//       and the credential-named files of the workspace stay out of reach. The product never grants
//       a credential-named file: keiko-server runs steps in a private copy of the workspace that
//       leaves every credential-named entry out (`windowsStepWorkspace.ts`, ADR-0043 D21, proven by
//       its unit tests), so the canary places such files in the real workspace next to that copy,
//       as the product does, and proves the step reaches neither.
//
// The `relay-confinement` job of `windows-gateway-confinement.yml` runs it on a hosted runner with
// the supervisor built as the release builds it; the standard-user proof runs in a Windows guest.
//
//   node scripts/testing/test-windows-step-confinement.mjs --helper <keiko-runtime-supervisor.exe> [--json <file>]
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

import {
  GRANT_MODIFY,
  GRANT_READ,
  grantsFrame,
  launchFrame,
  terminateFrame,
} from "./lib/windows-relay-frames.mjs";

const DEADLINE_MS = 90_000;
const STEP_EXIT = 7;
const RESPONSE_LAUNCHED = 1;
const RESPONSE_REAPED = 2;
const RESPONSE_ERROR = 3;
const OBSERVE_SAMPLES = 10;
const OBSERVE_INTERVAL_MS = 200;
const CHILD_FILES = ["heartbeat.pid", "heartbeat.txt", "watcher.pid", "watcher.txt"];

const STEP_SOURCE = String.raw`const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
function settle(open) {
  return new Promise((resolve) => {
    const socket = open();
    const timer = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 3000);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
    socket.on("error", (error) => { clearTimeout(timer); resolve("error:" + error.code); });
  });
}
const tcp = (host, port) => settle(() => net.connect({ host, port }));
const pipe = (name) => settle(() => net.connect({ path: name }));
function attempt(action) {
  try { action(); return "ok"; } catch (error) { return "error:" + error.code; }
}
const read = (file) => attempt(() => fs.readFileSync(file, "utf8"));
const write = (file) => attempt(() => fs.writeFileSync(file, "step"));
const ready = () => ["heartbeat.pid", "watcher.pid", "heartbeat.txt", "watcher.txt"].every(
  (name) => fs.existsSync(name) && (name.endsWith(".pid") || fs.statSync(name).size > 0));
async function startChildren() {
  const outcome = {};
  for (const name of ["heartbeat", "watcher"]) {
    outcome[name] = attempt(() => spawn(process.execPath, [path.join(process.cwd(), name + ".js")],
      { detached: true, stdio: "ignore", windowsHide: true }).unref());
  }
  for (let wait = 0; wait < 100 && !ready(); wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  outcome.ready = ready();
  // Which of the children's files never appeared, as a closed code ("none" when all did).
  outcome.missing = ["heartbeat.pid", "watcher.pid", "heartbeat.txt", "watcher.txt"]
    .filter((name) => !fs.existsSync(name)).map((name) => name.replace(".", "_")).join("-") || "none";
  return outcome;
}
(async () => {
  const mode = process.argv[2];
  if (mode === "forever") { setInterval(() => {}, 1000); return; }
  if (mode === "forever-detached") {
    const children = await startChildren();
    console.log("STEP " + JSON.stringify({ children }));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "detached") {
    console.log("STEP " + JSON.stringify({ children: await startChildren() }));
    process.exitCode = ${String(STEP_EXIT)};
    return;
  }
  const env = process.env;
  const answer = {
    write: write("written.txt"),
    systemChild: (() => {
      const cmd = (env.SystemRoot || "C:\\Windows") + "\\System32\\cmd.exe";
      const result = spawnSync(cmd, ["/d", "/c", "exit 7"], { stdio: "ignore", windowsHide: true, cwd: env.SystemRoot });
      return result.error === undefined ? "exit:" + String(result.status) : "error:" + result.error.code;
    })(),
    child: (() => {
      const result = spawnSync(process.execPath, ["-e", "process.exitCode = 7"], { stdio: "ignore", windowsHide: true });
      return result.error === undefined ? "exit:" + String(result.status) : "error:" + result.error.code;
    })(),
    outside: read(env.KEIKO_STEP_OUTSIDE),
    outsideWrite: write(env.KEIKO_STEP_OUTSIDE_WRITE),
    privateRead: read(env.KEIKO_STEP_PRIVATE_READ),
    privateWrite: write(env.KEIKO_STEP_PRIVATE_WRITE),
    credentialRead: read(env.KEIKO_STEP_CREDENTIAL),
    credentialWrite: write(env.KEIKO_STEP_CREDENTIAL),
    keyRead: read(env.KEIKO_STEP_KEY),
    keyWrite: write(env.KEIKO_STEP_KEY),
    internet: await tcp("192.0.2.1", 443),
    loopback: await tcp("127.0.0.1", Number(env.KEIKO_STEP_HOST_PORT)),
    pipe: await pipe(env.KEIKO_STEP_PIPE),
  };
  console.log("STEP " + JSON.stringify(answer));
  process.exitCode = ${String(STEP_EXIT)};
})();
`;

// Children a step starts detached; they write their own pid and a heartbeat into the root.
const HEARTBEAT_SOURCE = `const fs = require("node:fs");
fs.writeFileSync("heartbeat.pid", String(process.pid));
setInterval(() => fs.appendFileSync("heartbeat.txt", "x"), 200);
`;
const WATCHER_SOURCE = `const fs = require("node:fs");
fs.writeFileSync("watcher.pid", String(process.pid));
fs.watch(".", (_event, name) => {
  if (name === "heartbeat.txt") {
    try { fs.appendFileSync("watcher.txt", "e"); } catch { /* the root is going away */ }
  }
});
setInterval(() => {}, 1000);
`;

// Body-free canary results: a closed id, the criterion, a verdict and a short error code at most.
const results = [];

function observedCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,40}$/u.test(value) ? value : undefined;
}

function check(id, criterion, pass, observed) {
  const code = observedCode(observed);
  results.push({ id, criterion, pass, ...(code === undefined ? {} : { observed: code }) });
  console.log(
    `windows-step-confinement: ${pass ? "PASS" : "FAIL"} ${criterion} ${id}${code === undefined ? "" : ` (${code})`}`,
  );
}

const refused = (value) => typeof value === "string" && value.startsWith("error:");

function helperArgument() {
  const index = process.argv.indexOf("--helper");
  const helper = index === -1 ? undefined : process.argv[index + 1];
  if (helper === undefined) throw new Error("usage: --helper <keiko-runtime-supervisor.exe>");
  return helper;
}

function jsonArgument() {
  const index = process.argv.indexOf("--json");
  return index === -1 ? undefined : process.argv[index + 1];
}

// One connection from the harness, settled on the server's side: the count is read only after the
// server accepted it, so a late accept cannot land after the reset.
async function positiveControl(state, open) {
  const accepted = once(state.server, "connection");
  const control = open();
  control.on("connect", () => control.destroy());
  const failed = once(control, "error").then(() => undefined);
  const closed = once(control, "close");
  await Promise.race([accepted, failed]);
  await closed;
}

// The host's loopback listener: it counts every connection it accepts.
async function startHostListener() {
  const state = { connections: 0 };
  state.server = createServer((socket) => {
    state.connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => state.server.listen(0, "127.0.0.1", resolve));
  state.port = state.server.address().port;
  // Positive control: the harness itself reaches the listener, so a refusal later is the step's.
  await positiveControl(state, () => connect({ host: "127.0.0.1", port: state.port }));
  check("loopback-positive-control", "(a)", state.connections === 1);
  state.connections = 0;
  return state;
}

// Another process's named pipe: it counts every connection it accepts.
async function startPipeServer() {
  const path = String.raw`\\.\pipe\keiko-canary-` + randomBytes(8).toString("hex");
  const state = { path, connections: 0 };
  state.server = createServer((socket) => {
    state.connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => state.server.listen(path, resolve));
  // Positive control: the harness itself reaches its pipe, so a refusal later is the step's.
  await positiveControl(state, () => connect({ path }));
  check("pipe-positive-control", "(a)", state.connections === 1);
  state.connections = 0;
  return state;
}

// One KRS1 answer after another, as the supervisor writes them on descriptor 4.
function answers(stream) {
  const received = [];
  let pending = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 12) {
      const length = pending.readUInt32LE(8);
      if (pending.length < 12 + length) return;
      received.push({ kind: pending.readUInt16LE(6), payload: pending.subarray(12, 12 + length) });
      pending = pending.subarray(12 + length);
    }
  });
  return received;
}

// The step's Node.js: a copy this user owns. A runtime an administrator installed outside
// `Program Files` cannot take the tree's grant, and the supervisor refuses it with code 8 (G1).
function stepNode(root) {
  return join(dirname(root), "node", "node.exe");
}

function copyStepNode(root) {
  mkdirSync(join(root, "node"), { recursive: true });
  copyFileSync(process.execPath, join(root, "node", "node.exe"));
}

// A free drive letter for `target` in this logon session, from the end of the alphabet.
function subst(target) {
  const command = join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "subst.exe");
  for (const letter of "ZYXWVUTSRQPONMLKJIHGFED") {
    const drive = `${letter}:`;
    if (existsSync(`${drive}\\`)) continue;
    if (spawnSync(command, [drive, target], { stdio: "ignore" }).status === 0) {
      return { drive, release: () => spawnSync(command, [drive, "/D"], { stdio: "ignore" }) };
    }
  }
  throw new Error("no drive letter is free for the step");
}

// The folders of one staged step. Only `execution` (modify) and the Node.js copy (read) are
// granted: `outside` is a sibling of the root, `privateState` stands in for Keiko's private state,
// and `workspace` is the real workspace whose credential-named files the product's private copy
// leaves out of the granted root.
function stageFolders(root) {
  const folders = {
    execution: join(root, "execution"),
    outside: join(root, "outside"),
    privateState: join(root, "private-state"),
    workspace: join(root, "workspace"),
    supervisorDirectory: join(root, "supervisor"),
  };
  for (const directory of Object.values(folders)) mkdirSync(directory, { recursive: true });
  const supervisor = join(folders.supervisorDirectory, "keiko-runtime-supervisor.exe");
  writeFileSync(join(folders.execution, "step.js"), STEP_SOURCE);
  writeFileSync(join(folders.execution, "heartbeat.js"), HEARTBEAT_SOURCE);
  writeFileSync(join(folders.execution, "watcher.js"), WATCHER_SOURCE);
  writeFileSync(join(folders.outside, "secret.txt"), "outside");
  writeFileSync(join(folders.privateState, "state.db"), "private");
  writeFileSync(join(folders.workspace, ".env"), "SECRET=1");
  writeFileSync(join(folders.workspace, "id_rsa"), "key");
  return { ...folders, supervisor };
}

function stepEnvironment(folders, hostPort, pipePath, tempDrive) {
  return [
    ["KEIKO_STEP_CREDENTIAL", join(folders.workspace, ".env")],
    ["KEIKO_STEP_HOST_PORT", String(hostPort)],
    ["KEIKO_STEP_KEY", join(folders.workspace, "id_rsa")],
    ["KEIKO_STEP_OUTSIDE", join(folders.outside, "secret.txt")],
    ["KEIKO_STEP_OUTSIDE_WRITE", join(folders.outside, "written-by-step.txt")],
    ["KEIKO_STEP_PIPE", pipePath],
    ["KEIKO_STEP_PRIVATE_READ", join(folders.privateState, "state.db")],
    ["KEIKO_STEP_PRIVATE_WRITE", join(folders.privateState, "written-by-step.txt")],
    ["SystemRoot", process.env.SystemRoot ?? String.raw`C:\Windows`],
    ["TEMP", tempDrive],
    ["TMP", tempDrive],
  ];
}

function stage(helper, root, context, drives, argument) {
  const folders = stageFolders(root);
  copyFileSync(helper, folders.supervisor);
  // Step mode joins the arguments verbatim; these paths hold no quote or trailing backslash.
  const workDrive = subst(folders.execution);
  const nodeDrive = subst(dirname(stepNode(root)));
  drives.push(workDrive, nodeDrive);
  const args = [`"${workDrive.drive}\\step.js"`, ...(argument === undefined ? [] : [argument])];
  const environment = stepEnvironment(
    folders,
    context.hostPort,
    context.pipe.path,
    `${workDrive.drive}\\`,
  );
  const frames = Buffer.concat([
    launchFrame(
      randomBytes(16).toString("hex"),
      `${nodeDrive.drive}\\node.exe`,
      `${workDrive.drive}\\`,
      args,
      environment,
    ),
    grantsFrame([
      { access: GRANT_MODIFY, path: folders.execution },
      { access: GRANT_READ, path: dirname(stepNode(root)) },
    ]),
  ]);
  return { ...folders, frames };
}

function start(supervisor, frames) {
  const child = spawn(supervisor, ["--step-supervised"], {
    stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
  });
  const received = answers(child.stdio[4]);
  const output = { stdout: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout += String(chunk);
  });
  // A supervisor that ended closes its control pipe; its answers decide the proof.
  child.stdio[3].on("error", (error) => void error);
  child.stdio[3].write(frames);
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  const closed = new Promise((resolve) =>
    child.once("close", (code) => {
      clearTimeout(deadline);
      resolve(code);
    }),
  );
  return { child, received, output, closed };
}

async function run(supervisor, frames) {
  const started = start(supervisor, frames);
  const code = await started.closed;
  return { code, stdout: started.output.stdout, received: started.received };
}

// Each answer as `kind` or `kind:code` for an error, for a failure message.
function describe(received) {
  return (
    received
      .map((answer) =>
        answer.kind === RESPONSE_ERROR
          ? `${String(answer.kind)}:${String(answer.payload.readUInt16LE(0))}`
          : String(answer.kind),
      )
      .join(",") || "none"
  );
}

function reapedExit(received) {
  const errors = received.filter((answer) => answer.kind === RESPONSE_ERROR);
  assert.deepEqual(
    errors.map((answer) => answer.payload.readUInt16LE(0)),
    [],
    "the supervisor refused nothing",
  );
  assert.equal(received[0]?.kind, RESPONSE_LAUNCHED, "the step launched");
  const reaped = received.find((answer) => answer.kind === RESPONSE_REAPED);
  assert.notEqual(reaped, undefined, "the supervisor reported the step's exit");
  return reaped.payload.readUInt32LE(0);
}

function stepAnswer({ code, stdout, received }) {
  const line = stdout.split(/\r?\n/u).find((entry) => entry.startsWith("STEP "));
  assert.notEqual(
    line,
    undefined,
    `the step reported its probes (supervisor ${String(code)}, answers ${describe(received)})`,
  );
  try {
    return JSON.parse(line.slice(5));
  } catch (error) {
    // The step's output is not echoed: a malformed report is a closed failure.
    if (error instanceof SyntaxError)
      throw new Error("the step's report is not JSON", { cause: error });
    throw error;
  }
}

const fileText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

// A refusal is an error code the step saw; a probe that only timed out proves nothing.
function checkNetwork(answer, host, pipe) {
  // A TEST-NET address is unroutable for everyone; only the AppContainer's EACCES is a refusal.
  check("internet-refused", "(a)", answer.internet === "error:EACCES", answer.internet);
  check("loopback-refused", "(a)", refused(answer.loopback), answer.loopback);
  check("loopback-listener-saw-no-connection", "(a)", host.connections === 0);
  check("pipe-refused", "(a)", refused(answer.pipe), answer.pipe);
  check("pipe-server-saw-no-connection", "(a)", pipe.connections === 0);
}

function checkOutside(answer, staged) {
  check("write-into-root-allowed", "(c)", answer.write === "ok", answer.write);
  // A test command starts children (Maven starts Java): a plain child of the step runs.
  check("plain-child-runs", "(b)", answer.child === "exit:7", answer.child);
  check("system-child-runs", "(b)", answer.systemChild === "exit:7", answer.systemChild);
  check("write-landed-in-root", "(c)", existsSync(join(staged.execution, "written.txt")));
  check("outside-read-refused", "(c)", refused(answer.outside), answer.outside);
  check("outside-write-refused", "(c)", refused(answer.outsideWrite), answer.outsideWrite);
  check(
    "outside-file-not-created",
    "(c)",
    !existsSync(join(staged.outside, "written-by-step.txt")),
  );
  check("private-read-refused", "(c)", refused(answer.privateRead), answer.privateRead);
  check("private-write-refused", "(c)", refused(answer.privateWrite), answer.privateWrite);
  check(
    "private-state-untouched",
    "(c)",
    !existsSync(join(staged.privateState, "written-by-step.txt")) &&
      fileText(join(staged.privateState, "state.db")) === "private",
  );
}

function checkCredentials(answer, staged) {
  check("credential-read-refused", "(c)", refused(answer.credentialRead), answer.credentialRead);
  check("credential-write-refused", "(c)", refused(answer.credentialWrite), answer.credentialWrite);
  check("key-read-refused", "(c)", refused(answer.keyRead), answer.keyRead);
  check("key-write-refused", "(c)", refused(answer.keyWrite), answer.keyWrite);
  check(
    "credential-files-untouched",
    "(c)",
    fileText(join(staged.workspace, ".env")) === "SECRET=1" &&
      fileText(join(staged.workspace, "id_rsa")) === "key",
  );
}

async function boundaries(helper, root, context, drives) {
  const staged = stage(helper, join(root, "a"), context, drives);
  const outcome = await run(staged.supervisor, staged.frames);
  const answer = stepAnswer(outcome);
  checkNetwork(answer, context.host, context.pipe);
  checkOutside(answer, staged);
  checkCredentials(answer, staged);
  check("step-exit-code-reported", "(c)", reapedExit(outcome.received) === STEP_EXIT);
}

const sizeOf = (path) => (existsSync(path) ? statSync(path).size : 0);

function childPid(execution, name) {
  const pid = Number(fileText(join(execution, `${name}.pid`)));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// Whether `pid` is still a process of this host, from `tasklist`; `undefined` when it gave no listing.
function processAlive(pid) {
  const command = join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    "System32",
    "tasklist.exe",
  );
  const listing = spawnSync(command, ["/FI", `PID eq ${String(pid)}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (listing.status !== 0) return undefined;
  return listing.stdout.includes(`,"${String(pid)}",`);
}

// Polls until `pid` is gone, so the verdict is a state reached, not one time-sampled read.
async function processGone(pid) {
  for (let poll = 0; poll < OBSERVE_SAMPLES; poll += 1) {
    const alive = processAlive(pid);
    if (alive === false) return true;
    if (alive === undefined) return false;
    await new Promise((resolve) => setTimeout(resolve, OBSERVE_INTERVAL_MS)); // NOSONAR javascript:S9382 -- each poll waits for the child to end.
  }
  return false;
}

// Positive control: `tasklist` finds a process that runs, so "gone" later is the child's state.
function checkTasklistControl() {
  check("tasklist-positive-control", "(b)", processAlive(process.pid) === true);
}

// The spawn outcome and the files that never appeared, so a start that failed says how.
function checkChildrenStarted(label, answer, started) {
  const children = answer.children ?? {};
  check(`${label}-heartbeat-spawned`, "(b)", children.heartbeat === "ok", children.heartbeat);
  check(`${label}-watcher-spawned`, "(b)", children.watcher === "ok", children.watcher);
  check(`${label}-children-started`, "(b)", started, children.missing);
}

// After the step ended: both children started, then neither runs and neither file grows any more.
async function observeChildren(label, execution, answer) {
  const pids = {
    heartbeat: childPid(execution, "heartbeat"),
    watcher: childPid(execution, "watcher"),
  };
  const before = CHILD_FILES.map((name) => sizeOf(join(execution, name)));
  const started = answer.children?.ready === true && !Object.values(pids).includes(undefined);
  checkChildrenStarted(label, answer, started);
  let grew = false;
  for (let sample = 0; sample < OBSERVE_SAMPLES; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, OBSERVE_INTERVAL_MS)); // NOSONAR javascript:S9382 -- a bounded observation window after the reaped answer.
    const now = CHILD_FILES.map((name) => sizeOf(join(execution, name)));
    grew ||= now.some((size, index) => size !== before[index]);
  }
  check(`${label}-heartbeat-stopped`, "(b)", !grew);
  for (const [name, pid] of Object.entries(pids)) {
    check(`${label}-${name}-process-gone`, "(b)", pid !== undefined && (await processGone(pid)));
  }
}

async function detachedChildren(helper, root, context, drives) {
  const staged = stage(helper, join(root, "c"), context, drives, "detached");
  const outcome = await run(staged.supervisor, staged.frames);
  const answer = stepAnswer(outcome);
  check("detached-step-exit-code-reported", "(b)", reapedExit(outcome.received) === STEP_EXIT);
  await observeChildren("detached", staged.execution, answer);
}

// Until the step has reported its children.
async function untilReported(started) {
  while (!started.output.stdout.includes("STEP ")) {
    if (started.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100)); // NOSONAR javascript:S9382 -- each check waits for the step's report.
  }
  return stepAnswer({ code: undefined, stdout: started.output.stdout, received: started.received });
}

// A step that never ends: KRC1 after the launch, then the supervisor reports 137.
async function endedByControl(helper, root, context, drives, argument) {
  const folder = join(root, argument === "forever" ? "b" : "d");
  const staged = stage(helper, folder, context, drives, argument);
  const started = start(staged.supervisor, staged.frames);
  while (!started.received.some((answer) => answer.kind === RESPONSE_LAUNCHED)) {
    if (started.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100)); // NOSONAR javascript:S9382 -- each check waits for the previous answer.
  }
  const answer = argument === "forever" ? undefined : await untilReported(started);
  if (answer !== undefined) {
    // Positive control: the children run before KRC1, so their absence afterwards is its effect.
    const alive = ["heartbeat", "watcher"].map((name) => childPid(staged.execution, name));
    check(
      "killed-children-alive-before-krc1",
      "(b)",
      alive.every((pid) => pid !== undefined && processAlive(pid) === true),
    );
  }
  started.child.stdio[3].write(terminateFrame());
  await started.closed;
  return { exit: reapedExit(started.received), staged, answer };
}

async function killedStep(helper, root, context, drives) {
  const { exit, staged, answer } = await endedByControl(
    helper,
    root,
    context,
    drives,
    "forever-detached",
  );
  check("kill-step-with-children-exit-137", "(b)", exit === 137, String(exit));
  await observeChildren("killed", staged.execution, answer);
}

async function suite(helper, root, context, drives) {
  copyStepNode(root);
  checkTasklistControl();
  await boundaries(helper, root, context, drives);
  const plain = await endedByControl(helper, root, context, drives, "forever");
  check("kill-ends-step-with-137", "(c)", plain.exit === 137, String(plain.exit));
  await detachedChildren(helper, root, context, drives);
  await killedStep(helper, root, context, drives);
}

function writeSummary(path) {
  const summary = {
    schema: "keiko.windows-step-canaries/1",
    platform: process.platform,
    pass: results.length > 0 && results.every((entry) => entry.pass),
    results,
  };
  if (path !== undefined) writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
  return summary.pass;
}

async function main() {
  if (process.platform !== "win32") {
    console.log("windows-step-confinement: SKIP (requires native Windows)");
    return;
  }
  const helper = helperArgument();
  const jsonPath = jsonArgument();
  const root = mkdtempSync(join(tmpdir(), "keiko-step-confinement-"));
  const host = await startHostListener();
  const pipe = await startPipeServer();
  const drives = [];
  try {
    await suite(helper, root, { hostPort: host.port, host, pipe }, drives);
  } catch (error) {
    check("harness-completed", "harness", false, error instanceof Error ? error.name : undefined);
    console.log(`windows-step-confinement: ${error instanceof Error ? error.message : "failed"}`);
  } finally {
    host.server.close();
    pipe.server.close();
    for (const drive of drives) drive.release();
    rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  }
  const pass = writeSummary(jsonPath);
  console.log(`windows-step-confinement: ${pass ? "PASS" : "FAIL"}`);
  process.exitCode = pass ? 0 : 1;
}

await main();
