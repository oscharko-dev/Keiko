import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { encodeAppEnvironmentPacket } from "../../../packages/keiko-contracts/src/native-runtime-wire.ts";
import {
  header,
  launchPacket,
  readBytes,
  response,
  streamReader,
  waitForExit,
} from "../protocol-harness.mjs";

const [helper, fixture] = process.argv.slice(2);

function signalIfAlive(pid, signal) {
  if (pid === undefined) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function qualify(controlBytes, expectedKind) {
  const child = spawn(helper, ["--app-runtime"], {
    env: {},
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  const control = child.stdio[3];
  const results = streamReader(child.stdio[4]);
  const output = streamReader(child.stdout);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  control.on("error", () => {
    /* Response and exit assertions own failure. */
  });
  try {
    control.write(
      Buffer.concat([
        launchPacket(fixture, "/tmp"),
        encodeAppEnvironmentPacket({ KEIKO_PRIVATE_TEST: "private-value" }),
      ]),
    );
    assert.deepEqual(await response(results), { kind: 1, payload: Buffer.alloc(0) });
    const observed = await readBytes(output, 12);
    assert.equal(observed.subarray(0, 4).toString("ascii"), "KRQ1");
    if (controlBytes === undefined) control.end();
    else {
      control.write(controlBytes.subarray(0, 5));
      await new Promise((resolve) => setTimeout(resolve, 20));
      control.write(controlBytes.subarray(5));
    }
    const proof = await response(results);
    assert.equal(proof.kind, expectedKind);
    if (expectedKind === 2) assert.equal(proof.payload.readUInt32LE(4), 0);
    const result = await exit;
    for (const offset of [4, 8]) {
      assert.throws(() => process.kill(observed.readUInt32LE(offset), 0), { code: "ESRCH" });
    }
    return result;
  } finally {
    clearTimeout(timeout);
    control.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

test("macOS private app lifecycle, split control, EOF and malformed control", async () => {
  assert.equal(process.platform, "darwin");
  assert.equal(typeof helper, "string");
  assert.equal(typeof fixture, "string");
  assert.equal(spawnSync(helper, ["--probe-app-runtime"], { env: {} }).status, 0);
  assert.equal((await qualify(header("KRC1", 2, 0), 2)).code, 0);
  assert.equal((await qualify(header("KRC1", 3, 0), 2)).code, 0);
  assert.equal((await qualify(undefined, 2)).code, 0);
  assert.equal((await qualify(header("KRC1", 99, 0), 3)).code, 1);
});

test("macOS app cleanup retains an unobserved detached child and preserves a foreign orphan", async () => {
  const child = spawn(helper, ["--app-runtime"], {
    env: {},
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const exit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const output = streamReader(child.stdout);
  const results = streamReader(child.stdio[4]);
  child.stdio[3].on("error", () => {
    /* Response and exit assertions own failure. */
  });
  let supervisor, owned, foreign, foreignPid;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    child.stdio[3].write(
      Buffer.concat([
        launchPacket(fixture, "/tmp", [], ["--unobserved-orphan", "second-argument"]),
        encodeAppEnvironmentPacket({}),
      ]),
    );
    const observed = await readBytes(output, 16);
    owned = observed.readUInt32LE(8);
    supervisor = observed.readUInt32LE(12);
    foreign = spawn(fixture, ["--foreign-orphan"], { stdio: ["pipe", "pipe", "ignore"] });
    const unrelated = await readBytes(streamReader(foreign.stdout), 16);
    foreignPid = unrelated.readUInt32LE(8);
    process.kill(supervisor, "SIGCONT");
    assert.equal((await response(results)).kind, 1);
    child.stdio[3].write(header("KRC1", 2, 0));
    const proof = await response(results);
    assert.equal(proof.kind, 2);
    assert.equal(proof.payload.readUInt32LE(4), 0);
    assert.equal(await exit, 0);
    assert.throws(() => process.kill(owned, 0), { code: "ESRCH" });
    assert.equal(process.kill(foreignPid, 0), true);
    assert.equal(process.kill(foreign.pid, 0), true);
  } finally {
    clearTimeout(timeout);
    for (const [pid, signal] of [
      [supervisor, "SIGCONT"],
      [owned, "SIGTERM"],
    ]) {
      signalIfAlive(pid, signal);
    }
    foreign?.stdin.end();
    if (foreignPid !== undefined) await waitForExit(foreignPid);
    foreign?.kill("SIGTERM");
    child.stdio[3].end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
