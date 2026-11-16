import { PassThrough, type Readable, type Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_PACKET_BYTES, RESPONSE_HEADER_BYTES } from "./nativeRuntimeProcessProtocol.js";
import { NativeRuntimeTree, type NativeRuntimeHelperProcess } from "./nativeRuntimeProcessTree.js";

// KEIKO-0347: the packet-framing / reassembly state machine had no direct co-located test —
// existing coverage exercised it only through the higher-level backend. These tests pin the
// three edges the machine is supposed to defend: a proof packet that arrives split across
// chunks must still be recognised, a packet whose framed payloadLength is illegal (> 64) must
// finish the tree, and a byte stream that exceeds MAX_PACKET_BYTES before yielding a valid
// packet must also finish the tree.

interface HelperHarness {
  readonly helper: NativeRuntimeHelperProcess;
  readonly controlOutput: PassThrough;
  readonly controlInput: PassThrough;
  emitExit: (code: number | null) => void;
}

function harness(): HelperHarness {
  const stdin: Writable = new PassThrough();
  const stdout: Readable = new PassThrough();
  const stderr: Readable = new PassThrough();
  const controlInput = new PassThrough();
  const controlOutput = new PassThrough();
  let emit: (code: number | null) => void = () => undefined;
  const helper: NativeRuntimeHelperProcess = {
    stdin,
    stdout,
    stderr,
    controlInput,
    controlOutput,
    onExit(listener): void {
      emit = listener;
    },
    onError(): void {
      // Never used in these tests; the class registers it internally.
    },
  };
  return {
    helper,
    controlOutput,
    controlInput,
    emitExit: (code): void => {
      emit(code);
    },
  };
}

function proofPacket(): Buffer {
  // KRS1 magic + protocol version 1 + kind 2 (reap proof) + payloadLength 8 + 8 bytes of body
  // where the last uint32 (offset RESPONSE_HEADER_BYTES + 4 = 16) encodes the proof outcome
  // (0 = proved).
  const header = Buffer.alloc(RESPONSE_HEADER_BYTES);
  header.write("KRS1", 0, "ascii");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(2, 6);
  header.writeUInt32LE(8, 8);
  const body = Buffer.alloc(8);
  // First uint32 unused, second uint32 = 0 → proved
  body.writeUInt32LE(0, 4);
  return Buffer.concat([header, body]);
}

describe("NativeRuntimeTree packet reassembly", () => {
  it("reassembles a reap-proof packet that arrives split across chunks", async () => {
    const h = harness();
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
    const packet = proofPacket();
    // Emit the packet in three progressively small chunks.
    h.controlOutput.emit("data", packet.subarray(0, 4));
    h.controlOutput.emit("data", packet.subarray(4, RESPONSE_HEADER_BYTES));
    expect(tree.hasReapProof()).toBe(false);
    h.controlOutput.emit("data", packet.subarray(RESPONSE_HEADER_BYTES));
    expect(tree.hasReapProof()).toBe(true);
    await expect(tree.waitForProof(10)).resolves.toBe(true);
  });

  it("wakes a pending waitForProof exactly once a split packet completes", async () => {
    const h = harness();
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
    const packet = proofPacket();
    h.controlOutput.emit("data", packet.subarray(0, 4));
    const waiter = tree.waitForProof(1_000);
    h.controlOutput.emit("data", packet.subarray(4));
    await expect(waiter).resolves.toBe(true);
  });

  it("finishes the tree on a byte stream that overflows MAX_PACKET_BYTES before a valid packet", () => {
    const h = harness();
    const exits: (number | null)[] = [];
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
    tree.onTreeExit((code) => exits.push(code));
    // Start a valid header — payloadLength 40 leaves a full packet of RESPONSE_HEADER_BYTES + 40 =
    // 52 bytes. Emit the header and the first bytes of the payload without ever completing the
    // packet, then push additional data until the accumulated buffer exceeds MAX_PACKET_BYTES.
    const header = Buffer.alloc(RESPONSE_HEADER_BYTES);
    header.write("KRS1", 0, "ascii");
    header.writeUInt16LE(1, 4);
    header.writeUInt16LE(2, 6);
    header.writeUInt32LE(40, 8);
    h.controlOutput.emit("data", header);
    // Push a large chunk of body bytes — but stop just short so parseResponses does not accept.
    h.controlOutput.emit("data", Buffer.alloc(20));
    expect(exits).toEqual([]);
    // Now overflow: a very large chunk pushes total accumulated bytes past MAX_PACKET_BYTES.
    h.controlOutput.emit("data", Buffer.alloc(MAX_PACKET_BYTES + 1));
    expect(exits).toEqual([null]);
    expect(tree.hasReapProof()).toBe(false);
  });

  it("finishes the tree on a framed packet whose payloadLength exceeds the 64-byte cap", () => {
    const h = harness();
    const exits: (number | null)[] = [];
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
    tree.onTreeExit((code) => exits.push(code));
    const header = Buffer.alloc(RESPONSE_HEADER_BYTES);
    header.write("KRS1", 0, "ascii");
    header.writeUInt16LE(1, 4);
    header.writeUInt16LE(2, 6);
    // 65 > validResponsePayloadLength's cap of 64 → parseResponses finishes.
    header.writeUInt32LE(65, 8);
    h.controlOutput.emit("data", header);
    expect(exits).toEqual([null]);
  });

  it("finishes the tree on a header whose magic string is not KRS1", () => {
    const h = harness();
    const exits: (number | null)[] = [];
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
    tree.onTreeExit((code) => exits.push(code));
    const header = Buffer.alloc(RESPONSE_HEADER_BYTES);
    header.write("XXXX", 0, "ascii");
    header.writeUInt16LE(1, 4);
    header.writeUInt16LE(2, 6);
    header.writeUInt32LE(0, 8);
    h.controlOutput.emit("data", header);
    expect(exits).toEqual([null]);
  });

  it("forwards a child exit to onTreeExit and resolves pending waiters with the current proof state", async () => {
    const h = harness();
    const exits: (number | null)[] = [];
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
    tree.onTreeExit((code) => exits.push(code));
    const waiter = tree.waitForProof(1_000);
    // A real helper's control pipe is closed once it has exited; nothing more can arrive.
    h.controlOutput.end();
    h.emitExit(0);
    expect(exits).toEqual([0]);
    await expect(waiter).resolves.toBe(false);
    // A second waitForProof after the tree has ended immediately resolves false.
    await expect(tree.waitForProof(1_000)).resolves.toBe(false);
  });

  // Audit finding 7: the helper's `exit` can be observed before the last bytes of its control pipe
  // have been read, so a reap proof written just before exiting was discarded and a clean reap was
  // judged unproven. The proof is now accepted until the control pipe closes (bounded by a grace).
  it("accepts a reap proof that is read after the helper exit was observed", async () => {
    const h = harness();
    const exits: (number | null)[] = [];
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
    tree.onTreeExit((code) => exits.push(code));
    const waiter = tree.waitForProof(1_000);

    h.emitExit(0);
    expect(exits).toEqual([0]);
    h.controlOutput.write(proofPacket());
    h.controlOutput.end();

    await expect(waiter).resolves.toBe(true);
    expect(tree.hasReapProof()).toBe(true);
    await expect(tree.waitForProof(10)).resolves.toBe(true);
  });

  it("settles an unproven reap once the closed control pipe delivered nothing", async () => {
    const h = harness();
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
    const waiter = tree.waitForProof(1_000);

    h.emitExit(0);
    h.controlOutput.end();

    await expect(waiter).resolves.toBe(false);
    expect(tree.hasReapProof()).toBe(false);
  });

  describe("with a control pipe that never closes", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("stops waiting for a proof after a bounded grace", async () => {
      vi.useFakeTimers();
      const h = harness();
      const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
      const waiter = tree.waitForProof(60_000);

      h.emitExit(0);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(waiter).resolves.toBe(false);
    });
  });

  it("treats a failed write to the control pipe as the end of the helper, not an unhandled error", () => {
    const h = harness();
    const exits: (number | null)[] = [];
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
    tree.onTreeExit((code) => exits.push(code));

    expect(() => h.controlInput.emit("error", new Error("EPIPE"))).not.toThrow();

    expect(exits).toEqual([null]);
    expect(() => {
      tree.sendControl(2);
    }).not.toThrow();
  });

  it("treats an error on the control output pipe as the end of the helper", () => {
    const h = harness();
    const exits: (number | null)[] = [];
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
    tree.onTreeExit((code) => exits.push(code));

    expect(() => h.controlOutput.emit("error", new Error("EIO"))).not.toThrow();

    expect(exits).toEqual([null]);
  });
});

// #4068: the supervisor names the step that refused a confined tree. The host recorded every such
// refusal as exit code `signal`, so a broker or grant failure on Windows left no reason in the log.
describe("NativeRuntimeTree supervisor refusals", () => {
  function refusalPacket(code: number): Buffer {
    const header = Buffer.alloc(RESPONSE_HEADER_BYTES);
    header.write("KRS1", 0, "ascii");
    header.writeUInt16LE(1, 4);
    header.writeUInt16LE(3, 6);
    header.writeUInt32LE(2, 8);
    const body = Buffer.alloc(2);
    body.writeUInt16LE(code, 0);
    return Buffer.concat([header, body]);
  }

  it.each([
    [1, "supervisor-protocol"],
    [3, "supervisor-process-create"],
    [7, "supervisor-grants-directory"],
    [10, "supervisor-gateway-connect"],
    [11, "supervisor-gateway-admit"],
    [12, "supervisor-environment-guard"],
    [99, "supervisor-unknown"],
  ])("names refusal code %i as %s and ends the tree", (code, reason) => {
    const h = harness();
    const exits: (number | null)[] = [];
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper);
    tree.onTreeExit((exit) => exits.push(exit));
    expect(tree.failureReason()).toBeUndefined();
    h.controlOutput.emit("data", refusalPacket(code));
    expect(tree.failureReason()).toBe(reason);
    expect(exits).toEqual([null]);
  });
});

// #4068 B1 crash rule: a confined Windows launch response states what its stale-grant sweep
// removed and could not remove; every other launch response stays empty.
describe("NativeRuntimeTree launch responses", () => {
  function launchedPacket(payload: Buffer): Buffer {
    const header = Buffer.alloc(RESPONSE_HEADER_BYTES);
    header.write("KRS1", 0, "ascii");
    header.writeUInt16LE(1, 4);
    header.writeUInt16LE(1, 6);
    header.writeUInt32LE(payload.length, 8);
    return Buffer.concat([header, payload]);
  }

  function sweepPayload(removed: number, failed: number): Buffer {
    const payload = Buffer.alloc(8);
    payload.writeUInt32LE(removed, 0);
    payload.writeUInt32LE(failed, 4);
    return payload;
  }

  it("hands a confined launch's sweep counts to the backend and keeps the tree running", () => {
    const h = harness();
    const sweeps: unknown[] = [];
    const exits: (number | null)[] = [];
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper, (sweep) => sweeps.push(sweep));
    tree.onTreeExit((exit) => exits.push(exit));
    h.controlOutput.emit("data", launchedPacket(sweepPayload(3, 1)));
    expect(sweeps).toEqual([{ removed: 3, failed: 1 }]);
    expect(exits).toEqual([]);
  });

  it("accepts an empty launch response without a sweep", () => {
    const h = harness();
    const sweeps: unknown[] = [];
    const exits: (number | null)[] = [];
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper, (sweep) => sweeps.push(sweep));
    tree.onTreeExit((exit) => exits.push(exit));
    h.controlOutput.emit("data", launchedPacket(Buffer.alloc(0)));
    expect(sweeps).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("ends the tree on a launch response of any other length", () => {
    const h = harness();
    const exits: (number | null)[] = [];
    const tree = new NativeRuntimeTree("a".repeat(32), h.helper, () => undefined);
    tree.onTreeExit((exit) => exits.push(exit));
    h.controlOutput.emit("data", launchedPacket(Buffer.alloc(4)));
    expect(exits).toEqual([null]);
  });
});
