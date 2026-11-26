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
//   node scripts/testing/test-windows-step-confinement.mjs --helper <keiko-runtime-supervisor.exe>
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

const STEP_SOURCE = String.raw`const fs = require("node:fs");
const net = require("node:net");
function tcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 3000);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
    socket.on("error", (error) => { clearTimeout(timer); resolve("error:" + error.code); });
  });
}
function attempt(action) {
  try { action(); return "ok"; } catch (error) { return "error:" + error.code; }
}
(async () => {
  if (process.argv[2] === "forever") { setInterval(() => {}, 1000); return; }
  const answer = {
    write: attempt(() => fs.writeFileSync("written.txt", "step")),
    outside: attempt(() => fs.readFileSync(process.env.KEIKO_STEP_OUTSIDE, "utf8")),
    internet: await tcp("1.1.1.1", 443),
    loopback: await tcp("127.0.0.1", Number(process.env.KEIKO_STEP_HOST_PORT)),
  };
  console.log("STEP " + JSON.stringify(answer));
  process.exitCode = ${String(STEP_EXIT)};
})();
`;

function helperArgument() {
  const index = process.argv.indexOf("--helper");
  const helper = index === -1 ? undefined : process.argv[index + 1];
  if (helper === undefined) throw new Error("usage: --helper <keiko-runtime-supervisor.exe>");
  return helper;
}

function startHostListener() {
  const server = createServer((socket) => socket.destroy());
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
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

function stage(helper, root, hostPort, drives, argument) {
  const execution = join(root, "execution");
  const outside = join(root, "outside");
  const supervisorDirectory = join(root, "supervisor");
  for (const directory of [execution, outside, supervisorDirectory]) {
    mkdirSync(directory, { recursive: true });
  }
  const supervisor = join(supervisorDirectory, "keiko-runtime-supervisor.exe");
  copyFileSync(helper, supervisor);
  writeFileSync(join(execution, "step.js"), STEP_SOURCE);
  writeFileSync(join(outside, "secret.txt"), "outside");
  const environment = [
    ["KEIKO_STEP_HOST_PORT", String(hostPort)],
    ["KEIKO_STEP_OUTSIDE", join(outside, "secret.txt")],
    ["SystemRoot", process.env.SystemRoot ?? String.raw`C:\Windows`],
    ["TEMP", execution],
    ["TMP", execution],
  ].sort(([left], [right]) => left.localeCompare(right));
  // Step mode joins the arguments verbatim; these paths hold no quote or trailing backslash.
  const workDrive = subst(execution);
  const nodeDrive = subst(dirname(stepNode(root)));
  drives.push(workDrive, nodeDrive);
  const args = [`"${workDrive.drive}\\step.js"`, ...(argument === undefined ? [] : [argument])];
  const frames = Buffer.concat([
    launchFrame(
      randomBytes(16).toString("hex"),
      `${nodeDrive.drive}\\node.exe`,
      `${workDrive.drive}\\`,
      args,
      environment.map(([name, value]) =>
        name === "TEMP" || name === "TMP" ? [name, `${workDrive.drive}\\`] : [name, value],
      ),
    ),
    grantsFrame([
      { access: GRANT_MODIFY, path: execution },
      { access: GRANT_READ, path: dirname(stepNode(root)) },
    ]),
  ]);
  return { supervisor, frames, execution };
}

function run(supervisor, frames) {
  const child = spawn(supervisor, ["--step-supervised"], {
    stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
  });
  const received = answers(child.stdio[4]);
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  // A supervisor that ended closes its control pipe; its answers decide the proof.
  child.stdio[3].on("error", (error) => void error);
  child.stdio[3].write(frames);
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  return new Promise((resolve) =>
    child.once("close", (code) => {
      clearTimeout(deadline);
      resolve({ code, stdout, received });
    }),
  );
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

async function boundaries(helper, root, hostPort, drives) {
  const { supervisor, frames, execution } = stage(helper, join(root, "a"), hostPort, drives);
  const { code, stdout, received } = await run(supervisor, frames);
  const line = stdout.split(/\r?\n/u).find((entry) => entry.startsWith("STEP "));
  assert.notEqual(
    line,
    undefined,
    `the step reported its probes (supervisor ${String(code)}, answers ${describe(received)}): ${stdout.slice(0, 400)}`,
  );
  const answer = JSON.parse(line.slice(5));
  assert.equal(answer.write, "ok", "the step writes its execution root");
  assert.equal(existsSync(join(execution, "written.txt")), true);
  assert.notEqual(answer.outside, "ok", "a sibling folder stays unreadable");
  assert.notEqual(answer.internet, "connected", "the internet is unreachable");
  assert.notEqual(answer.loopback, "connected", "the host's loopback is unreachable");
  assert.equal(reapedExit(received), STEP_EXIT, "the step's own exit code is reported");
  return answer;
}

async function main() {
  if (process.platform !== "win32") {
    console.log("windows-step-confinement: SKIP (requires native Windows)");
    return;
  }
  const helper = helperArgument();
  const root = mkdtempSync(join(tmpdir(), "keiko-step-confinement-"));
  const host = await startHostListener();
  const drives = [];
  try {
    const hostPort = host.address().port;
    copyStepNode(root);
    const answer = await boundaries(helper, root, hostPort, drives);
    const ended = await endedByControl(helper, root, hostPort, drives);
    assert.equal(ended, 137, "KRC1 ends the step's job with 137");
    console.log(
      `windows-step-confinement: PASS (outside=${answer.outside}, internet=${answer.internet}, loopback=${answer.loopback}, cancelled=${String(ended)})`,
    );
  } finally {
    host.close();
    for (const drive of drives) drive.release();
    rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  }
}

// A step that never ends: KRC1 after the launch, then the supervisor reports 137.
async function endedByControl(helper, root, hostPort, drives) {
  const { supervisor, frames } = stage(helper, join(root, "b"), hostPort, drives, "forever");
  const child = spawn(supervisor, ["--step-supervised"], {
    stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
  });
  const received = answers(child.stdio[4]);
  // A supervisor that ended closes its control pipe; its answers decide the proof.
  child.stdio[3].on("error", (error) => void error);
  child.stdio[3].write(frames);
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  const closed = new Promise((resolve) => child.once("close", resolve));
  while (!received.some((answer) => answer.kind === RESPONSE_LAUNCHED)) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100)); // NOSONAR javascript:S9382 -- each check waits for the previous answer.
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  child.stdio[3].write(terminateFrame());
  await closed;
  clearTimeout(deadline);
  return reapedExit(received);
}

await main();
