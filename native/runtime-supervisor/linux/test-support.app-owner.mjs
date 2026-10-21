import {
  encodeAppEnvironmentPacket,
  encodeLaunchPacket,
} from "../../../packages/keiko-contracts/dist/native-runtime-wire.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { readBytes } from "../protocol-harness.mjs";

// App receipts are deliberately decoded separately from the generic KRS supervisor codec.
export async function appResponse(reader) {
  const header = await readBytes(reader, 12);
  assert.equal(header.subarray(0, 4).toString(), "KRS1");
  assert.equal(header.readUInt16LE(4), 1);
  const length = header.readUInt32LE(8);
  assert(length <= 64);
  return { kind: header.readUInt16LE(6), payload: await readBytes(reader, length) };
}

export { nativeUiCommitPacket as commitPacket } from "../../../packages/keiko-cli/dist/native-ui-runtime.js";

export async function compileOwnerFixture(directory, name, source) {
  const target = join(directory, name);
  const darwin = process.platform === "darwin";
  const platformTarget = darwin ? "macos-" + process.arch : "linux-x64";
  const definitions = darwin ? ["-Wno-deprecated-declarations"] : [];
  if (!darwin && name === "launcher") definitions.push("-D_GNU_SOURCE");
  const selectedSource =
    darwin && source === "./keiko_runtime_supervisor.c"
      ? "../macos/keiko_runtime_supervisor.c"
      : source;
  await promisify(execFile)(
    "/usr/bin/cc",
    [
      "-std=c17",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-Werror",
      "-O2",
      ...definitions,
      '-DKEIKO_PORTABLE_TARGET="' + platformTarget + '"',
      fileURLToPath(new URL(selectedSource, import.meta.url)),
      "-o",
      target,
    ],
    { timeout: 60000, shell: false },
  );
  return target;
}

export function appLaunchPacket(request, paths, environment = {}) {
  return Buffer.concat([
    encodeLaunchPacket(request, paths),
    encodeAppEnvironmentPacket(environment),
  ]);
}
