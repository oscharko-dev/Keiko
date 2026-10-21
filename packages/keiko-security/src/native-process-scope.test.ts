import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
let createNativeProcessScope: typeof import("./native-process-scope.js").createNativeProcessScope;

const state = vi.hoisted(() => ({
  frames: [] as Buffer[],
  reads: 0,
  writes: 0,
  requests: [] as Buffer[],
  closes: 0,
  socket: true,
  ids: [] as number[],
  namespaceReads: 0,
  stats: 0,
  mainThread: true,
  readFaults: [] as string[],
  writeFaults: [] as string[],
  clock: 0,
  readStepMs: 0,
  writeStepMs: 0,
}));
const originalPlatform = process.platform;

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    fstatSync: (fd: number): unknown => {
      if (fd !== 7) return actual.fstatSync(fd);
      state.stats += 1;
      return { isSocket: () => state.socket };
    },
    readSync: (fd: number, bytes: Buffer): number => {
      if (fd !== 7) throw new Error("unexpected descriptor");
      state.reads += 1;
      const fault = state.readFaults.shift();
      if (fault !== undefined) {
        state.clock += state.readStepMs;
        throw Object.assign(new Error(), { code: fault });
      }
      const frame = state.frames.shift();
      if (frame === undefined) throw Object.assign(new Error(), { code: "EAGAIN" });
      frame.copy(bytes);
      return frame.length;
    },
    writeSync: (fd: number, bytes: Buffer): number => {
      if (fd !== 7) throw new Error("unexpected descriptor");
      state.writes += 1;
      const fault = state.writeFaults.shift();
      if (fault !== undefined) {
        state.clock += state.writeStepMs;
        throw Object.assign(new Error(), { code: fault });
      }
      state.requests.push(Buffer.from(bytes));
      return bytes.length;
    },
    closeSync: (fd: number): void => {
      if (fd === 7) state.closes += 1;
      else actual.closeSync(fd);
    },
  };
});

vi.mock("./process-scope.js", async (original) => ({
  ...(await original<typeof import("./process-scope.js")>()),
  readProcessNamespaceIds: (): readonly number[] => {
    state.namespaceReads += 1;
    return state.ids;
  },
}));

vi.mock("node:worker_threads", async (original) => ({
  ...(await original<typeof import("node:worker_threads")>()),
  get isMainThread(): boolean {
    return state.mainThread;
  },
}));

function frame(kind: number, pid: number, value: number): Buffer {
  const bytes = Buffer.alloc(20);
  bytes.write("KPI1");
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(kind, 6);
  bytes.writeUInt32LE(8, 8);
  bytes.writeUInt32LE(pid, 12);
  bytes.writeUInt32LE(value, 16);
  return bytes;
}

beforeEach(async () => {
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  state.frames = [];
  state.reads = 0;
  state.writes = 0;
  state.requests = [];
  state.closes = 0;
  state.socket = true;
  state.ids = [4321, process.pid];
  state.namespaceReads = 0;
  state.stats = 0;
  state.mainThread = true;
  state.readFaults = [];
  state.writeFaults = [];
  state.clock = 0;
  state.readStepMs = 0;
  state.writeStepMs = 0;
  ({ createNativeProcessScope } = await import("./native-process-scope.js"));
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe("native process coordinate consumer", () => {
  it.each(["initial-read", "reply-read", "request-write"])(
    "retains the selected channel after interrupted %s I/O",
    (stage) => {
      state.frames.push(frame(1, 4321, 5432), frame(3, 6789, 1));
      if (stage === "initial-read") state.readFaults = ["EINTR", "EINTR"];
      const port = createNativeProcessScope();
      if (stage === "reply-read") state.readFaults = ["EINTR", "EINTR"];
      if (stage === "request-write") state.writeFaults = ["EINTR", "EINTR"];
      expect(port.probe(6789)).toBe("alive");
      expect(port.observation?.()).toBe("ready");
      expect(state.requests).toHaveLength(1);
      expect(state.closes).toBe(0);
    },
  );

  it("retains exact held-file ownership after an interrupted metadata read", () => {
    state.frames.push(frame(1, 4321, 5432), metadataFrame(1));
    const port = createNativeProcessScope();
    state.readFaults = ["EINTR"];
    expect(port.fileOwnerUid?.(9, 123n, 456n, 0o40755n)).toBe(1000n);
    expect(port.observation?.()).toBe("ready");
    expect(state.requests).toHaveLength(1);
    expect(state.closes).toBe(0);
  });

  it("does not renew the initial identity grant after repeated interruptions", () => {
    state.frames.push(frame(1, 4321, 5432));
    state.readFaults = Array.from({ length: 10 }, () => "EINTR");
    state.readStepMs = 2000;
    vi.spyOn(performance, "now").mockImplementation(() => state.clock);
    expect(() => createNativeProcessScope()).toThrow();
    expect(state.clock).toBe(6000);
    expect(state.reads).toBe(3);
    expect(state.frames).toHaveLength(1);
    expect(state.closes).toBe(1);
    expect(() => createNativeProcessScope()).toThrow();
    expect([state.namespaceReads, state.stats, state.reads, state.closes]).toEqual([1, 1, 3, 1]);
  });

  it.each(["read", "write"])("expires interrupted %s I/O under the original deadline", (stage) => {
    state.frames.push(frame(1, 4321, 5432), frame(3, 6789, 1));
    const port = createNativeProcessScope();
    vi.spyOn(performance, "now").mockImplementation(() => state.clock);
    state.readStepMs = 2000;
    state.writeStepMs = 2000;
    if (stage === "read") state.readFaults = Array.from({ length: 10 }, () => "EINTR");
    else state.writeFaults = Array.from({ length: 10 }, () => "EINTR");
    expect(port.probe(6789)).toBe("unknown");
    expect(port.observation?.()).toBe("unavailable");
    expect(state.clock).toBe(6000);
    expect(state.frames).toHaveLength(1);
    expect(state.requests).toHaveLength(stage === "read" ? 1 : 0);
    const attempts = [state.reads, state.writes];
    expect(port.probe(6789)).toBe("unknown");
    expect([state.reads, state.writes]).toEqual(attempts);
    expect(state.closes).toBe(1);
  });

  it.each(["EAGAIN", "EIO", "EPERM"])("never retries a non-interruption %s", (code) => {
    state.frames.push(frame(1, 4321, 5432), frame(3, 6789, 1));
    const port = createNativeProcessScope();
    state.readFaults = [code];
    expect(port.probe(6789)).toBe("unknown");
    expect(port.observation?.()).toBe("unavailable");
    expect(state.reads).toBe(2);
    expect(state.frames).toHaveLength(1);
    expect(state.closes).toBe(1);
  });

  it("refuses Worker initialization before observing or touching the shared descriptor", () => {
    state.mainThread = false;
    state.frames.push(frame(1, 4321, 5432));
    expect(() => createNativeProcessScope()).toThrow();
    expect([state.namespaceReads, state.stats, state.reads, state.closes]).toEqual([0, 0, 0, 0]);
    state.mainThread = true;
    expect(createNativeProcessScope().observation?.()).toBe("ready");
  });

  it("refuses a second decoder without consuming or closing the selected port", () => {
    state.frames.push(frame(1, 4321, 5432), frame(3, 6789, 1));
    const port = createNativeProcessScope();
    expect(() => createNativeProcessScope()).toThrow();
    expect([state.namespaceReads, state.stats, state.reads, state.closes]).toEqual([1, 1, 1, 0]);
    expect(port.probe(6789)).toBe("alive");
    expect(port.observation?.()).toBe("ready");
  });

  it("never retries the one-shot identity after a malformed first initialization", () => {
    state.frames.push(frame(3, 4321, 5432));
    expect(() => createNativeProcessScope()).toThrow();
    state.frames.push(frame(1, 4321, 5432));
    expect(() => createNativeProcessScope()).toThrow();
    expect([state.namespaceReads, state.stats, state.reads, state.closes]).toEqual([1, 1, 1, 1]);
  });

  it("refuses an ordinary process before reading or closing the reserved descriptor", () => {
    state.ids = [process.pid];
    expect(() => createNativeProcessScope()).toThrow();
    expect(state.reads).toBe(0);
    expect(state.closes).toBe(0);
  });
  it("refuses an unrelated descriptor without closing a resource it does not own", () => {
    state.socket = false;
    expect(() => createNativeProcessScope()).toThrow();
    expect(state.closes).toBe(0);
    expect(state.reads).toBe(0);
  });
  it.each([0, 1000, 65534])(
    "retains the observed host UID %s without assigning ownership policy",
    (uid) => {
      state.frames.push(frame(1, 4321, 5432));
      const port = createNativeProcessScope(),
        metadata = Buffer.alloc(44);
      frame(7, 9, 1).copy(metadata);
      metadata.writeUInt32LE(32, 8);
      metadata.writeUInt32LE(uid, 20);
      metadata.writeUInt32LE(0o40755, 24);
      metadata.writeBigUInt64LE(123n, 28);
      metadata.writeBigUInt64LE(456n, 36);
      state.frames.push(metadata);
      expect(port.fileOwnerUid?.(9, 123n, 456n, 0o40755n)).toBe(BigInt(uid));
    },
  );

  it.each(["dev", "ino", "mode", "status", "unknown"])(
    "refuses an unproven %s metadata result",
    (fault) => {
      state.frames.push(frame(1, 4321, 5432));
      const port = createNativeProcessScope(),
        metadata = Buffer.alloc(44);
      frame(7, 9, fault === "unknown" ? 2 : fault === "status" ? 0 : 1).copy(metadata);
      metadata.writeUInt32LE(32, 8);
      metadata.writeUInt32LE(0o40755, 24);
      metadata.writeBigUInt64LE(fault === "dev" ? 999n : 123n, 28);
      metadata.writeBigUInt64LE(fault === "ino" ? 999n : 456n, 36);
      state.frames.push(metadata);
      expect(
        port.fileOwnerUid?.(9, 123n, 456n, fault === "mode" ? 0o40777n : 0o40755n),
      ).toBeUndefined();
    },
  );
  it("joins each liveness result to its exact requested outer identity", () => {
    state.frames.push(
      frame(1, 4321, 5432),
      frame(3, 6789, 1),
      frame(3, 6789, 2),
      frame(3, 6789, 3),
    );
    const port = createNativeProcessScope();
    expect(port.pid).toBe(4321);
    expect(port.probe(6789)).toBe("alive");
    expect(port.probe(6789)).toBe("dead");
    expect(port.probe(6789)).toBe("unknown");
    expect(state.closes).toBe(0);
  });

  it.each([0, 1, 2, 3])("rejects a high-bit mutation of magic byte %s", (index) => {
    const bytes = frame(1, 4321, 5432);
    bytes[index] = (bytes[index] ?? 0) | 0x80;
    state.frames.push(bytes);
    expect(() => createNativeProcessScope()).toThrow();
    expect(state.closes).toBe(1);
  });

  it.each(["magic", "version", "kind", "length", "short", "oversized", "identity"])(
    "refuses malformed initial %s",
    (fault) => {
      const bytes = frame(1, 4321, 5432);
      if (fault === "magic") bytes[0] = 0;
      if (fault === "version") bytes[4] = 2;
      if (fault === "kind") bytes[6] = 3;
      if (fault === "length") bytes[8] = 4;
      if (fault === "identity") bytes.writeUInt32LE(9999, 12);
      state.frames.push(
        fault === "short"
          ? bytes.subarray(0, 19)
          : fault === "oversized"
            ? Buffer.concat([bytes, Buffer.from([0])])
            : bytes,
      );
      expect(() => createNativeProcessScope()).toThrow();
      expect(state.closes).toBe(1);
    },
  );

  it("retires a failed port and never accepts a delayed response on a later request", () => {
    state.frames.push(frame(1, 4321, 5432));
    const port = createNativeProcessScope();
    expect(port.observation?.()).toBe("ready");
    expect(port.probe(6789)).toBe("unknown");
    expect(port.observation?.()).toBe("unavailable");
    state.frames.push(frame(3, 6789, 2));
    expect(port.probe(6789)).toBe("unknown");
    expect(state.writes).toBe(1);
    expect(state.reads).toBe(2);
    expect(state.closes).toBe(1);
  });

  it.each(["pid", "state", "late"])("refuses a mismatched or unqualified %s result", (fault) => {
    state.frames.push(frame(1, 4321, 5432));
    const port = createNativeProcessScope();
    state.frames.push(frame(3, fault === "pid" ? 1111 : 6789, fault === "state" ? 0 : 2));
    if (fault === "late")
      vi.spyOn(performance, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValue(6000);
    expect(port.probe(6789)).toBe("unknown");
    expect(state.closes).toBe(1);
  });
});

function metadataFrame(status: number, dev = 123n, ino = 456n, mode = 0o40755n): Buffer {
  const bytes = Buffer.alloc(44);
  frame(7, 9, status).copy(bytes);
  bytes.writeUInt32LE(32, 8);
  if (status === 1) {
    bytes.writeUInt32LE(1000, 20);
    bytes.writeUInt32LE(Number(mode), 24);
    bytes.writeBigUInt64LE(dev, 28);
    bytes.writeBigUInt64LE(ino, 36);
  }
  return bytes;
}

function corruptMetadata(metadata: Buffer, fault: string): void {
  if (fault === "dev") metadata.writeBigUInt64LE(999n, 28);
  if (fault === "ino") metadata.writeBigUInt64LE(999n, 36);
  if (fault === "mode") metadata.writeUInt32LE(0o40777, 24);
  if (fault === "status") metadata.writeUInt32LE(4, 16);
  if (fault === "target") metadata.writeUInt32LE(10, 12);
  if (fault === "kind") metadata.writeUInt16LE(5, 6);
  if (fault === "reserved-unavailable") metadata.writeUInt32LE(2, 16);
  if (fault === "reserved-stale") metadata.writeUInt32LE(3, 16);
}

describe("held file identity precondition", () => {
  it("sends lossless u64 identity in the closed conditional request", () => {
    state.frames.push(
      frame(1, 4321, 5432),
      metadataFrame(1, 0x20000000000001n, 0xffffffffffffffffn, 0o100600n),
    );
    const port = createNativeProcessScope();
    expect(port.fileOwnerUid?.(9, 0x20000000000001n, 0xffffffffffffffffn, 0o100600n)).toBe(1000n);
    expect(state.requests[0]?.toString("hex")).toBe(
      "4b5049310100060018000000090000000100000000002000ffffffffffffffff80810000",
    );
  });

  it.each([2, 3])("retains a healthy channel after a closed %s refusal", (status) => {
    state.frames.push(
      frame(1, 4321, 5432),
      metadataFrame(status),
      metadataFrame(1),
      frame(3, 6789, 1),
    );
    const port = createNativeProcessScope();
    expect(port.fileOwnerUid?.(9, 99n, 88n, 0o100600n)).toBeUndefined();
    expect(port.observation?.()).toBe("ready");
    expect(port.fileOwnerUid?.(9, 123n, 456n, 0o40755n)).toBe(1000n);
    expect(port.probe(6789)).toBe("alive");
    expect(state.closes).toBe(0);
  });

  it.each([
    "dev",
    "ino",
    "mode",
    "status",
    "target",
    "kind",
    "reserved-unavailable",
    "reserved-stale",
    "late",
  ])("retires an invalid %s reply without accepting a delayed follow-up", (fault) => {
    state.frames.push(frame(1, 4321, 5432));
    const port = createNativeProcessScope(),
      metadata = metadataFrame(1);
    corruptMetadata(metadata, fault);
    state.frames.push(metadata, metadataFrame(1));
    if (fault === "late")
      vi.spyOn(performance, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValue(6000);
    expect(port.fileOwnerUid?.(9, 123n, 456n, 0o40755n)).toBeUndefined();
    expect(port.observation?.()).toBe("unavailable");
    expect(port.fileOwnerUid?.(9, 123n, 456n, 0o40755n)).toBeUndefined();
    expect(state.writes).toBe(1);
    expect(state.closes).toBe(1);
  });

  it.each([
    [-1, 123n, 456n, 0o40755n],
    [0x80000000, 123n, 456n, 0o40755n],
    [1.5, 123n, 456n, 0o40755n],
    [9, -1n, 456n, 0o40755n],
    [9, 0x10000000000000000n, 456n, 0o40755n],
    [9, 123n, -1n, 0o40755n],
    [9, 123n, 0x10000000000000000n, 0o40755n],
    [9, 123n, 456n, -1n],
    [9, 123n, 456n, 0x100000000n],
  ] as const)(
    "refuses an out-of-range local tuple %s/%s/%s/%s before I/O",
    (descriptor, dev, ino, mode) => {
      state.frames.push(frame(1, 4321, 5432));
      const port = createNativeProcessScope();
      expect(port.fileOwnerUid?.(descriptor, dev, ino, mode)).toBeUndefined();
      expect(port.observation?.()).toBe("ready");
      expect(state.writes).toBe(0);
      expect(state.closes).toBe(0);
    },
  );
});
