import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeExclusivePidFile } from "../../../packages/keiko-cli/dist/state-paths.js";
import {
  appResponse,
  commitPacket,
  compileOwnerFixture,
  appLaunchPacket,
} from "./app-owner-harness.mjs";
import { readBytes, streamReader } from "../protocol-harness.mjs";

const { fetch, AbortSignal } = globalThis;
const directory = await mkdtemp(join(tmpdir(), "keiko-app-owner-"));
const compile = (name, source) => compileOwnerFixture(directory, name, source);

async function proof(state, launchId) {
  return readFile(join(state, ".keiko", "ui-runtime", `${launchId}.receipt`), "utf8");
}

async function qualify(launcher, helper, root, hash, mode) {
  const state = join(directory, mode);
  await mkdir(state, { mode: 0o700 });
  const launchId = randomBytes(16).toString("hex");
  const child = spawn(launcher, ["--own-app-runtime", helper, hash], {
    env: {},
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stdio[3].on("error", () => {
    /* A closed refusal may retire its own pipe. */
  });
  child.stdio[4].on("error", () => {
    /* Lost-ACK qualification deliberately closes this pipe. */
  });
  const reader = streamReader(child.stdio[4]),
    output = streamReader(child.stdout);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 12000);
  let complete = false;
  try {
    child.stdio[3].write(
      appLaunchPacket(
        {
          recoveryHandle: launchId,
          args: ["persistent"],
          env: {
            KEIKO_UI_LAUNCH_ID: launchId,
            KEIKO_STATE_DIR: state,
            KEIKO_START_TIMEOUT_SECS: mode === "commit-timeout" ? "1" : "5",
          },
        },
        { executable: root, cwd: directory },
        inheritedEnvironment(mode, state, launchId),
      ),
    );
    const started = await appResponse(reader);
    assert.equal(started.kind, 4);
    assert.equal(started.payload.length, 36);
    const pid = started.payload.readUInt32LE(0);
    assert(pid > 2 && pid !== child.pid);
    assert.equal(started.payload.subarray(4).toString(), launchId);
    assert.equal((await readBytes(output, 6)).toString(), "SCOPE\n");
    const expected = (status) =>
      `keiko-ui-runtime-v1\n${pid}\n${launchId}\n${child.pid}\n${status}\n`;
    assert.equal(await proof(state, launchId), expected("provisional"));
    if (mode !== "missing-pid") {
      writeExclusivePidFile(
        join(state, "ui.pid"),
        mode === "wrong-pid" ? child.pid : pid,
        mode === "wrong-record-launch" ? "f".repeat(32) : launchId,
        true,
        true,
      );
    }
    await lifecycleControl(child, mode, reader, output, state, launchId, expected);
    const result = await exited;
    assert.equal(result.signal, null);
    assert.equal(result.code, invalidCommit(mode) ? 1 : 0);
    assert.equal(await proof(state, launchId), expected("reaped"));
    complete = true;
  } finally {
    clearTimeout(timeout);
    if (!complete) child.kill("SIGKILL");
    await exited;
  }
}

function inheritedEnvironment(mode, state, launchId) {
  if (mode !== "large-env") return {};
  return {
    ...Object.fromEntries(
      Array.from({ length: 140 }, (_, i) => [`KEIKO_QUALIFICATION_${i}`, "value"]),
    ),
    KEIKO_QUALIFICATION_CHECK_ENV: "1",
    OPENAI_API_KEY: "fixture-placeholder",
    NODE_EXTRA_CA_CERTS: "fixture-certificate.pem",
    BROWSER: "fixture-browser",
    KEIKO_START_TIMEOUT_SECS: "20",
    KEIKO_STATE_DIR: "/not-selected",
    KEIKO_UI_LAUNCH_ID: "f".repeat(32),
    KEIKO_QUALIFICATION_EXPECTED_STATE: state,
    KEIKO_QUALIFICATION_EXPECTED_LAUNCH: launchId,
  };
}

function invalidCommit(mode) {
  return new Set(["wrong-pid", "wrong-record-launch", "wrong-commit-launch", "missing-pid"]).has(
    mode,
  );
}

async function lifecycleControl(child, mode, reader, output, state, launchId, expected) {
  if (mode === "precommit-eof") child.stdio[3].end();
  else if (mode !== "commit-timeout") {
    if (mode === "lost-ack") child.stdio[4].destroy();
    child.stdio[3].write(commitPacket(mode === "wrong-commit-launch" ? "f".repeat(32) : launchId));
    if (mode !== "lost-ack") {
      const committed = await appResponse(reader);
      if (invalidCommit(mode)) {
        assert.equal(committed.kind, 3);
      } else {
        assert.deepEqual(committed, { kind: 5, payload: Buffer.from(launchId) });
      }
    }
    if (new Set(["detached", "lost-ack", "large-env"]).has(mode))
      await detachedRoot(child, mode, output, state, launchId, expected);
  }
}

async function detachedRoot(child, mode, output, state, launchId, expected) {
  if (mode === "lost-ack") {
    for (let i = 0; i < 100 && (await proof(state, launchId)) !== expected("owned"); ++i)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await proof(state, launchId), expected("owned"));
  child.stdio[3].end();
  child.stdin.write("Q");
  assert.equal((await readBytes(output, 6)).toString(), "SCOPE\n");
  child.stdin.write("X");
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return String(address.port);
}

async function controller(command, launcher, helper, hash, home, state, port) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./app-owner-cli-fixture.mjs", import.meta.url)),
      command,
      launcher,
      helper,
      hash,
      home,
      state,
      port,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        NODE_NO_WARNINGS: "1",
        ...Object.fromEntries(
          Array.from({ length: 140 }, (_, i) => [`KEIKO_QUALIFICATION_${i}`, "value"]),
        ),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const messages = [],
    errors = [];
  child.on("message", (message) => messages.push(message));
  child.stderr.on("data", (bytes) => errors.push(bytes));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 35000);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  assert.deepEqual(
    result,
    { code: 0, signal: null },
    JSON.stringify({ command, result, diagnosticBytes: Buffer.concat(errors).length, messages }),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].result, 0);
  return messages[0].record;
}

async function actualCli(launcher, helper, hash) {
  const home = await mkdtemp(join(directory, "actual-cli-")),
    state = join(home, ".keiko");
  await mkdir(join(home, "project"));
  await writeFile(
    join(home, "project", "package.json"),
    '{"name":"native-app-fixture","private":true}\n',
  );
  const port = await unusedPort();
  let active = false;
  try {
    for (let attempt = 0; attempt < 2; ++attempt) {
      const record = await controller("start", launcher, helper, hash, home, state, port);
      active = true;
      assert.equal(record.nativeAppRuntime, true);
      assert.equal(record.browserOpenSupported, true);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).launchId, record.launchId);
      const owned = (await proof(state, record.launchId)).split("\n");
      assert.equal(owned[1], String(record.pid));
      assert.equal(owned[4], "owned");
      // A separate launcher can adopt only the already committed native generation.
      assert.deepEqual(
        await controller("start", launcher, helper, hash, home, state, port),
        record,
      );
      await controller("stop", launcher, helper, hash, home, state, port);
      active = false;
      assert.equal((await proof(state, record.launchId)).split("\n")[4], "reaped");
    }
  } finally {
    if (active) await controller("stop", launcher, helper, hash, home, state, port);
  }
}

async function admissionCutpoint(command, launcher, helper, hash) {
  const home = await mkdtemp(join(directory, "admission-")),
    state = join(home, ".keiko");
  await mkdir(join(home, "project"));
  await writeFile(
    join(home, "project", "package.json"),
    '{"name":"admission-fixture","private":true}\n',
  );
  await controller(command, launcher, helper, hash, home, state, await unusedPort());
}

try {
  const launcher = await compile("launcher", "../../portable-launcher/keiko-portable-launcher.c");
  const helper = await compile("supervisor", "./keiko_runtime_supervisor.c");
  const root = await compile("root", "./app_control_root_fixture.c");
  const hash = createHash("sha256")
    .update(await readFile(helper))
    .digest("hex");
  for (const mode of [
    "detached",
    "precommit-eof",
    "commit-timeout",
    "wrong-pid",
    "wrong-record-launch",
    "wrong-commit-launch",
    "missing-pid",
    "lost-ack",
    "large-env",
  ])
    await test(`app owner lifecycle: ${mode}`, { timeout: 18000 }, async () =>
      qualify(launcher, helper, root, hash, mode),
    );
  await test(
    "actual CLI exits; real BFF remains healthy; independent stop proves whole reap twice",
    { timeout: 90000 },
    async () => actualCli(launcher, helper, hash),
  );
  for (const command of [
    "failed-spawn",
    "lost-first-receipt",
    "lost-launch-request",
    "rejected-helper",
    "lost-commit-ack",
  ])
    await test(`actual CLI admission: ${command}`, { timeout: 45000 }, async () =>
      admissionCutpoint(command, launcher, helper, hash),
    );
} finally {
  await rm(directory, { recursive: true, force: true });
}
