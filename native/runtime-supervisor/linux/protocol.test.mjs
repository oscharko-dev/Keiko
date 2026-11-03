import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setImmediate as nextTurn, setTimeout as waitForAbsence } from "node:timers/promises";
import { prepareCSource, stripStringLiteralBodies } from "../../lib/c-source-scanner.mjs";
import {
  installControlPipeErrorGuard,
  raiseControlPipeErrorIfIncomplete,
  readBytes,
  response,
  streamReader,
} from "../protocol-harness.mjs";
import {
  encodeControlPacket,
  encodeLaunchPacket,
} from "../../../packages/keiko-server/dist/coding-runtime/nativeRuntimeProcessProtocol.js";

const execute = promisify(execFile);
const source = fileURLToPath(new URL("./keiko_runtime_supervisor.c", import.meta.url));
const raw = await readFile(source, "utf8");
const code = stripStringLiteralBodies(prepareCSource(raw));

async function compile(name, directory) {
  const input = fileURLToPath(new URL(`./${name}.c`, import.meta.url));
  const output = join(directory, name);
  await execute(
    "/usr/bin/cc",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      '-DKEIKO_PORTABLE_TARGET="linux-x64"',
      "-o",
      output,
      input,
    ],
    { timeout: 60000, maxBuffer: 2_000_000, shell: false },
  );
  return output;
}

function processExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

async function rolesOf(reader) {
  const roles = new Map();
  for (let index = 0; index < 5; ++index) {
    let line = "";
    while (!line.endsWith("\n")) {
      assert.ok(line.length < 40);
      line += (await readBytes(reader, 1)).toString("ascii");
    }
    const match = /^([IRDNL]):([1-9][0-9]{0,9})\n$/u.exec(line);
    assert.ok(match);
    assert.equal(roles.has(match[1]), false);
    roles.set(match[1], Number(match[2]));
  }
  const pids = ["I", "R", "D", "N", "L"].map((role) => roles.get(role));
  assert.equal(new Set(pids).size, 5);
  assert.ok(pids.every((pid) => Number.isInteger(pid) && pid > 0 && pid <= 2147483647));
  return pids;
}

function spawnHelper(helper) {
  const { command, args } = typeof helper === "string" ? { command: helper, args: [] } : helper;
  return spawn(command, args, { env: {}, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
}

async function startOwned(helper, observer, packet) {
  const child = spawnHelper(helper);
  const exited = processExit(child);
  const controlError = installControlPipeErrorGuard(child);
  const responses = streamReader(child.stdio[4]);
  const output = streamReader(child.stdout);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  let witness;
  let witnessExit;
  try {
    child.stdio[3].write(packet);
    assert.deepEqual(await response(responses), { kind: 1, payload: Buffer.alloc(0) });
    const pids = await rolesOf(output);
    const observedPids = [...pids];
    if (typeof helper !== "string") {
      const children = (
        await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")
      ).trim();
      assert.match(children, /^[1-9][0-9]*$/u);
      const supervisor = Number(children);
      assert.ok(supervisor <= 2147483647 && !observedPids.includes(supervisor));
      observedPids.push(supervisor);
    }
    witness = spawn(observer, observedPids.map(String), {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    witnessExit = processExit(witness);
    const observed = streamReader(witness.stdout);
    assert.equal((await readBytes(observed, 1)).toString(), "H");
    return { child, exited, witness, witnessExit, observed, responses, controlError, timeout };
  } catch (error) {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    witness?.kill("SIGKILL");
    await Promise.allSettled([exited, witnessExit]);
    throw error;
  }
}

async function stopOwned(runtime, mode) {
  if (mode === "owner-crash") runtime.child.kill("SIGKILL");
  else if (mode === "root-exit") {
    runtime.witness.stdin.write("T");
    assert.equal((await readBytes(runtime.observed, 1)).toString(), "H");
  } else if (mode === "eof") runtime.child.stdio[3].end();
  else if (mode === "partial-eof")
    runtime.child.stdio[3].end(encodeControlPacket(3).subarray(0, 5));
  else {
    const packet = encodeControlPacket(3);
    runtime.child.stdio[3].write(packet.subarray(0, 5));
    await nextTurn();
    runtime.child.stdio[3].write(packet.subarray(5));
  }
}

async function finishOwned(runtime, mode) {
  let complete = false;
  try {
    await stopOwned(runtime, mode);
    if (mode !== "owner-crash") {
      const proof = await response(runtime.responses);
      assert.equal(proof.kind, mode === "partial-eof" ? 3 : 2);
      if (proof.kind === 2) assert.equal(proof.payload.readUInt32LE(4), 0);
    }
    runtime.witness.stdin.write(mode === "owner-crash" ? "C" : "Z");
    assert.equal((await readBytes(runtime.observed, 1)).toString(), "R");
    assert.equal(await runtime.witnessExit, 0);
    const status = await runtime.exited;
    assert.equal(status, mode === "owner-crash" ? null : mode === "partial-eof" ? 1 : 0);
    complete = true;
  } finally {
    clearTimeout(runtime.timeout);
    runtime.child.kill("SIGKILL");
    runtime.witness.kill("SIGKILL");
    await Promise.allSettled([runtime.exited, runtime.witnessExit]);
    raiseControlPipeErrorIfIncomplete(mode, runtime.controlError, complete);
  }
}

async function heldInitQualification(runtime) {
  let complete = false;
  try {
    runtime.witness.stdin.write("S");
    assert.equal((await readBytes(runtime.observed, 1)).toString(), "H");
    runtime.child.stdio[3].write(encodeControlPacket(3));
    const pending = response(runtime.responses);
    const early = await Promise.race([
      pending.then((proof) => ({ proof })),
      waitForAbsence(100, undefined),
    ]);
    assert.equal(early, undefined, "no reaped proof while the exact init is confirmed stopped");
    runtime.witness.stdin.write("U");
    assert.equal((await readBytes(runtime.observed, 1)).toString(), "H");
    const proof = await pending;
    assert.equal(proof.kind, 2);
    assert.equal(proof.payload.readUInt32LE(4), 0);
    runtime.witness.stdin.write("Z");
    assert.equal((await readBytes(runtime.observed, 1)).toString(), "R");
    assert.equal(await runtime.witnessExit, 0);
    assert.equal(await runtime.exited, 0);
    complete = true;
  } finally {
    clearTimeout(runtime.timeout);
    if (!complete && runtime.witness.exitCode === null) runtime.witness.stdin.end("X");
    await runtime.witnessExit;
    runtime.child.kill("SIGKILL");
    await runtime.exited;
    raiseControlPipeErrorIfIncomplete("held init", runtime.controlError, complete);
  }
}

async function independentGenerations(helper, observer, task) {
  const first = await startOwned(helper, observer, task);
  let second;
  try {
    second = await startOwned(helper, observer, task);
    await finishOwned(first, "split-stop");
    second.witness.stdin.write("P");
    assert.equal((await readBytes(second.observed, 1)).toString(), "H");
    await finishOwned(second, "split-stop");
  } finally {
    for (const runtime of [first, second].filter(Boolean)) {
      clearTimeout(runtime.timeout);
      runtime.child.kill("SIGKILL");
      runtime.witness.kill("SIGKILL");
      await Promise.allSettled([runtime.exited, runtime.witnessExit]);
    }
  }
  console.log("linux-generation: PASS independent sibling generations");
}

async function stoppedOwnerDeathQualification(helper, observer, task, commands) {
  const runtime = await startOwned(helper, observer, task);
  let released = false;
  try {
    for (const command of commands) {
      runtime.witness.stdin.write(command);
      assert.equal((await readBytes(runtime.observed, 1)).toString(), "H");
    }
    runtime.child.kill("SIGKILL");
    runtime.witness.stdin.write("C");
    released = true;
    assert.equal(
      await runtime.witnessExit,
      0,
      "every held identity must retire without resuming stopped owners",
    );
    assert.equal((await readBytes(runtime.observed, 1)).toString(), "R");
    assert.equal(await runtime.exited, null);
  } finally {
    clearTimeout(runtime.timeout);
    if (!released) runtime.witness.stdin.end("X");
    await runtime.witnessExit;
    runtime.child.kill("SIGKILL");
    await runtime.exited;
  }
}

async function stoppedSupervisorStopQualification(helper, observer, task, eof) {
  const runtime = await startOwned(helper, observer, task);
  let released = false;
  try {
    runtime.witness.stdin.write("A");
    assert.equal((await readBytes(runtime.observed, 1)).toString(), "H");
    runtime.child.stdio[3].end(eof ? undefined : encodeControlPacket(3));
    const settled = await Promise.race([
      response(runtime.responses).then((proof) => ({ proof })),
      waitForAbsence(8000).then(() => ({ expired: true })),
    ]);
    assert.equal(
      settled.expired,
      undefined,
      "original five-second control plus existing three-second failure cleanup must settle",
    );
    assert.equal(settled.proof.kind, 3, "forced stop never supplies a zero-live protocol proof");
    assert.equal(await runtime.exited, 1);
    runtime.witness.stdin.write("C");
    released = true;
    assert.equal(await runtime.witnessExit, 0);
    assert.equal((await readBytes(runtime.observed, 1)).toString(), "R");
  } finally {
    clearTimeout(runtime.timeout);
    if (!released) runtime.witness.stdin.end("X");
    await runtime.witnessExit;
    runtime.child.kill("SIGKILL");
    await runtime.exited;
  }
}

async function actualKernelQualification(directory, helper, heldOnly) {
  const fixture = await compile("qualification_fixture", directory);
  const observer = await compile("qualification_observer", directory);
  const coordinator = await compile("coordinator_encoder_fixture", directory);
  const task = encodeLaunchPacket(
    {
      recoveryHandle: "0123456789abcdef0123456789abcdef",
      args: ["--qualified", "second-argument"],
      env: { KEIKO_ALPHA: "one" },
    },
    { executable: fixture, cwd: directory },
  );
  if (heldOnly) {
    await heldInitQualification(await startOwned(helper, observer, task));
    console.log("linux-generation: PASS held-init control only");
    return;
  }
  for (const mode of ["split-stop", "eof", "partial-eof", "owner-crash", "root-exit"]) {
    await finishOwned(await startOwned(helper, observer, task), mode);
    console.log(`linux-generation: PASS ${mode} — five held kernel identities retired`);
  }
  await heldInitQualification(await startOwned(helper, observer, task));
  console.log(
    "linux-generation: PASS held init refuses early proof and verifies immediate retirement",
  );
  const encoded = await execute(
    coordinator,
    [fixture, directory, directory, "0123456789abcdef0123456789abcdef"],
    { timeout: 5000, maxBuffer: 128 * 1024, encoding: "buffer", shell: false },
  );
  await finishOwned(await startOwned(helper, observer, encoded.stdout), "split-stop");
  console.log("linux-generation: PASS actual POSIX coordinator encoder");
  await independentGenerations(helper, observer, task);
  await stoppedOwnerDeathQualification(helper, observer, task, ["S"]);
  console.log("linux-generation: PASS owner death retires a stopped init without resuming it");
  if (typeof helper !== "string") {
    for (const commands of [["A"], ["S", "A"]])
      await stoppedOwnerDeathQualification(helper, observer, task, commands);
    console.log(
      "linux-generation: PASS outer owner death retires stopped supervisor/init compositions",
    );
    for (const eof of [false, true])
      await stoppedSupervisorStopQualification(helper, observer, task, eof);
    console.log("linux-generation: PASS stopped supervisor STOP/EOF settle as bounded refusals");
  }
}

async function refusesPacket(helper, packet) {
  const child = spawnHelper(helper);
  const exited = processExit(child);
  const controlError = installControlPipeErrorGuard(child);
  const reader = streamReader(child.stdio[4]);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
  let complete = false;
  try {
    child.stdio[3].end(packet);
    const refusal = await response(reader);
    assert.equal(refusal.kind, 3);
    assert.equal(refusal.payload.readUInt16LE(0), 1);
    assert.equal(await exited, 1);
    complete = true;
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await exited;
    raiseControlPipeErrorIfIncomplete("protocol refusal", controlError, complete);
  }
}

async function protocolRefusals(helper, directory) {
  const packet = encodeLaunchPacket(
    { recoveryHandle: "0123456789abcdef0123456789abcdef", args: [], env: {} },
    { executable: "/unexecuted-qualified-target", cwd: directory },
  );
  const magic = Buffer.from(packet);
  magic.write("BAD1");
  const oversized = Buffer.from(packet);
  oversized.writeUInt32LE(0xffffffff, 8);
  const arguments_ = Buffer.from(packet);
  arguments_.writeUInt16LE(65, 12);
  const handle = Buffer.from(packet);
  handle[handle.indexOf(Buffer.from("0123456789abcdef0123456789abcdef"))] = 88;
  for (const input of [
    Buffer.alloc(0),
    packet.subarray(0, 7),
    magic,
    oversized,
    arguments_,
    handle,
  ])
    await refusesPacket(helper, input);
  console.log("linux-generation: PASS six actual decoder refusals before execution");
}

async function deadlineQualification(directory) {
  const fixture = await compile("deadline_fixture", directory);
  for (const name of [
    "normal-wait",
    "late-wait",
    "normal-poll",
    "late-poll",
    "normal-receive",
    "late-receive",
    "normal-ack",
    "late-ack",
    "late-before-ack",
    "normal-report",
    "late-report-probe",
    "late-report-send",
    "report-probe-refusal",
  ])
    await execute(fixture, [name], { timeout: 5000, maxBuffer: 4096, shell: false });
  console.log(
    "linux-generation: PASS thirteen causal scheduling, report and consumed-identity controls",
  );
}

function qualificationOptions(arguments_) {
  if (arguments_[0] === "--outer-owner") {
    assert.equal(arguments_.length, 4);
    return {
      scope: "kernel",
      helper: { command: arguments_[1], args: ["--own-runtime", arguments_[2], arguments_[3]] },
    };
  }
  if (arguments_.length === 0) return { scope: "source" };
  if (arguments_.length === 1) {
    const modes = new Map([
      ["--compile", "kernel"],
      ["--protocol-only", "protocol"],
    ]);
    const scope = modes.get(arguments_[0]);
    assert.ok(scope, "Supply --compile, --protocol-only or --helper <exact staged executable>");
    return { scope };
  }
  assert.equal(arguments_[0], "--helper");
  assert.ok(arguments_[1]);
  if (arguments_.length === 2) return { scope: "kernel", helper: arguments_[1] };
  assert.equal(arguments_.length, 3);
  assert.equal(arguments_[2], "--held-init-only");
  return { scope: "held", helper: arguments_[1] };
}

async function qualifyRequested(options) {
  if (options.scope === "source") {
    console.log("linux-generation: PASS source contract only; no kernel or shipping acceptance");
    return;
  }
  assert.equal(process.platform, "linux", "Linux kernel qualification requires Linux");
  const directory = await mkdtemp(join(tmpdir(), "keiko-native-generation-"));
  try {
    const helper = options.helper ?? (await compile("keiko_runtime_supervisor", directory));
    await protocolRefusals(helper, directory);
    await deadlineQualification(directory);
    if (options.scope === "protocol") {
      console.log("linux-generation: PASS decoder only; no kernel or shipping acceptance");
      return;
    }
    await actualKernelQualification(directory, helper, options.scope === "held");
    console.log(
      `linux-generation: PASS kernel mechanics on ${process.platform}/${process.arch}; updater integration remains unqualified`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await test("Linux generation source, protocol and requested kernel boundaries", async () => {
  // Refuse an invalid source contract before compiling or entering native qualification.
  for (const token of [
    "SYS_clone3",
    "CLONE_NEWUSER",
    "CLONE_NEWPID",
    "CLONE_PIDFD",
    "SYS_pidfd_open",
    "SYS_pidfd_send_signal",
    "SO_PASSCRED",
    "SCM_CREDENTIALS",
    "PR_SET_NO_NEW_PRIVS",
    "PR_SET_DUMPABLE",
    "PR_GET_DUMPABLE",
    "SYS_capset",
    "SYS_close_range",
    "WNOHANG",
  ])
    assert.match(code, new RegExp(`\\b${token}\\b`, "u"));
  assert.doesNotMatch(code, /\b(?:system|popen|execlp|execvp)\s*\(/u);
  const [result] = await Promise.allSettled([
    qualifyRequested(qualificationOptions(process.argv.slice(2))),
  ]);
  assert.strictEqual(
    result.status,
    "fulfilled",
    result.status === "rejected" ? result.reason : undefined,
  );
});
