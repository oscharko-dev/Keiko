import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { encodeAppEnvironmentPacket } from "../../../packages/keiko-contracts/src/native-runtime-wire.ts";
import { header, launchPacket, readBytes, response, streamReader } from "../protocol-harness.mjs";

const [helper, fixture] = process.argv.slice(2);
assert.equal(process.platform, "darwin");
assert.equal(typeof helper, "string");
assert.equal(typeof fixture, "string");
assert.equal(spawnSync(helper, ["--probe-app-runtime"], { env: {} }).status, 0);

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
    assert.equal(result.code, expectedKind === 2 ? 0 : 1);
    for (const offset of [4, 8]) {
      assert.throws(() => process.kill(observed.readUInt32LE(offset), 0), { code: "ESRCH" });
    }
  } finally {
    clearTimeout(timeout);
    control.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

await qualify(header("KRC1", 2, 0), 2);
await qualify(header("KRC1", 3, 0), 2);
await qualify(undefined, 2);
await qualify(header("KRC1", 99, 0), 3);
console.log(
  "macOS app runtime: PASS - private lifecycle, split control, EOF and malformed control",
);
