import { strict as assert } from "node:assert";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
const directory = await mkdtemp(join(tmpdir(), "keiko-process-scope-"));
async function compile(name, path) {
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
      fileURLToPath(new URL(path, import.meta.url)),
      "-o",
      target,
    ],
    { timeout: 60000, shell: false },
  );
  return target;
}

async function qualify(launcher, helper, root, mode, args = [mode], app = true) {
  const hash = createHash("sha256")
    .update(await readFile(helper))
    .digest("hex");
  const child = spawn(launcher, [app ? "--own-app-runtime" : "--own-runtime", helper, hash], {
    env: {},
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = streamReader(child.stdout),
    reader = streamReader(child.stdio[4]);
  const stderr = [];
  child.stderr.on("data", (bytes) => {
    if (stderr.length < 16) stderr.push(bytes);
  });
  child.stdio[3].on("error", () => {
    /* Refusal can close the control pipe before its sender. */
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  let complete = false;
  try {
    child.stdio[3].write(
      encodeLaunchPacket(
        {
          recoveryHandle: "0123456789abcdef0123456789abcdef",
          args,
          env: {},
        },
        { executable: root, cwd: mode.startsWith("node") ? join(directory, "project") : directory },
      ),
    );
    assert.deepEqual(await response(reader), { kind: 1, payload: Buffer.alloc(0) });
    await finishRoot(child, mode, reader, output, exited);
    complete = true;
  } catch (error) {
    if (!mode.startsWith("node")) throw error;
    await exited;
    const text = Buffer.concat(stderr).toString("utf8");
    assert.fail(
      JSON.stringify({
        stderrBytes: Buffer.byteLength(text),
        classes: [...new Set(text.match(/\b(?:[A-Za-z]*Error|ERR_[A-Z_]+)\b/gu) ?? [])],
        frames: [...new Set(text.match(/[A-Za-z0-9_.-]+\.(?:mjs|js|ts):\d+:\d+/gu) ?? [])],
        bootstrap: text.split("\n").find((line) => line.startsWith("BOOTSTRAP ")),
      }),
    );
  } finally {
    clearTimeout(timeout);
    child.kill("SIGCONT");
    if (!complete) child.kill("SIGKILL");
    await exited;
  }
}

async function finishRoot(child, mode, reader, output, exited) {
  const refused = new Set(["node-refused", "node-absent"]).has(mode);
  const expected = refused
    ? "NODE-REFUSED\n"
    : mode === "foreign"
      ? "REFUSED\n"
      : mode === "valid"
        ? "SCOPE\n"
        : "NODE-SCOPE\n";
  assert.equal((await readBytes(output, expected.length)).toString(), expected);
  if (mode === "node-timeout") await stoppedOwner(child, output);
  if (!refused) child.stdio[3].end(encodeControlPacket(3));
  const retired = await response(reader);
  assert.equal(retired.kind, 2);
  assert.equal(retired.payload.readUInt32LE(0), refused ? 1 : 137);
  assert.equal(retired.payload.readUInt32LE(4), 0);
  assert.equal(await exited, 0);
}

async function stoppedOwner(child, output) {
  assert(child.kill("SIGSTOP"));
  child.stdin.write("Q");
  const unknown = "NODE-UNKNOWN\n";
  assert.equal((await readBytes(output, unknown.length)).toString(), unknown);
  assert(child.kill("SIGCONT"));
  child.stdin.write("R");
  const survived = "NODE-SURVIVED\n";
  assert.equal((await readBytes(output, survived.length)).toString(), survived);
}

async function bff(launcher, helper, mode = "node") {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const suffix = mode;
  const stateDir = join(directory, `state-${suffix}`),
    staticRoot = join(directory, `static-${suffix}`);
  const hashesFile = join(directory, `hashes-${suffix}.json`);
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(join(directory, "project"), { recursive: true });
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Qualification</title>");
  await writeFile(hashesFile, "[]\n");
  await qualify(
    launcher,
    helper,
    process.execPath,
    mode,
    [
      fileURLToPath(new URL("./process_scope_node_fixture.mjs", import.meta.url)),
      stateDir,
      staticRoot,
      hashesFile,
      String(address.port),
      mode === "node-refused"
        ? "sqlite-refusal"
        : mode === "node-absent"
          ? "identity-refusal"
          : mode === "node-timeout"
            ? "timeout"
            : "ready",
    ],
    mode !== "node-absent",
  );
}
try {
  const launcher = await compile("launcher", "../../portable-launcher/keiko-portable-launcher.c");
  const helper = await compile("supervisor", "./keiko_runtime_supervisor.c");
  const root = await compile("root", "./process_scope_root_fixture.c");
  const receiver = await compile("receiver", "./process_scope_receiver_fixture.c");
  for (const mode of [
    "valid",
    "denied",
    "missing-proc",
    "unavailable",
    "absent",
    "magic",
    "version",
    "kind",
    "length",
    "zero-pid",
    "negative-pid",
    "foreign",
    "rights",
    "truncated-rights",
    "short",
    "oversized",
    "expired",
    "late-probe",
    "late-send",
  ]) {
    await test(`outer process scope receiver: ${mode}`, async () => {
      const result = await execute(receiver, [mode], { timeout: 5000, shell: false });
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    });
  }
  await test("namespaced app joins its outer identity and actual outer-process liveness", async () =>
    qualify(launcher, helper, root, "valid"));
  await test("a foreign lookup is refused while the owned app stays alive", async () =>
    qualify(launcher, helper, root, "foreign"));
  await test("real Node BFF binds before its first durable Activity Log record", async () =>
    bff(launcher, helper));
  await test("native Node bootstrap refuses SQLite re-exec before durable state", async () =>
    bff(launcher, helper, "node-refused"));
  await test("native Node bootstrap refuses an absent owner port before durable state", async () =>
    bff(launcher, helper, "node-absent"));
  await test("a stopped lookup owner preserves the BFF and cannot revive a timed-out port", async () =>
    bff(launcher, helper, "node-timeout"));
} finally {
  await rm(directory, { recursive: true, force: true });
}
