import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { createNativeProcessScope } from "./native-process-scope.js";

const state = vi.hoisted(() => ({
  frames: [] as Buffer[],
  reads: 0,
  writes: 0,
  closes: 0,
  socket: true,
  ids: [] as number[],
}));
const originalPlatform = process.platform;

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    fstatSync: (fd: number): unknown =>
      fd === 7 ? { isSocket: () => state.socket } : actual.fstatSync(fd),
    readSync: (fd: number, bytes: Buffer): number => {
      if (fd !== 7) throw new Error("unexpected descriptor");
      state.reads += 1;
      const frame = state.frames.shift();
      if (frame === undefined) throw Object.assign(new Error(), { code: "EAGAIN" });
      frame.copy(bytes);
      return frame.length;
    },
    writeSync: (fd: number, bytes: Buffer): number => {
      if (fd !== 7) throw new Error("unexpected descriptor");
      state.writes += 1;
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
  readProcessNamespaceIds: (): readonly number[] => state.ids,
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

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  state.frames = [];
  state.reads = 0;
  state.writes = 0;
  state.closes = 0;
  state.socket = true;
  state.ids = [4321, process.pid];
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe("native process coordinate consumer", () => {
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
      frame(5, 9, 1).copy(metadata);
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
      frame(5, 9, fault === "unknown" ? 2 : fault === "status" ? 0 : 1).copy(metadata);
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
