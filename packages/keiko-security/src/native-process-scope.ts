import { closeSync, fstatSync, readSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import {
  isProcessId,
  readProcessNamespaceIds,
  type ProcessLiveness,
  type ProcessScopePort,
} from "./process-scope.js";

const PROCESS_SCOPE_DESCRIPTOR = 7;
const PROCESS_SCOPE_BOUND_MS = 5000;
let initializationAttempted = false;

function claimNativeDecoder(): void {
  if (!isMainThread || initializationAttempted || process.platform !== "linux")
    throw new Error("native process scope unavailable");
  initializationAttempted = true;
}

function packet(kind: number, pid: number): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.write("KPI1");
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(kind, 6);
  bytes.writeUInt32LE(4, 8);
  bytes.writeUInt32LE(pid, 12);
  return bytes;
}

function interruptedIo(deadline: number, action: () => number): number {
  for (;;) {
    if (performance.now() >= deadline) throw new Error("native process scope I/O deadline expired");
    try {
      return action();
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EINTR"
      )
        throw error;
    }
  }
}

function response(kind: number, deadline: number, payloadBytes = 8): Buffer {
  const expected = 12 + payloadBytes;
  const bytes = Buffer.alloc(expected + 1);
  const size = interruptedIo(deadline, () =>
    readSync(PROCESS_SCOPE_DESCRIPTOR, bytes, 0, bytes.length, null),
  );
  if (
    performance.now() >= deadline ||
    size !== expected ||
    !bytes.subarray(0, 4).equals(Buffer.from("KPI1")) ||
    bytes.readUInt16LE(4) !== 1 ||
    bytes.readUInt16LE(6) !== kind ||
    bytes.readUInt32LE(8) !== payloadBytes
  )
    throw new Error("native process scope response refused");
  return bytes;
}

function retirePort(): void {
  try {
    closeSync(PROCESS_SCOPE_DESCRIPTOR);
  } catch {
    /* Already retired. */
  }
}

interface NativePortState {
  usable: boolean;
}

function retire(state: NativePortState): void {
  state.usable = false;
  retirePort();
}

function exchange(
  state: NativePortState,
  request: Buffer,
  resultKind: number,
  payloadBytes = 8,
): Buffer | undefined {
  if (!state.usable) return undefined;
  const deadline = performance.now() + PROCESS_SCOPE_BOUND_MS;
  try {
    if (
      interruptedIo(deadline, () => writeSync(PROCESS_SCOPE_DESCRIPTOR, request)) !==
        request.length ||
      performance.now() >= deadline
    )
      throw new Error("native process scope request refused");
    const bytes = response(resultKind, deadline, payloadBytes);
    if (bytes.readUInt32LE(12) !== request.readUInt32LE(12))
      throw new Error("native process scope result refused");
    return bytes;
  } catch {
    retire(state);
    return undefined;
  }
}

function nativeProbe(state: NativePortState): ProcessScopePort["probe"] {
  return (target): ProcessLiveness => {
    if (!isProcessId(target)) return "unknown";
    const bytes = exchange(state, packet(2, target), 3),
      value = bytes?.readUInt32LE(16);
    if (value === undefined || value === 3) return "unknown";
    if (value === 1 || value === 2) return value === 1 ? "alive" : "dead";
    retire(state);
    return "unknown";
  };
}

function unsigned(value: bigint, maximum: bigint): boolean {
  return value >= 0n && value <= maximum;
}

function fileOwnerRequest(
  descriptor: number,
  dev: bigint,
  ino: bigint,
  mode: bigint,
): Buffer | undefined {
  if (
    !Number.isInteger(descriptor) ||
    descriptor < 0 ||
    descriptor > 0x7fffffff ||
    !unsigned(dev, 0xffffffffffffffffn) ||
    !unsigned(ino, 0xffffffffffffffffn) ||
    !unsigned(mode, 0xffffffffn)
  )
    return undefined;
  const bytes = Buffer.alloc(36);
  packet(6, descriptor).copy(bytes);
  bytes.writeUInt32LE(24, 8);
  bytes.writeBigUInt64LE(dev, 16);
  bytes.writeBigUInt64LE(ino, 24);
  bytes.writeUInt32LE(Number(mode), 32);
  return bytes;
}

function fileOwnerUid(state: NativePortState): NonNullable<ProcessScopePort["fileOwnerUid"]> {
  return (descriptor, dev, ino, mode): bigint | undefined => {
    const request = fileOwnerRequest(descriptor, dev, ino, mode);
    if (request === undefined) return undefined;
    const bytes = exchange(state, request, 7, 32);
    if (bytes === undefined) return undefined;
    const status = bytes.readUInt32LE(16);
    if ((status === 2 || status === 3) && bytes.subarray(20).every((value) => value === 0))
      return undefined;
    if (
      status !== 1 ||
      bytes.readBigUInt64LE(28) !== dev ||
      bytes.readBigUInt64LE(36) !== ino ||
      BigInt(bytes.readUInt32LE(24)) !== mode
    ) {
      retire(state);
      return undefined;
    }
    return BigInt(bytes.readUInt32LE(20));
  };
}

/** Only the selected native launcher hands this root-only, kernel-bounded descriptor to the BFF. */
export function createNativeProcessScope(): ProcessScopePort {
  claimNativeDecoder();
  const ids = readProcessNamespaceIds();
  if (ids.length < 2 || !fstatSync(PROCESS_SCOPE_DESCRIPTOR).isSocket())
    throw new Error("native process scope unavailable");
  try {
    const identity = response(1, performance.now() + PROCESS_SCOPE_BOUND_MS);
    const pid = identity.readUInt32LE(12),
      owner = identity.readUInt32LE(16);
    if (!isProcessId(pid) || !isProcessId(owner) || pid === owner || ids[0] !== pid)
      throw new Error("native process scope identity refused");
    const state = { usable: true };
    return {
      pid,
      kind: "outer-native",
      probe: nativeProbe(state),
      fileOwnerUid: fileOwnerUid(state),
      observation: (): "ready" | "unavailable" => (state.usable ? "ready" : "unavailable"),
    };
  } catch {
    retirePort();
    throw new Error("native process scope initialization refused");
  }
}
