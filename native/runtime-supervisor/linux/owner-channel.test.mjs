import { strict as assert } from "node:assert";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  encodeControlPacket,
  encodeLaunchPacket,
} from "../../../packages/keiko-server/dist/coding-runtime/nativeRuntimeProcessProtocol.js";
import { readBytes, streamReader } from "../protocol-harness.mjs";

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "keiko-owner-channel-"));
async function compile(name) {
  const target = join(directory, name);
  await execute(
    "/usr/bin/cc",
    [
      "-std=c17",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-Werror",
      "-O2",
      '-DKEIKO_PORTABLE_TARGET="linux-x64"',
      fileURLToPath(new URL(`./${name}.c`, import.meta.url)),
      "-o",
      target,
    ],
    { timeout: 60000, shell: false },
  );
  return target;
}

async function qualify(fixture, helper, mode) {
  const child = spawn(fixture, [helper, mode], {
    env: {},
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = streamReader(child.stdout);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  // A failed-before helper may close this pipe after its ordinary protocol refusal.
  const pipeErrors = [];
  child.stdio[3].on("error", (error) => pipeErrors.push(error));
  let complete = false;
  try {
    child.stdio[3].write(
      encodeLaunchPacket(
        { recoveryHandle: "0123456789abcdef0123456789abcdef", args: ["30"], env: {} },
        { executable: "/bin/sleep", cwd: directory },
      ),
    );
    if (mode === "valid") {
      assert.equal((await readBytes(output, 5)).toString(), "HELD\n");
      child.stdio[3].end(encodeControlPacket(2));
      assert.equal((await readBytes(output, 8)).toString(), "RETIRED\n");
    } else assert.equal((await readBytes(output, 8)).toString(), "REFUSED\n");
    assert.equal(await exited, 0);
    assert.deepEqual(pipeErrors, []);
    complete = true;
  } finally {
    clearTimeout(timeout);
    if (!complete) child.kill("SIGKILL");
    await exited;
  }
}

try {
  const helper = await compile("keiko_runtime_supervisor");
  const fixture = await compile("owner_channel_fixture");
  const receiver = await compile("owner_receiver_fixture");
  for (const mode of [
    "valid",
    "magic",
    "version",
    "kind",
    "length",
    "zero-pid",
    "owner-pid",
    "no-rights",
    "two-rights",
    "truncated-rights",
    "short",
    "credentials",
    "eof",
    "retired",
    "late",
    "empty-pipe",
    "mismatched-pid",
  ]) {
    await test(`root identity receiver: ${mode}`, async () => {
      const result = await execute(receiver, [mode], {
        timeout: 5000,
        maxBuffer: 4096,
        shell: false,
      });
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    });
  }
  await test("parent-death guard refuses a parent already terminal before arming", async () => {
    const result = await execute(receiver, ["--parent-race"], {
      timeout: 5000,
      maxBuffer: 4096,
      shell: false,
    });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
  await test("root reference requires a coherent coordinate view and authentic procfs", async () => {
    const result = await execute(receiver, ["--proc-coordinates"], {
      timeout: 5000,
      maxBuffer: 4096,
      shell: false,
    });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
  for (const mode of ["missing", "pipe", "foreign-peer", "valid"]) {
    await test(`held root owner channel: ${mode}`, async () => qualify(fixture, helper, mode));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
