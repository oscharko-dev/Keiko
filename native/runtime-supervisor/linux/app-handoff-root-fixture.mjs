/* A small HTTP fixture exercises the production native handoff, not the complete Keiko product. */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { setImmediate } from "node:timers";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bindProcessScope,
  currentProcessId,
  isProcessAlive,
} from "../../../packages/keiko-security/dist/process-scope.js";
import { createNativeProcessScope } from "../../../packages/keiko-security/dist/native-process-scope.js";
import { createPortableHandoffCoordinator } from "../../../packages/keiko-server/dist/update-portable-handoff.js";
import {
  currentNativeAppControl,
  NativeAppControlError,
  NativeAppControl,
} from "../../../packages/keiko-server/dist/update-native-app-control.js";
import { NativeAppControlStream } from "../../../packages/keiko-server/dist/update-native-app-control-stream.js";
import {
  readPortableHandoffPlan,
  portableHandoffPlanSha256,
} from "../../../packages/keiko-server/dist/update-portable-handoff-plan.js";
import {
  appendPortableHandoffReceipt,
  readPortableHandoffReceipts,
  portableHandoffReceiptSha256,
  publishPortableHandoffVerifiedAck,
} from "../../../packages/keiko-server/dist/update-portable-handoff-receipts.js";

if (process.platform === "darwin") process.env.KEIKO_APP_RUNTIME_OWNER = "1";
else bindProcessScope(createNativeProcessScope());
if (!isProcessAlive(currentProcessId()))
  throw new Error("native fixture root ownership unavailable");
if (process.env.KEIKO_HANDOFF_FIXTURE_FAIL_BOOT === "1") process.exit(73);
const { AbortController } = globalThis;
if (process.env.KEIKO_HANDOFF_FIXTURE_WRONG_LAUNCH === "1") {
  const wrongLaunch = process.env.KEIKO_UI_LAUNCH_ID.startsWith("a")
    ? "b".repeat(32)
    : "a".repeat(32);
  const refusal = await currentNativeAppControl(wrongLaunch).catch((error) => error);
  if (!(refusal instanceof NativeAppControlError) || refusal.nativeAuthorityMayBeLive)
    throw new Error("native fixture wrong launch was not refused");
}
const stateDir = process.env.KEIKO_STATE_DIR;
const version = process.env.KEIKO_HANDOFF_FIXTURE_VERSION;
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
let coordinatorPid;
const events = [];
let fixtureControl;
let fixtureSocket;
let cancellation;

async function nativeControl(launchId) {
  if (launchId !== process.env.KEIKO_UI_LAUNCH_ID) throw new NativeAppControlError(false);
  if (fixtureControl === undefined) {
    fixtureSocket = new Socket({ fd: 8, readable: true, writable: true });
    fixtureSocket.unref();
    fixtureControl = new NativeAppControl(
      new NativeAppControlStream(fixtureSocket),
      currentProcessId(),
      launchId,
    );
    await fixtureControl.ready(globalThis.performance.now() + 5000);
  }
  return {
    start: (...args) => fixtureControl.start(...args),
    commit: (...args) => fixtureControl.commit(...args),
    cancel: (...args) => fixtureControl.cancel(...args),
    accept: (deadline, signal) => {
      if (cancellation === undefined) return fixtureControl.accept(deadline, signal);
      fixtureSocket.cork();
      const pending = fixtureControl.accept(deadline, signal);
      cancellation.abort();
      setImmediate(() => fixtureSocket.uncork());
      return pending;
    },
  };
}
const coordinator = createPortableHandoffCoordinator({
  stateDir,
  persistPrepared: async ({ activationWal }) => {
    writeFileSync(join(stateDir, "fixture-activation.json"), JSON.stringify(activationWal), {
      mode: 0o600,
    });
  },
  persistAccepted: async ({ activationWal }) => {
    writeFileSync(join(stateDir, "fixture-activation.json"), JSON.stringify(activationWal), {
      mode: 0o600,
    });
  },
  verifyNativeCopy: () => Promise.resolve(),
  publishCoordinatorPid: (_session, pid) => {
    coordinatorPid = pid;
    return true;
  },
  securityLogSink: { write: (event) => events.push(event) },
  acceptanceTimeoutMs: 15_000,
  nativeControl: process.env.KEIKO_HANDOFF_FIXTURE_COALESCED === "1" ? nativeControl : undefined,
});

function stop() {
  server.close(() => process.exit(0));
}

function fixtureState() {
  const retained =
    Array.from(
      { length: 140 },
      (_, index) => process.env[`KEIKO_HANDOFF_FIXTURE_VALUE_${index}`] === "x".repeat(512),
    ).every(Boolean) && process.env.OPENAI_API_KEY === "fixture-placeholder";
  return {
    version,
    pid: currentProcessId(),
    retainedEnvironment: retained,
    environmentDigest: createHash("sha256")
      .update(process.env.KEIKO_HANDOFF_FIXTURE_DATA ?? "")
      .digest("hex"),
  };
}

async function handoff(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const { activationId, cancel } = JSON.parse(Buffer.concat(chunks).toString());
  cancellation = cancel ? new AbortController() : undefined;
  try {
    await coordinator.begin({
      sessionId: "native-fixture",
      activationId,
      signal: cancellation?.signal,
    });
  } catch (error) {
    if (cancel && error.nativeAuthorityMayBeLive === false && coordinatorPid !== undefined) {
      response.end(JSON.stringify({ cancelled: true, coordinatorPid }));
      return;
    }
    throw error;
  } finally {
    cancellation = undefined;
  }
  writeFileSync(
    join(stateDir, `fixture-native-events-${activationId}.json`),
    JSON.stringify(events),
  );
  response.end(JSON.stringify({ accepted: true, coordinatorPid }));
  setTimeout(stop, 30);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/state") {
      response.end(JSON.stringify(fixtureState()));
      return;
    }
    if (request.method === "POST" && request.url === "/handoff") {
      await handoff(request, response);
      return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      response.end("stopping");
      setTimeout(stop, 30);
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    response
      .writeHead(500)
      .end(JSON.stringify({ message: error.message, cause: error.cause?.message }));
  }
});
server.listen(port, "127.0.0.1");

if (process.env.KEIKO_HANDOFF_FIXTURE_RESUME === "1") {
  const wal = JSON.parse(readFileSync(join(stateDir, "fixture-activation.json"), "utf8"));
  const plan = readPortableHandoffPlan(stateDir, wal.activationId);
  const planSha256 = portableHandoffPlanSha256(plan);
  const restored = process.env.KEIKO_UI_LAUNCH_ID === plan.restoreLaunchId;
  const kind = restored ? "restored-verify" : "verify";
  for (const outcome of ["intent", "completed"]) {
    const previous = readPortableHandoffReceipts(stateDir, wal.activationId).at(-1);
    appendPortableHandoffReceipt({
      stateDir,
      activationId: wal.activationId,
      planSha256,
      kind,
      outcome,
      at: Date.now(),
      previousSha256: previous === undefined ? undefined : portableHandoffReceiptSha256(previous),
    });
  }
  if (!restored)
    publishPortableHandoffVerifiedAck({ stateDir, activationId: wal.activationId, planSha256 });
}
