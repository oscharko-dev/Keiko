import { performance } from "node:perf_hooks";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativeUiStartDeadline } from "../../../packages/keiko-cli/dist/native-ui-runtime.js";
import { writeExclusivePidFile } from "../../../packages/keiko-cli/dist/state-paths.js";
import {
  appResponse,
  commitPacket,
  compileOwnerFixture,
  appLaunchPacket,
} from "./app-owner-harness.mjs";
import { readBytes, streamReader } from "../protocol-harness.mjs";

const directory = await mkdtemp(join(tmpdir(), "keiko-app-deadline-"));

async function qualify(launcher, helper, root, hash, mode) {
  const state = join(directory, mode);
  await mkdir(state, { mode: 0o700 });
  const launchId = randomBytes(16).toString("hex"),
    started = performance.now();
  const child = spawn(launcher, ["--own-app-runtime", helper, hash], {
    env: {
      KEIKO_UI_LAUNCH_ID: launchId,
      KEIKO_STATE_DIR: state,
      KEIKO_START_TIMEOUT_SECS: "20",
      KEIKO_UI_START_DEADLINE_MS: nativeUiStartDeadline(started + 1000),
    },
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  child.stdio[3].on("error", () => {
    /* A late sender observes the already-closed bounded owner. */
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  const reader = streamReader(child.stdio[4]),
    output = streamReader(child.stdout);
  const packet = appLaunchPacket(
    {
      recoveryHandle: launchId,
      args: ["persistent"],
      env: { KEIKO_UI_LAUNCH_ID: launchId, KEIKO_STATE_DIR: state, KEIKO_START_TIMEOUT_SECS: "1" },
    },
    { executable: root, cwd: directory },
  );
  const guard = setTimeout(() => child.kill("SIGKILL"), 5000);
  let late;
  try {
    if (mode === "healthy") await healthy(child, reader, output, packet, state, launchId);
    else {
      child.stdio[3].write(packet.subarray(0, 2));
      if (mode === "delayed-complete")
        late = setTimeout(() => child.stdio[3].write(packet.subarray(2)), 1200);
      await refused(reader, started);
    }
    assert.equal(await exited, mode === "healthy" ? 0 : 1);
    const lines = (
      await readFile(join(state, ".keiko", "ui-runtime", `${launchId}.receipt`), "utf8")
    ).split("\n");
    assert.equal(lines[4], mode === "healthy" ? "reaped" : "not-started");
    if (mode !== "healthy") assert.equal(lines[1], "0");
  } finally {
    clearTimeout(late);
    child.stdio[3].end();
    await exited;
    clearTimeout(guard);
  }
}

async function refused(reader, started) {
  let observer;
  try {
    const response = appResponse(reader).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const result = await Promise.race([
      response,
      new Promise((resolve) => {
        observer = setTimeout(
          () => resolve(undefined),
          Math.max(1, 1500 - (performance.now() - started)),
        );
      }),
    ]);
    assert(
      result !== undefined,
      "native owner remained blocked beyond its original one-second grant",
    );
    assert.equal(result.value?.kind, 3, "native owner admitted a root after the original deadline");
  } finally {
    clearTimeout(observer);
  }
}

async function healthy(child, reader, output, packet, state, launchId) {
  child.stdio[3].write(packet);
  const root = await appResponse(reader);
  assert.equal(root.kind, 4);
  assert.equal((await readBytes(output, 6)).toString(), "SCOPE\n");
  writeExclusivePidFile(join(state, "ui.pid"), root.payload.readUInt32LE(0), launchId, true, true);
  child.stdio[3].write(commitPacket(launchId));
  assert.deepEqual(await appResponse(reader), { kind: 5, payload: Buffer.from(launchId) });
  child.stdin.write("X");
}

try {
  const launcher = await compileOwnerFixture(
    directory,
    "launcher",
    "../../portable-launcher/keiko-portable-launcher.c",
  );
  const helper = await compileOwnerFixture(directory, "supervisor", "./keiko_runtime_supervisor.c");
  const root = await compileOwnerFixture(directory, "root", "./process_scope_root_fixture.c");
  const hash = createHash("sha256")
    .update(await readFile(helper))
    .digest("hex");
  for (const mode of ["healthy", "stalled", "delayed-complete"])
    await test(`original native app start deadline: ${mode}`, { timeout: 10000 }, async () =>
      qualify(launcher, helper, root, hash, mode),
    );
} finally {
  await rm(directory, { recursive: true, force: true });
}
