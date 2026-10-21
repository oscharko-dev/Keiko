/* A Worker shares descriptors, but must never initialize the root's one-shot decoder. */
import { strict as assert } from "node:assert";
import { parentPort } from "node:worker_threads";
import { createNativeProcessScope } from "../../../packages/keiko-security/dist/native-process-scope.js";

assert(parentPort);
assert.throws(() => createNativeProcessScope());
parentPort.postMessage("refused");
parentPort.close();
