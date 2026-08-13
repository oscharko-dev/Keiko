import { PassThrough, type Readable, type Writable } from "node:stream";

import { describe, expect, it } from "vitest";

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
  emitExit: (code: number | null) => void;
}

function harness(): HelperHarness {
  const stdin: Writable = new PassThrough();
  const stdout: Readable = new PassThrough();
  const stderr: Readable = new PassThrough();
  const controlInput: Writable = new PassThrough();
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
    h.emitExit(0);
    expect(exits).toEqual([0]);
    await expect(waiter).resolves.toBe(false);
    // A second waitForProof after the tree has ended immediately resolves false.
    await expect(tree.waitForProof(1_000)).resolves.toBe(false);
  });
});
