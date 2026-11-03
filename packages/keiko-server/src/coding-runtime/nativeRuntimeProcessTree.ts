import { Readable, Writable } from "node:stream";

import {
  MAX_PACKET_BYTES,
  RESPONSE_HEADER_BYTES,
  encodeControlPacket,
  validResponsePayloadLength,
} from "./nativeRuntimeProcessProtocol.js";
import type { RuntimeProcessTree } from "./runtimeProcessSupervisor.js";

export interface NativeRuntimeHelperProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly controlInput: Writable;
  readonly controlOutput: Readable;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: () => void): void;
}

// After the helper's exit is observed, its control pipe may still hold the bytes it wrote just
// before exiting (the reap proof). They are accepted until the pipe closes, bounded by this grace
// so a pipe that never closes cannot hold a reap judgement open (audit 2026-10, finding 7).
const CONTROL_DRAIN_GRACE_MS = 2_000;

export class NativeRuntimeTree implements RuntimeProcessTree {
  public readonly treeId: string;
  public readonly stdin: Writable;
  public readonly stdout: Readable;
  public readonly stderr: Readable;
  private readonly exitCallbacks = new Set<(code: number | null) => void>();
  private readonly proofWaiters = new Set<(proved: boolean) => void>();
  private responseBytes = Buffer.alloc(0);
  private proved = false;
  private ended = false;
  // The helper exited but its control pipe has not closed yet: a proof may still arrive.
  private draining = false;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    recoveryHandle: string,
    private readonly child: NativeRuntimeHelperProcess,
  ) {
    this.treeId = recoveryHandle;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    child.controlOutput.on("data", (chunk: Buffer) => {
      this.acceptResponse(chunk);
    });
    const closed = (): void => {
      this.settleDrain();
    };
    child.controlOutput.once("end", closed);
    child.controlOutput.once("close", closed);
    // A pipe error means the helper is gone (EPIPE on a control write, EIO on a read); without a
    // listener it would be an unhandled error event that takes the server process down.
    child.controlOutput.on("error", () => {
      this.finish(null);
    });
    child.controlInput.on("error", () => {
      this.finish(null);
    });
    child.onExit((code) => {
      this.finish(code, true);
    });
    child.onError(() => {
      this.finish(null);
    });
  }

  public onTreeExit(callback: (code: number | null) => void): void {
    this.exitCallbacks.add(callback);
  }

  public sendControl(kind: 2 | 3): void {
    if (!this.ended) this.child.controlInput.write(encodeControlPacket(kind));
  }

  public hasReapProof(): boolean {
    return this.proved;
  }

  public waitForProof(timeoutMs: number): Promise<boolean> {
    if (this.proved) return Promise.resolve(true);
    if ((this.ended && !this.draining) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      return Promise.resolve(false);
    return new Promise((resolveProof) => {
      const settle = (proved: boolean): void => {
        clearTimeout(timer);
        this.proofWaiters.delete(settle);
        resolveProof(proved);
      };
      const timer = setTimeout(() => {
        settle(false);
      }, timeoutMs);
      this.proofWaiters.add(settle);
    });
  }

  private acceptResponse(chunk: Buffer): void {
    if (
      (this.ended && !this.draining) ||
      this.responseBytes.length + chunk.length > MAX_PACKET_BYTES
    ) {
      this.finish(null);
      return;
    }
    this.responseBytes = Buffer.concat([this.responseBytes, chunk]);
    this.parseResponses();
  }

  private parseResponses(): void {
    while (this.responseBytes.length >= RESPONSE_HEADER_BYTES) {
      const payloadLength = validResponsePayloadLength(this.responseBytes);
      if (payloadLength === undefined) {
        this.finish(null);
        return;
      }
      const packetLength = RESPONSE_HEADER_BYTES + payloadLength;
      if (this.responseBytes.length < packetLength) return;
      this.acceptResponsePacket(this.responseBytes.subarray(0, packetLength));
      this.responseBytes = this.responseBytes.subarray(packetLength);
    }
  }

  private acceptResponsePacket(packet: Buffer): void {
    const kind = packet.readUInt16LE(6);
    if (kind === 1 && packet.length === RESPONSE_HEADER_BYTES) return;
    if (kind === 2 && packet.length === RESPONSE_HEADER_BYTES + 8) {
      this.proved = packet.readUInt32LE(RESPONSE_HEADER_BYTES + 4) === 0;
      if (this.proved) this.resolveProofWaiters(true);
      return;
    }
    this.finish(null);
  }

  private finish(code: number | null, awaitControlDrain = false): void {
    if (this.ended) {
      // A violation or pipe error after the exit: no proof can follow, so stop waiting for one.
      if (!awaitControlDrain) this.settleDrain();
      return;
    }
    this.ended = true;
    if (awaitControlDrain && !this.controlClosed()) {
      this.draining = true;
      this.drainTimer = setTimeout(() => {
        this.settleDrain();
      }, CONTROL_DRAIN_GRACE_MS);
      this.drainTimer.unref();
    } else {
      this.resolveProofWaiters(this.proved);
    }
    for (const callback of this.exitCallbacks) callback(code);
  }

  private controlClosed(): boolean {
    const output = this.child.controlOutput;
    return output.readableEnded || output.destroyed;
  }

  private settleDrain(): void {
    if (!this.draining) return;
    this.draining = false;
    if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    this.resolveProofWaiters(this.proved);
  }

  private resolveProofWaiters(proved: boolean): void {
    for (const waiter of this.proofWaiters) waiter(proved);
  }
}
