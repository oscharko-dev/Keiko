// Exercises the installed SCM image through the native control protocol on Windows.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  launchPacket,
  response,
  streamReader,
} from "../../native/runtime-supervisor/protocol-harness.mjs";
import { resolveWindowsMsvcEnv, windowsToolFromPath } from "../lib/windows-msvc.mjs";

const [operation, helper] = process.argv.slice(2);
const root = dirname(helper);
const probe = join(root, "gateway-service-probe.exe");

if (operation === "build") {
  const env = resolveWindowsMsvcEnv();
  const built = spawnSync(
    windowsToolFromPath(env.PATH, "cl.exe"),
    [
      "/nologo",
      "/std:c11",
      "/MT",
      "/W4",
      "/WX",
      "/analyze",
      `/Fe:${probe}`,
      `/Fo:${root}\\`,
      resolve("native/runtime-supervisor/windows/gateway_service.test.c"),
      "/link",
      "/DEPENDENTLOADFLAG:0x800",
    ],
    { env, stdio: "inherit" },
  );
  process.exitCode = built.status ?? 1;
} else if (operation === "installed") {
  await qualify(false);
  await qualify(true);
} else if (operation === "unavailable") {
  await qualify(false, true);
} else throw new TypeError("expected build, installed or unavailable");

// Known KGB1 IPv4 policy vector from the sandbox producer. An invalid digest must
// refuse the very same request and never produce a child instruction.
function frame(valid) {
  const data = Buffer.alloc(540);
  data.write("KGB1");
  data.writeUInt16LE(1, 4);
  data.writeUInt16LE(1, 6);
  data.writeUInt32LE(528, 8);
  data.write("0123456789abcdef0123456789abcdef", 44);
  data.writeUInt16LE(2, 84);
  data.writeUInt16LE(1, 86);
  data.writeUInt16LE(8, 88);
  for (const [i, byte] of ["a", "b", "c", "d"].entries()) data.write(byte.repeat(64), 92 + i * 64);
  data.write(
    valid ? "8ab11d0c0a06f7abdf54b2c8d8c7ecb2353d79931991aaa1a19683876de4f4ad" : "0".repeat(64),
    348,
  );
  data.write("run-3423", 412);
  return data;
}

async function qualify(valid, unavailable = false) {
  const child = spawn(helper, ["--gateway-supervised"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
    timeout: 12000,
  });
  const exited = once(child, "close");
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  const responses = streamReader(child.stdio[4]);
  try {
    child.stdio[3].write(launchPacket(probe, root, [["SystemRoot", process.env.SystemRoot]], []));
    if (!unavailable) {
      const observer = spawnSync(probe, ["--observe"], { encoding: "utf8", timeout: 3000 });
      assert.equal(observer.status, 0, "no suspended root observed in the named job");
      await delay(150);
      assert.equal(output.length, 0, "child ran before policy submission");
      child.stdio[3].write(frame(valid));
    }
    assert.equal((await response(responses)).kind, valid ? 1 : 3);
    if (valid) {
      const reap = await response(responses);
      assert.equal(reap.kind, 2);
      assert.equal(reap.payload.readUInt32LE(0), 0);
      assert.equal(reap.payload.readUInt32LE(4), 0);
    }
    assert.equal((await exited)[0], valid ? 0 : 1);
    assert.equal(Buffer.concat(output).toString().trim(), valid ? "child-entered" : "");
    console.log(
      unavailable
        ? "absent SCM service: no child execution"
        : valid
          ? "verified WFP admission: observed job root, then child entry and reap"
          : "rejected WFP admission: observed job root, no child execution",
    );
  } finally {
    child.kill();
  }
}
