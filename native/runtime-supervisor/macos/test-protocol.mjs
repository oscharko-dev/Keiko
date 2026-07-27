import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEADLINE_MS = 15_000;
const source = new URL("./keiko_runtime_supervisor.c", import.meta.url);
const fixtureSource = new URL("./qualification_fixture.c", import.meta.url);

function frame(magic, kind, payloadLength) {
  const value = Buffer.alloc(12);
  value.write(magic, 0, "ascii");
  value.writeUInt16LE(1, 4);
  value.writeUInt16LE(kind, 6);
  value.writeUInt32LE(payloadLength, 8);
  return value;
}

function launchPacket(executable, cwd) {
  const strings = [
    "0123456789abcdef0123456789abcdef",
    executable,
    cwd,
    "--qualified",
    "second-argument",
    "KEIKO_ALPHA",
    "one",
  ];
  const prefix = Buffer.alloc(4);
  prefix.writeUInt16LE(2, 0);
  prefix.writeUInt16LE(1, 2);
  const values = [prefix];
  for (const value of strings) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    values.push(length, bytes, Buffer.alloc(1));
  }
  const payload = Buffer.concat(values);
  return Buffer.concat([frame("KRP1", 1, payload.length), payload]);
}

function streamReader(stream) {
  const reader = { chunks: [], size: 0, wake: undefined, ended: false };
  stream.on("data", (chunk) => {
    reader.chunks.push(chunk);
    reader.size += chunk.length;
    reader.wake?.();
  });
  stream.once("end", () => {
    reader.ended = true;
    reader.wake?.();
  });
  return reader;
}

function readBytes(reader, length) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (reader.size >= length) {
        const bytes = Buffer.concat(reader.chunks);
        reader.chunks = [bytes.subarray(length)];
        reader.size = bytes.length - length;
        reader.wake = undefined;
        resolve(bytes.subarray(0, length));
      } else if (reader.ended) {
        reject(new Error("macOS supervisor response ended early"));
      }
    };
    reader.wake = check;
    check();
  });
}

async function response(reader) {
  const header = await readBytes(reader, 12);
  assert.equal(header.subarray(0, 4).toString("ascii"), "KRS1");
  assert.equal(header.readUInt16LE(4), 1);
  const length = header.readUInt32LE(8);
  assert.ok(length <= 64);
  return {
    kind: header.readUInt16LE(6),
    payload: length === 0 ? Buffer.alloc(0) : await readBytes(reader, length),
  };
}

async function compileFixture(path, architecture) {
  const child = spawn(
    "/usr/bin/xcrun",
    [
      "clang",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-arch",
      architecture,
      "-o",
      path,
      fixtureSource.pathname,
    ],
    { env: {}, stdio: ["ignore", "ignore", "pipe"] },
  );
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(status, 0, Buffer.concat(errors).toString("utf8"));
}

async function waitGone(pid) {
  for (let attempt = 0; attempt < 200; ++attempt) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Endpoint Security did not prove descendant exit");
}

async function qualify(helper, fixture, root) {
  const child = spawn(helper, [], {
    env: {},
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const responses = streamReader(child.stdio[4]);
  const output = streamReader(child.stdout);
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  let completed = false;
  try {
    child.stdio[3].write(launchPacket(fixture, root));
    assert.deepEqual(await response(responses), { kind: 1, payload: Buffer.alloc(0) });
    const observation = await readBytes(output, 12);
    assert.equal(observation.subarray(0, 4).toString("ascii"), "KRQ1");
    const pids = [observation.readUInt32LE(4), observation.readUInt32LE(8)];
    child.stdio[3].write(frame("KRC1", 3, 0));
    const proof = await response(responses);
    assert.equal(proof.kind, 2);
    assert.equal(proof.payload.readUInt32LE(4), 0);
    await Promise.all(pids.map(waitGone));
    assert.equal(await exited, 0);
    assert.equal(Buffer.concat(errors).length, 0);
    completed = true;
  } finally {
    clearTimeout(deadline);
    if (!completed) child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
}

const sourceText = await readFile(source, "utf8");
assert.match(sourceText, /KEIKO_MONITOR_ARM/u);
assert.match(sourceText, /KEIKO_MONITOR_STOP/u);
assert.match(sourceText, /KEIKO_MONITOR_ZERO_LIVE/u);
assert.doesNotMatch(sourceText, /setsid|setpgid|killpg|\/bin\/sh|system\(/u);

if (process.platform === "darwin") {
  const helperIndex = process.argv.indexOf("--helper");
  const helper = helperIndex === -1 ? undefined : process.argv[helperIndex + 1];
  assert.ok(helper, "pass --helper <exact staged supervisor>");
  const root = await mkdtemp(join(tmpdir(), "keiko-macos-runtime-qualification-"));
  try {
    const fixture = join(root, "qualification-fixture");
    await compileFixture(fixture, process.arch === "arm64" ? "arm64" : "x86_64");
    await qualify(helper, fixture, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
