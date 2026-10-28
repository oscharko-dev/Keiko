/* The actual launching CLI must exit while its native app generation remains owned. */
import { runLifecycleCli } from "../../../packages/keiko-cli/dist/lifecycle.js";
import {
  readPidRecord,
  readUiLifecycleTracking,
} from "../../../packages/keiko-cli/dist/state-paths.js";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";

const [command, launcher, helper, hash, home, state, port] = process.argv.slice(2);
const env = {
  ...process.env,
  KEIKO_STATE_DIR: state,
  KEIKO_CLI_BIN_PATH: new URL("../../../dist/cli/index.js", import.meta.url).pathname,
  KEIKO_UI_STATIC_ROOT: new URL("../../../dist/ui/static", import.meta.url).pathname,
};
const messages = [];
const runtime = {
  launcherPath: launcher,
  supervisorPath: helper,
  supervisorSha256: hash,
  nodePath: process.execPath,
  cliBinPath: env.KEIKO_CLI_BIN_PATH,
  staticRoot: env.KEIKO_UI_STATIC_ROOT,
};

async function invoke(selected, overrides = {}) {
  return runLifecycleCli(
    selected,
    [
      "--state-dir",
      state,
      "--port",
      port,
      "--no-open",
      "--start-timeout",
      "20",
      "--stop-timeout",
      "10",
    ],
    { out: (value) => messages.push(value), err: (value) => messages.push(value) },
    env,
    {
      cwd: join(home, "project"),
      homedir: () => home,
      nativeUiRuntime: runtime,
      ...overrides,
    },
  );
}

async function failedSpawn() {
  for (let i = 0; i < 2; ++i) {
    assert.equal(
      await invoke("start", {
        nativeUiRuntime: { ...runtime, launcherPath: join(home, "missing-native-launcher") },
      }),
      1,
    );
    assert.equal(readUiLifecycleTracking(join(state, "ui.pid")).kind, "absent");
  }
  return 0;
}

async function interruptedBeforeLaunch() {
  const spawnFn = (...args) => {
    const child = spawn(...args),
      actual = child.stdio[3];
    child.stdio[3] = new PassThrough();
    actual.end();
    return child;
  };
  assert.equal(await invoke("start", { spawnFn }), 1);
  assert.equal(readUiLifecycleTracking(join(state, "ui.pid")).kind, "absent");
  assert.equal(await invoke("start"), 0);
  assert.equal(await invoke("stop"), 0);
  return 0;
}

async function rejectedHelper() {
  assert.equal(
    await invoke("start", { nativeUiRuntime: { ...runtime, supervisorSha256: "0".repeat(64) } }),
    1,
  );
  assert.equal(readUiLifecycleTracking(join(state, "ui.pid")).kind, "absent");
  assert.equal(await invoke("start"), 0);
  assert.equal(await invoke("stop"), 0);
  return 0;
}

async function boundedExit(exited) {
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned fixture exit unavailable")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function lostFirstReceipt() {
  let first,
    exited,
    spawns = 0;
  const spawnFn = (...args) => {
    const child = spawn(...args);
    if (++spawns === 1) {
      first = child;
      exited = new Promise((resolve) => child.once("exit", resolve));
      const actual = child.stdio[4],
        lost = new PassThrough();
      actual.once("data", () => {
        assert(child.kill("SIGSTOP"));
        actual.destroy();
        lost.destroy();
      });
      child.stdio[4] = lost;
    }
    return child;
  };
  try {
    assert.equal(await invoke("start", { spawnFn }), 1);
    assert.equal(readUiLifecycleTracking(join(state, "ui.pid")).kind, "starting");
    assert.equal(await invoke("start", { spawnFn }), 1);
    assert.equal(spawns, 1);
    assert(first.kill("SIGCONT"));
    await boundedExit(exited);
    assert.equal(await invoke("start", { spawnFn }), 0);
    assert.equal(spawns, 2);
    assert.equal(await invoke("stop"), 0);
    return 0;
  } finally {
    first?.kill("SIGCONT");
    await invoke("stop");
  }
}

async function ownershipPhase(record) {
  const path = join(state, ".keiko", "ui-runtime", `${record.launchId}.receipt`);
  return (await readFile(path, "utf8")).split("\n")[4];
}

async function lostCommitAck() {
  let first,
    spawns = 0;
  const spawnFn = (...args) => {
    const child = spawn(...args);
    if (++spawns === 1) {
      first = child;
      const control = child.stdio[3],
        write = control.write.bind(control);
      control.write = (bytes, ...rest) => {
        if (bytes.subarray(0, 4).toString() === "KRC1") {
          assert(child.kill("SIGSTOP"));
          child.stdio[4].destroy();
        }
        return write(bytes, ...rest);
      };
    }
    return child;
  };
  try {
    assert.equal(await invoke("start", { spawnFn }), 1);
    const record = readPidRecord(join(state, "ui.pid"));
    assert.equal(record?.nativeAppRuntime, true);
    assert.equal(await ownershipPhase(record), "provisional");
    assert.equal(await invoke("start", { spawnFn }), 1);
    assert.equal(spawns, 1);
    assert(first.kill("SIGCONT"));
    for (let i = 0; i < 50 && (await ownershipPhase(record)) !== "owned"; ++i)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await ownershipPhase(record), "owned");
    assert.equal(await invoke("start", { spawnFn }), 0);
    assert.equal(spawns, 1);
    assert.equal(await invoke("stop"), 0);
    return 0;
  } finally {
    first?.kill("SIGCONT");
    await invoke("stop");
  }
}

const special = {
  "failed-spawn": failedSpawn,
  "lost-first-receipt": lostFirstReceipt,
  "lost-launch-request": interruptedBeforeLaunch,
  "rejected-helper": rejectedHelper,
  "lost-commit-ack": lostCommitAck,
};
const selected = special[command];
const result = selected === undefined ? await invoke(command) : await selected();
const record = readPidRecord(join(state, "ui.pid"));
await new Promise((resolve, reject) =>
  process.send(
    {
      result,
      record,
      diagnosticBytes: messages.reduce((total, value) => total + Buffer.byteLength(value), 0),
    },
    (error) => (error ? reject(error) : resolve()),
  ),
);
process.disconnect();
process.exitCode = result;
