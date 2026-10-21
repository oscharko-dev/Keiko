import { isMainThread, MessageChannel, MessagePort } from "node:worker_threads";
import {
  bindProcessScope,
  currentProcessId,
  currentProcessScopeKind,
  currentProcessScopeObservation,
  isProcessId,
  processFileOwnerUid,
  processLiveness,
  type ProcessLiveness,
  type ProcessScopePort,
} from "./process-scope.js";

const BOUND_NS = 5_000_000_000n;
const REPLY_BYTES = 16;
const PENDING = 0;
const EXECUTING = 1;
const COMPLETE = 2;
const REFUSED = 3;
const CLOSED = 4;

export interface ProcessScopeWorkerData {
  readonly version: 1;
  readonly pid: number;
  readonly port: MessagePort;
}

export interface ProcessScopeWorkerBridge {
  readonly data: ProcessScopeWorkerData;
  readonly dispose: () => void;
}

interface RequestBase {
  readonly reply: SharedArrayBuffer;
  readonly deadline: bigint;
}
type Query =
  | { readonly kind: "observation" }
  | { readonly kind: "probe"; readonly pid: number }
  | {
      readonly kind: "owner";
      readonly descriptor: number;
      readonly dev: bigint;
      readonly ino: bigint;
      readonly mode: bigint;
    };

type Request = RequestBase & Query;

interface BridgeState {
  closed: boolean;
  readonly pending: Set<Int32Array>;
}

function unsigned(value: unknown, maximum: bigint): value is bigint {
  return typeof value === "bigint" && value >= 0n && value <= maximum;
}

function ownerIdentity(record: Record<string, unknown>): boolean {
  return (
    typeof record.descriptor === "number" &&
    Number.isInteger(record.descriptor) &&
    record.descriptor >= 0 &&
    record.descriptor <= 0x7fffffff &&
    unsigned(record.dev, 0xffffffffffffffffn) &&
    unsigned(record.ino, 0xffffffffffffffffn) &&
    unsigned(record.mode, 0xffffffffn)
  );
}

function requestBuffer(record: Record<string, unknown>): boolean {
  return (
    record.reply instanceof SharedArrayBuffer &&
    record.reply.byteLength === REPLY_BYTES &&
    typeof record.deadline === "bigint"
  );
}

function isRequest(value: unknown): value is Request {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!requestBuffer(record)) return false;
  if (record.kind === "owner") return Object.keys(record).length === 7 && ownerIdentity(record);
  if (record.kind === "probe")
    return (
      Object.keys(record).length === 4 && typeof record.pid === "number" && isProcessId(record.pid)
    );
  return record.kind === "observation" && Object.keys(record).length === 3;
}

function admitted(deadline: bigint): boolean {
  const remaining = deadline - process.hrtime.bigint();
  return remaining > 0n && remaining <= BOUND_NS;
}

function settle(reply: Int32Array, status: number): void {
  if (Atomics.compareExchange(reply, 0, EXECUTING, status) === EXECUTING) Atomics.notify(reply, 0);
}

function observe(request: Request): readonly [number, number, number] {
  let result = 0,
    owner = 0;
  if (request.kind === "owner") {
    const uid = processFileOwnerUid(request.descriptor, request.dev, request.ino, request.mode);
    if (unsigned(uid, 0xffffffffn)) {
      result = 1;
      owner = Number(uid);
    }
  } else if (request.kind === "probe") {
    const value = processLiveness(request.pid);
    if (value === "alive") result = 1;
    else result = value === "dead" ? 2 : 3;
  }
  return [result, owner, currentProcessScopeObservation() === "ready" ? 1 : 2];
}

function canPublish(state: BridgeState, reply: Int32Array, deadline: bigint): boolean {
  return !state.closed && admitted(deadline) && Atomics.load(reply, 0) === EXECUTING;
}

function claimReply(reply: Int32Array): boolean {
  return (
    reply[1] === 0 &&
    reply[2] === 0 &&
    reply[3] === 0 &&
    Atomics.compareExchange(reply, 0, PENDING, EXECUTING) === PENDING
  );
}

function serve(state: BridgeState, value: unknown): void {
  if (!isRequest(value)) return;
  const reply = new Int32Array(value.reply);
  if (!claimReply(reply)) return;
  if (state.closed || !admitted(value.deadline)) {
    settle(reply, REFUSED);
    return;
  }
  state.pending.add(reply);
  try {
    const result = observe(value);
    if (canPublish(state, reply, value.deadline)) {
      reply[1] = result[0];
      new DataView(value.reply).setUint32(8, result[1], true);
      reply[3] = result[2];
      settle(reply, COMPLETE);
    } else settle(reply, REFUSED);
  } finally {
    state.pending.delete(reply);
  }
}

/** The selected main scope owns all native I/O; this port transports only bounded observations. */
export function createProcessScopeWorkerBridge(): ProcessScopeWorkerBridge | undefined {
  if (!isMainThread) throw new Error("process scope bridge requires the main thread");
  if (currentProcessScopeKind() !== "outer-native") return undefined;
  const pid = currentProcessId();
  const channel = new MessageChannel();
  const state: BridgeState = { closed: false, pending: new Set() };
  const dispose = (): void => {
    if (state.closed) return;
    state.closed = true;
    for (const reply of state.pending) settle(reply, CLOSED);
    state.pending.clear();
    channel.port1.close();
    channel.port2.close();
  };
  channel.port1.on("message", (value: unknown): void => {
    serve(state, value);
  });
  channel.port1.once("messageerror", dispose);
  channel.port1.once("close", dispose);
  channel.port1.unref();
  return { data: { version: 1, pid, port: channel.port2 }, dispose };
}

function waitForReply(reply: Int32Array, deadline: bigint): boolean {
  for (;;) {
    const remaining = deadline - process.hrtime.bigint();
    if (remaining <= 0n) return false;
    const state = Atomics.load(reply, 0);
    if (state === COMPLETE) return admitted(deadline) && (reply[3] === 1 || reply[3] === 2);
    if (state !== PENDING && state !== EXECUTING) return false;
    Atomics.wait(reply, 0, state, Number(remaining) / 1_000_000);
  }
}

function query(port: MessagePort, input: Query): Int32Array | undefined {
  // A new backing store per call is the generation: late replies cannot complete a later call.
  const buffer = new SharedArrayBuffer(REPLY_BYTES),
    reply = new Int32Array(buffer);
  const deadline = process.hrtime.bigint() + BOUND_NS;
  port.postMessage({ ...input, reply: buffer, deadline });
  if (waitForReply(reply, deadline)) return reply;
  Atomics.compareExchange(reply, 0, PENDING, REFUSED);
  Atomics.compareExchange(reply, 0, EXECUTING, REFUSED);
  return undefined;
}

function workerProbe(port: MessagePort): ProcessScopePort["probe"] {
  return (pid): ProcessLiveness => {
    if (!isProcessId(pid)) return "unknown";
    const reply = query(port, { kind: "probe", pid });
    if (reply?.[2] !== 0 || reply[3] !== 1) return "unknown";
    if (reply[1] === 1) return "alive";
    return reply[1] === 2 ? "dead" : "unknown";
  };
}

function workerFileOwner(port: MessagePort): NonNullable<ProcessScopePort["fileOwnerUid"]> {
  return (descriptor, dev, ino, mode): bigint | undefined => {
    if (!ownerIdentity({ descriptor, dev, ino, mode })) return undefined;
    const reply = query(port, { kind: "owner", descriptor, dev, ino, mode });
    if (reply?.[1] !== 1 || reply[3] !== 1) return undefined;
    return BigInt(new DataView(reply.buffer).getUint32(8, true));
  };
}

function isWorkerData(data: unknown): data is ProcessScopeWorkerData {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.pid === "number" &&
    isProcessId(record.pid) &&
    record.port instanceof MessagePort &&
    Object.keys(record).length === 3
  );
}

/** Bind before any supported Worker reader resolves its process coordinate. Never opens FD7. */
export function bindWorkerProcessScope(data: unknown): void {
  if (data === undefined) return;
  if (isMainThread || !isWorkerData(data)) throw new TypeError("process scope Worker port refused");
  const port = data.port;
  port.unref();
  bindProcessScope({
    pid: data.pid,
    kind: "outer-native",
    probe: workerProbe(port),
    fileOwnerUid: workerFileOwner(port),
    observation: (): "ready" | "unavailable" =>
      query(port, { kind: "observation" })?.[3] === 1 ? "ready" : "unavailable",
  });
}
