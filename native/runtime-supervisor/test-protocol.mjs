import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWindowsMsvcEnv, windowsToolFromPath } from "../../scripts/lib/windows-msvc.mjs";

const source = fileURLToPath(new URL("./windows/keiko_runtime_supervisor.c", import.meta.url));
const fixtureSource = fileURLToPath(new URL("./windows/qualification_fixture.c", import.meta.url));
const DEADLINE_MS = 10_000;

function header(magic, kind, payloadLength) {
  const bytes = Buffer.alloc(12);
  bytes.write(magic, 0, "ascii");
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(kind, 6);
  bytes.writeUInt32LE(payloadLength, 8);
  return bytes;
}

function launchPacket(executable, cwd) {
  const args = ["--qualified", "second-argument"];
  const environment = [
    ["KEIKO_ALPHA", "one"],
    ["KEIKO_BETA", "two"],
    // Win32/CRT plumbing in the supervised child needs SystemRoot; nothing else leaks through.
    ["SystemRoot", process.env.SystemRoot ?? String.raw`C:\Windows`],
  ];
  const strings = [
    "0123456789abcdef0123456789abcdef",
    executable,
    cwd,
    ...args,
    ...environment.flat(),
  ];
  const prefix = Buffer.alloc(4);
  prefix.writeUInt16LE(args.length, 0);
  prefix.writeUInt16LE(environment.length, 2);
  const parts = [prefix];
  for (const value of strings) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    parts.push(length, bytes, Buffer.alloc(1));
  }
  const payload = Buffer.concat(parts);
  return Buffer.concat([header("KRP1", 1, payload.length), payload]);
}

async function compile(sourcePath, output) {
  const objectPath = join(dirname(output), `${basename(output)}.obj`);
  const compileEnv = resolveWindowsMsvcEnv(process.env);
  const result = await runProcess(windowsToolFromPath(compileEnv.PATH, "cl.exe"), compileEnv, [
    "/nologo",
    "/std:c11",
    "/W4",
    "/WX",
    "/O2",
    "/DUNICODE",
    "/D_UNICODE",
    "/D_CRT_SECURE_NO_WARNINGS",
    `/Fe:${output}`,
    `/Fo:${objectPath}`,
    sourcePath,
  ]);
  assert.equal(result.code, 0, `native compile failed: ${result.stderr.toString("utf8")}`);
}

function runProcess(command, env, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stderr: Buffer.concat(stderr) }));
  });
}

/* Persistent per-stream accumulator: listeners attach once at spawn time, so bytes arriving
 * between protocol reads are buffered instead of being dropped by a flowing, listener-less
 * stream (the swap-listener pattern loses exactly the final pre-exit write on Windows). */
function streamReader(stream) {
  const reader = { buffered: [], size: 0, waiter: null, ended: false };
  stream.on("data", (chunk) => {
    reader.buffered.push(chunk);
    reader.size += chunk.length;
    reader.waiter?.();
  });
  stream.once("end", () => {
    reader.ended = true;
    reader.waiter?.();
  });
  return reader;
}

function readBytes(reader, length) {
  return new Promise((resolveBytes, reject) => {
    const check = () => {
      if (reader.size >= length) {
        reader.waiter = null;
        const bytes = Buffer.concat(reader.buffered);
        reader.buffered = [bytes.subarray(length)];
        reader.size = bytes.length - length;
        resolveBytes(bytes.subarray(0, length));
        return;
      }
      if (reader.ended) {
        reader.waiter = null;
        reject(
          new Error(
            `native helper ended before producing bounded response (buffered=${String(reader.size)})`,
          ),
        );
      }
    };
    reader.waiter = check;
    check();
  });
}

async function response(reader) {
  const responseHeader = await readBytes(reader, 12);
  assert.equal(responseHeader.subarray(0, 4).toString("ascii"), "KRS1");
  assert.equal(responseHeader.readUInt16LE(4), 1);
  const length = responseHeader.readUInt32LE(8);
  assert.ok(length <= 64);
  return {
    kind: responseHeader.readUInt16LE(6),
    payload: length === 0 ? Buffer.alloc(0) : await readBytes(reader, length),
  };
}

/* Windows children need SystemRoot for Win32/CRT plumbing; everything else stays withheld. */
function hermeticWindowsEnv() {
  return { SystemRoot: process.env.SystemRoot ?? String.raw`C:\Windows` };
}

/* Re-throw a stream failure with the child's exit code so CI logs pinpoint the stage. */
async function explained(stage, pending, exited, stderr) {
  try {
    return await pending;
  } catch (error) {
    const settled = await Promise.race([
      exited,
      new Promise((resolveLate) => setTimeout(resolveLate, 2_000, "still-running")),
    ]);
    throw new Error(
      `${stage}: ${error instanceof Error ? error.message : String(error)} ` +
        `(exit=${String(settled)} stderrBytes=${String(Buffer.concat(stderr).length)})`,
      { cause: error },
    );
  }
}

async function qualifyWindows(helper, runtime, root) {
  const child = spawn(helper, [], {
    env: hermeticWindowsEnv(),
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const responses = streamReader(child.stdio[4]);
  const output = streamReader(child.stdout);
  // KEIKO-0278: the same lifecycle guard the macOS `qualify` carries. Without the finally, a
  // supervisor that never answers leaves this function awaiting forever and DEADLINE_MS's bare
  // `child.kill()` only bounds the hang — the whole native-quality lane still waits out the job
  // timeout instead of failing with a named stage.
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  let completed = false;
  try {
    child.stdio[3].write(launchPacket(runtime, root));
    const acknowledgement = await explained(
      "launch acknowledgement",
      response(responses),
      exited,
      stderr,
    );
    assert.deepEqual(acknowledgement, { kind: 1, payload: Buffer.alloc(0) });
    const observation = await explained(
      "fixture observation",
      readBytes(output, 12),
      exited,
      stderr,
    );
    assert.equal(observation.subarray(0, 4).toString("ascii"), "KRQ1");
    const rootProcess = processHandle(observation.readUInt32LE(4));
    const descendant = processHandle(observation.readUInt32LE(8));
    await writeSplitControlFrame(child.stdio[3]);
    const reap = await explained("reap response", response(responses), exited, stderr);
    assert.equal(reap.kind, 2);
    assert.equal(reap.payload.readUInt32LE(4), 0, "Job Object must report zero active processes");
    await Promise.all([waitForExit(rootProcess), waitForExit(descendant)]);
    const exitCode = await exited;
    assert.equal(exitCode, 0);
    assert.equal(Buffer.concat(stderr).length, 0, "helper diagnostics must remain content-free");
    completed = true;
  } finally {
    clearTimeout(deadline);
    if (!completed) child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
}

/** Writes a control frame in two chunks, so the supervisor's reader has to reassemble a header it
 * received split across reads rather than one that happened to arrive whole. */
async function writeSplitControlFrame(control) {
  const frameBytes = header("KRC1", 3, 0);
  control.write(frameBytes.subarray(0, 5));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  control.write(frameBytes.subarray(5));
}

function processHandle(pid) {
  return pid;
}

async function assertControlEofFailsClosed(helper, runtime, root) {
  const child = spawn(helper, [], {
    env: hermeticWindowsEnv(),
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const responses = streamReader(child.stdio[4]);
  const output = streamReader(child.stdout);
  // KEIKO-0278: this probe had NO watchdog at all. It exists to prove the supervisor fails closed
  // on control EOF, so the failure it is most likely to meet is precisely a supervisor that hangs
  // instead — the one case that used to hang the lane rather than report it.
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  let completed = false;
  try {
    child.stdio[3].write(launchPacket(runtime, root));
    const acknowledgement = await explained(
      "eof-probe acknowledgement",
      response(responses),
      exited,
      stderr,
    );
    assert.equal(acknowledgement.kind, 1);
    const observation = await explained(
      "eof-probe observation",
      readBytes(output, 12),
      exited,
      stderr,
    );
    const pids = [observation.readUInt32LE(4), observation.readUInt32LE(8)];
    child.stdio[3].end();
    const closure = await explained("eof-probe closure", response(responses), exited, stderr);
    assert.equal(closure.kind, 3);
    await Promise.all(pids.map(waitForExit));
    // The supervisor must have fully exited before cleanup unlinks its executable (Windows lock).
    await exited;
    completed = true;
  } finally {
    clearTimeout(deadline);
    if (!completed) child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
}

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("qualified process remained active after Job Object reap proof");
}

async function assertSourceContract() {
  const text = await readFile(source, "utf8");
  assert.match(text, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(text, /CREATE_SUSPENDED/u);
  assert.match(text, /AssignProcessToJobObject\(job, process->hProcess\)/u);
  assert.match(text, /ResumeThread\(process->hThread\)/u);
  assert.match(text, /JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO/u);
  assert.match(text, /accounting\.ActiveProcesses == 0/u);
  assert.match(text, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/u);
  assert.doesNotMatch(text, /system\(|ShellExecute|cmd\.exe|powershell/iu);
}

await assertSourceContract();
if (process.platform === "win32") {
  const root = await mkdtemp(join(tmpdir(), "keiko-runtime-supervisor-"));
  try {
    const helperArgumentIndex = process.argv.indexOf("--helper");
    const suppliedHelper =
      helperArgumentIndex === -1 ? undefined : process.argv[helperArgumentIndex + 1];
    const helper = suppliedHelper ?? join(root, "keiko-runtime-supervisor.exe");
    const runtime = join(root, "qualification-fixture.exe");
    if (suppliedHelper === undefined) await compile(source, helper);
    await compile(fixtureSource, runtime);
    await qualifyWindows(helper, runtime, root);
    await assertControlEofFailsClosed(helper, runtime, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
