import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { readFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  encodeControlPacket,
  encodeLaunchPacket,
} from "../../../packages/keiko-server/dist/coding-runtime/nativeRuntimeProcessProtocol.js";
import { readBytes, response, streamReader } from "../protocol-harness.mjs";

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "keiko-outer-source-"));
async function compile(name, relative) {
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
      ...(name === "launcher" ? ["-D_GNU_SOURCE"] : []),
      '-DKEIKO_PORTABLE_TARGET="linux-x64"',
      fileURLToPath(new URL(relative, import.meta.url)),
      "-o",
      target,
    ],
    { timeout: 60000, shell: false },
  );
  return target;
}
async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function run(launcher, helper, hash, root, expected, gate = false) {
  const child = spawn(launcher, ["--own-runtime", helper, hash], {
    env: {},
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", ...(gate ? ["pipe"] : [])],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const pipeErrors = [];
  child.stdio[3].on("error", (error) => pipeErrors.push(error));
  const reader = streamReader(child.stdio[4]),
    output = streamReader(child.stdout);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  let complete = false;
  try {
    child.stdio[3].write(
      encodeLaunchPacket(
        {
          recoveryHandle: "0123456789abcdef0123456789abcdef",
          args: gate ? ["--gate-root"] : ["30"],
          env: {},
        },
        { executable: root, cwd: directory },
      ),
    );
    const first = await response(reader);
    if (expected === 0) {
      assert.deepEqual(first, { kind: 1, payload: Buffer.alloc(0) });
      if (gate) {
        child.stdio[5].end("G");
        assert.equal((await readBytes(output, 1)).toString(), "G");
      }
      child.stdio[3].end(encodeControlPacket(3));
      const retired = await response(reader);
      assert.equal(retired.kind, 2);
      assert.equal(retired.payload.readUInt32LE(4), 0);
    } else {
      assert.equal(first.kind, 3);
      assert.equal(first.payload.readUInt16LE(0), expected);
    }
    assert.equal(await exited, expected === 0 ? 0 : 1);
    assert.deepEqual(pipeErrors, []);
    complete = true;
  } finally {
    clearTimeout(timeout);
    if (!complete) child.kill("SIGKILL");
    await exited;
  }
}
try {
  const launcher = await compile("launcher", "../../portable-launcher/keiko-portable-launcher.c");
  const helper = await compile("supervisor", "./keiko_runtime_supervisor.c");
  const fixture = await compile("fixture", "./owner_receiver_fixture.c");
  const hash = await digest(helper),
    fixtureHash = await digest(fixture);
  const alias = join(directory, "alias");
  await symlink(helper, alias);
  await test("outer owner rejects a different helper digest", async () =>
    run(launcher, helper, "0".repeat(64), "/bin/sleep", 3));
  await test("outer owner rejects a helper alias", async () =>
    run(launcher, alias, hash, "/bin/sleep", 3));
  await test("outer owner preserves actual native unavailability", async () =>
    run(launcher, fixture, fixtureHash, "/bin/sleep", 6));
  await test("outer owner starts and retires the verified helper", async () =>
    run(launcher, helper, hash, "/bin/sleep", 0));
  await test("outer owner preserves the actual gate and excludes the private report channel", async () =>
    run(launcher, helper, hash, fixture, 0, true));
} finally {
  await rm(directory, { recursive: true, force: true });
}
