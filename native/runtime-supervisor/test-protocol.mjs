import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    ["SystemRoot", process.env.SystemRoot ?? "C:\\Windows"],
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
  const result = await runProcess("cl", [
    "/nologo",
    "/std:c11",
    "/W4",
    "/WX",
    "/O2",
    "/DUNICODE",
    "/D_UNICODE",
    "/D_CRT_SECURE_NO_WARNINGS",
    `/Fe:${output}`,
    `/Fo:${join(dirname(output), `${basename(output)}.obj`)}`,
    sourcePath,
  ]);
  assert.equal(result.code, 0, `native compile failed: ${result.stderr.toString("utf8")}`);
}

function runProcess(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stderr: Buffer.concat(stderr) }));
  });
}

function readBytes(stream, length) {
  return new Promise((resolveBytes, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size < length) return;
      cleanup();
      const bytes = Buffer.concat(chunks);
      if (bytes.length > length) stream.unshift(bytes.subarray(length));
      resolveBytes(bytes.subarray(0, length));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("native helper ended before producing bounded response"));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
  });
}

async function response(stream) {
  const responseHeader = await readBytes(stream, 12);
  assert.equal(responseHeader.subarray(0, 4).toString("ascii"), "KRS1");
  assert.equal(responseHeader.readUInt16LE(4), 1);
  const length = responseHeader.readUInt32LE(8);
  assert.ok(length <= 64);
  return {
    kind: responseHeader.readUInt16LE(6),
    payload: length === 0 ? Buffer.alloc(0) : await readBytes(stream, length),
  };
}

/* Windows children need SystemRoot for Win32/CRT plumbing; everything else stays withheld. */
function hermeticWindowsEnv() {
  return { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" };
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
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  child.stdio[3].write(launchPacket(runtime, root));
  const acknowledgement = await Promise.race([
    response(child.stdio[4]),
    exited.then((code) => {
      throw new Error(
        `supervisor exited before launch acknowledgement: exit=${String(code)} stderrBytes=${String(
          Buffer.concat(stderr).length,
        )}`,
      );
    }),
  ]);
  assert.deepEqual(acknowledgement, { kind: 1, payload: Buffer.alloc(0) });
  const observation = await readBytes(child.stdout, 12);
  assert.equal(observation.subarray(0, 4).toString("ascii"), "KRQ1");
  const rootProcess = processHandle(observation.readUInt32LE(4));
  const descendant = processHandle(observation.readUInt32LE(8));
  const control = header("KRC1", 3, 0);
  child.stdio[3].write(control.subarray(0, 5));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  child.stdio[3].write(control.subarray(5));
  const reap = await response(child.stdio[4]);
  assert.equal(reap.kind, 2);
  assert.equal(reap.payload.readUInt32LE(4), 0, "Job Object must report zero active processes");
  await Promise.all([waitForExit(rootProcess), waitForExit(descendant)]);
  const exitCode = await exited;
  clearTimeout(deadline);
  assert.equal(exitCode, 0);
  assert.equal(Buffer.concat(stderr).length, 0, "helper diagnostics must remain content-free");
}

function processHandle(pid) {
  return pid;
}

async function assertControlEofFailsClosed(helper, runtime, root) {
  const child = spawn(helper, [], {
    env: hermeticWindowsEnv(),
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  child.stdio[3].write(launchPacket(runtime, root));
  assert.equal((await response(child.stdio[4])).kind, 1);
  const observation = await readBytes(child.stdout, 12);
  const pids = [observation.readUInt32LE(4), observation.readUInt32LE(8)];
  child.stdio[3].end();
  assert.equal((await response(child.stdio[4])).kind, 3);
  await Promise.all(pids.map(waitForExit));
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
