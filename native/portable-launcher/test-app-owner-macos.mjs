import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeAppEnvironmentPacket,
  encodeLaunchPacket,
} from "../../packages/keiko-contracts/src/native-runtime-wire.ts";
import {
  header,
  readBytes,
  response,
  streamReader,
} from "../runtime-supervisor/protocol-harness.mjs";

const [launcher, helper, fixture] = process.argv.slice(2).map((path) => realpathSync(path));
assert.equal(process.platform, "darwin");
const state = realpathSync(mkdtempSync(join(tmpdir(), "keiko-macos-owner-")));
const launchId = "0123456789abcdef0123456789abcdef";
const digest = createHash("sha256").update(readFileSync(helper)).digest("hex");
const owner = spawn(launcher, ["--own-app-runtime", helper, digest], {
  env: {
    KEIKO_UI_START_DEADLINE_MS: String(process.hrtime.bigint() / 1000000n + 5000n),
    KEIKO_UI_COMMIT_DEADLINE_MS: String(process.hrtime.bigint() / 1000000n + 10000n),
  },
  stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
});
const exit = new Promise((resolve, reject) => {
  owner.once("error", reject);
  owner.once("exit", (code, signal) => resolve({ code, signal }));
});
const output = streamReader(owner.stdout);
const results = streamReader(owner.stdio[4]);
owner.stdio[3].on("error", () => {
  /* Response and exit assertions own failure. */
});
const timeout = setTimeout(() => owner.kill("SIGKILL"), 15000);
try {
  owner.stdio[3].write(
    Buffer.concat([
      encodeLaunchPacket(
        {
          recoveryHandle: launchId,
          args: ["--qualified", "second-argument"],
          env: {
            KEIKO_UI_LAUNCH_ID: launchId,
            KEIKO_STATE_DIR: state,
            KEIKO_START_TIMEOUT_SECS: "900",
          },
        },
        { executable: fixture, cwd: state },
      ),
      encodeAppEnvironmentPacket({ PRIVATE_TEST_VALUE: "held-only-in-memory" }),
    ]),
  );
  const admitted = await response(results);
  assert.equal(
    admitted.kind,
    4,
    JSON.stringify({ kind: admitted.kind, payload: [...admitted.payload] }),
  );
  assert.equal(admitted.payload.subarray(4).toString(), launchId);
  const pid = admitted.payload.readUInt32LE(0);
  const observed = await readBytes(output, 12);
  assert.equal(observed.readUInt32LE(4), pid);
  writeFileSync(join(state, "ui.pid"), `${pid}\n${launchId}\nbrowser-open-v1\nnative-app-v1\n`, {
    mode: 0o600,
  });
  owner.stdio[3].write(Buffer.concat([header("KRC1", 4, 32), Buffer.from(launchId)]));
  assert.equal((await response(results)).kind, 5);
  owner.stdio[3].end();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(owner.exitCode, null);
  assert.equal(process.kill(pid, 0), true);
  process.kill(pid, "SIGTERM");
  assert.deepEqual(await exit, { code: 0, signal: null });
  const receipt = readFileSync(join(state, ".keiko", "ui-runtime", `${launchId}.receipt`), "utf8");
  assert.ok(receipt.endsWith("\nreaped\n"));
  for (const offset of [4, 8])
    assert.throws(() => process.kill(observed.readUInt32LE(offset), 0), { code: "ESRCH" });
  console.log(
    "macOS app owner: PASS - durable admission, controller release, root exit and descendant cleanup",
  );
} finally {
  clearTimeout(timeout);
  if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
  rmSync(state, { recursive: true, force: true });
}
