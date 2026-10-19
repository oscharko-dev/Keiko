/* Real BFF bootstrap: bind the inherited owner before any persistent writer or lock is built. */
import { strict as assert } from "node:assert";
import {
  readdirSync,
  readFileSync,
  readSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs";
import { join } from "node:path";
import { setInterval, clearInterval } from "node:timers";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import {
  currentProcessId,
  currentProcessScopeKind,
  currentProcessScopeObservation,
  processLiveness,
  readProcessNamespaceIds,
  fileDescriptorOwnerUid,
} from "../../../packages/keiko-security/dist/process-scope.js";
import { openSafeArtifactFile } from "../../../packages/keiko-security/dist/fs-hardening.js";
import { createNativeProcessScope } from "../../../packages/keiko-security/dist/native-process-scope.js";
import { runUiCli, startProcessHeartbeat } from "../../../packages/keiko-cli/dist/ui.js";
import { createFileServerLogSink } from "../../../packages/keiko-activity-log/dist/server-log.js";

const [stateDir, staticRoot, hashesFile, port, mode] = process.argv.slice(2);
assert(stateDir && staticRoot && hashesFile && port);
let reported = false;
const failures = [];

function records() {
  const logs = join(stateDir, "logs");
  return readdirSync(logs)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(logs, name), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
}

function verifyForeignOwner() {
  const descriptor = openSync(
    "/home/node",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const stat = fstatSync(descriptor, { bigint: true });
  const hostUid = fileDescriptorOwnerUid(descriptor, stat);
  closeSync(descriptor);
  assert.equal(hostUid, 1000n);
  if (process.geteuid() === 1000) return;
  assert.equal(stat.uid, BigInt(process.geteuid()));
  assert.throws(
    () =>
      openSafeArtifactFile("/home/node/qualification-absent", {
        artifactClass: "manifest",
        mode: "exclusive-create",
        trustedRoot: "/home/node",
      }),
    (error) => error.kind === "unsafe-ancestor",
  );
}

function verifyNativeState() {
  const outer = readProcessNamespaceIds()[0];
  assert.notEqual(outer, process.pid);
  assert.equal(currentProcessId(), outer);
  assert.equal(currentProcessScopeKind(), "outer-native");
  assert.equal(processLiveness(outer), "alive");
  assert.equal(processLiveness(0x7fffffff), "dead");
  verifyForeignOwner();
  const entries = records();
  assert(entries.length > 0);
  assert(entries.every((record) => record.pid === outer));
  return outer;
}

function awaitStartupRecord(outer) {
  const deadline = setTimeout(() => {
    clearInterval(poll);
    assert.fail("startup record absent");
  }, 5000);
  const poll = setInterval(async () => {
    const event = records().find((record) => record.op === "process.started");
    if (event === undefined) return;
    assert.equal(event.pid, outer);
    assert.equal(event.processScope, "outer-native");
    assert.equal(event.processScopeState, "ready");
    clearInterval(poll);
    clearTimeout(deadline);
    await verifyDecoderLifetime(outer);
    reported = true;
    process.stdout.write("NODE-SCOPE\n");
    if (mode === "timeout") void verifyOwnerTimeout();
  }, 10);
}

async function verifyDecoderLifetime(outer) {
  assert.throws(() => createNativeProcessScope());
  assert.equal(processLiveness(outer), "alive");
  const worker = new Worker(new URL("./process_scope_decoder_worker_fixture.mjs", import.meta.url));
  let deadline;
  try {
    const result = await Promise.race([
      once(worker, "message"),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Worker decoder refusal absent")), 5000);
      }),
    ]);
    assert.deepEqual(result, ["refused"]);
    assert.equal(processLiveness(outer), "alive");
    assert.equal(currentProcessScopeObservation(), "ready");
  } finally {
    clearTimeout(deadline);
    await worker.terminate();
  }
}

async function verifyOwnerTimeout() {
  // A facade reuses the BFF's existing active writer and held segment; no second writer is created.
  const log = createFileServerLogSink(stateDir);
  const gate = Buffer.alloc(1);
  assert.equal(readSync(0, gate, 0, 1, null), 1);
  assert.equal(gate.toString(), "Q");
  assert.equal(processLiveness(0x7fffffff), "unknown");
  assert.equal(currentProcessScopeObservation(), "unavailable");
  await persistUnavailableHeartbeat(log);
  process.stdout.write("NODE-UNKNOWN\n");
  assert.equal(readSync(0, gate, 0, 1, null), 1);
  assert.equal(gate.toString(), "R");
  assert.equal(processLiveness(0x7fffffff), "unknown");
  assert.equal(currentProcessScopeObservation(), "unavailable");
  process.stdout.write("NODE-SURVIVED\n");
}

function persistUnavailableHeartbeat(log) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      stop();
      reject(new Error("unavailable heartbeat absent"));
    }, 5000);
    const stop = startProcessHeartbeat(log, 1, undefined, () => {
      try {
        const event = records().find((record) => record.op === "process.heartbeat");
        assert(event);
        assert.equal(event.processScopeState, "unavailable");
        assert.equal(event.pid, currentProcessId());
        stop();
        clearTimeout(deadline);
        resolve();
      } catch (error) {
        stop();
        clearTimeout(deadline);
        reject(error);
      }
    });
  });
}

const code = await runUiCli(
  ["--runtime-owner", "--port", port],
  {
    out: (text) => {
      if (text.startsWith("Keiko UI listening on http://")) awaitStartupRecord(verifyNativeState());
    },
    err: (text) => {
      failures.push({
        identity: text.includes("process identity"),
        sqlite: text.includes("SQLite"),
        store: text.toLowerCase().includes("store"),
        native: text.toLowerCase().includes("native"),
        unavailable: text.toLowerCase().includes("unavailable"),
        codes: text.match(/\([A-Z][A-Z0-9_]{2,80}\)/gu) ?? [],
      });
    },
  },
  { KEIKO_STATE_DIR: stateDir },
  {
    cwd: join(stateDir, "..", "project"),
    staticRoot,
    hashesFile,
    ...(mode === "sqlite-refusal"
      ? {
          sqliteProbe: () => false,
          spawnFn: () => {
            assert.fail("native root must not re-exec");
          },
        }
      : {}),
  },
);
if (mode === "sqlite-refusal" || mode === "identity-refusal") {
  assert.equal(code, 1);
  assert.equal(readdirSync(stateDir).length, 0);
  if (mode === "identity-refusal") assert(failures.some((failure) => failure.identity));
  process.stdout.write("NODE-REFUSED\n");
  process.exitCode = 1;
} else {
  if (!reported) process.stderr.write(`BOOTSTRAP ${JSON.stringify({ code, failures })}\n`);
  assert(reported);
  process.exitCode = code;
}
