/* Real Worker transport controls; the parent owns the selected observation implementation. */
import { strict as assert } from "node:assert";
import { parentPort, workerData } from "node:worker_threads";
import { openSync, closeSync, fstatSync, constants } from "node:fs";
import { bindWorkerProcessScope } from "../../packages/keiko-security/dist/process-scope-worker.js";
import {
  currentProcessId,
  currentProcessScopeKind,
  currentProcessScopeObservation,
  processFileOwnerUid,
  processLiveness,
  fileDescriptorOwnerUid,
} from "../../packages/keiko-security/dist/process-scope.js";
import { openSafeArtifactFile } from "../../packages/keiko-security/dist/fs-hardening.js";

assert(parentPort);
const identity = [0x20000000000001n, 0xffffffffffffffffn, 0o100600n];
if (workerData.mode === "bind-refuse") {
  assert.throws(() => bindWorkerProcessScope(workerData.scope));
  parentPort.postMessage("refused");
} else {
  bindWorkerProcessScope(workerData.scope);
  if (workerData.mode === "filesystem") verifyForeignDirectory();
  else if (workerData.mode === "timeout") {
    const first = processFileOwnerUid(9, ...identity);
    parentPort.postMessage({
      first,
      second: processFileOwnerUid(10, ...identity),
      observation: currentProcessScopeObservation(),
    });
  } else if (workerData.mode === "one")
    parentPort.postMessage({ first: processFileOwnerUid(workerData.descriptor ?? 9, ...identity) });
  else {
    parentPort.postMessage({
      first: processFileOwnerUid(workerData.descriptor ?? 9, ...identity),
      pid: currentProcessId(),
      kind: currentProcessScopeKind(),
      liveness: [2001, 2002, 2003].map(processLiveness),
      observation: currentProcessScopeObservation(),
    });
  }
}
parentPort.close();

function verifyForeignDirectory() {
  const descriptor = openSync(
    "/home/node",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    const uid = fileDescriptorOwnerUid(descriptor, stat);
    assert.equal(uid, 1000n);
    if (process.geteuid() !== 1000) {
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
    parentPort.postMessage({ uid, ready: currentProcessScopeObservation() === "ready" });
  } finally {
    closeSync(descriptor);
  }
}
