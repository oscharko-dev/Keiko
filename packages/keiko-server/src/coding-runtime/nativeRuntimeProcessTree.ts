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

/** The operating system of the supervisor that answers on the control pipe. */
export type NativeRuntimeSupervisorPlatform = "win32" | "darwin" | "linux";

type RefusalWords = Readonly<Record<number, string>>;

// Each supervisor numbers its KRS1 refusals itself (`error_code` in its own
// keiko_runtime_supervisor.c), and the numbers overlap with other meanings: 6 is a grants frame on
// Windows, an unavailable monitor on macOS and an unavailable kernel facility on Linux. A refusal is
// therefore read with the table of the supervisor that sent it. Only the Windows words start with
// `supervisor-`; the run failure codes of supervisorRefusal.ts and the reap proof below are
// Windows statements and must never be drawn from another supervisor's number.
const WINDOWS_REFUSALS: RefusalWords = {
  1: "supervisor-protocol",
  2: "supervisor-job-create",
  3: "supervisor-process-create",
  4: "supervisor-job-assign",
  5: "supervisor-job-observe",
  6: "supervisor-grants-frame",
  7: "supervisor-grants-directory",
  8: "supervisor-grants-acl",
  9: "supervisor-grants-capability",
  10: "supervisor-gateway-connect",
  11: "supervisor-gateway-admit",
  // #4068 W1: the user environment key could not be closed to the tree.
  12: "supervisor-environment-guard",
  // #4068 (ADR-0043 D21): the relayed launch's own steps, all before the job exists.
  13: "supervisor-relay-frame",
  14: "supervisor-relay-profile",
  15: "supervisor-relay-start",
  // #4495: no interactive window station (an SSH or service session), and an image path too long
  // for a relayed tree's root. 16 and 17 are unused (#4496).
  18: "supervisor-no-desktop",
  19: "supervisor-image-path",
};

const MACOS_REFUSALS: RefusalWords = {
  1: "macos-supervisor-protocol",
  3: "macos-supervisor-process-create",
  5: "macos-supervisor-tree-observe",
  6: "macos-supervisor-monitor-unavailable",
  // KEIKO-0433: reconcile found the handle, but a live connection already owns that session.
  7: "macos-supervisor-tree-already-supervised",
};

const LINUX_REFUSALS: RefusalWords = {
  1: "linux-supervisor-protocol",
  3: "linux-supervisor-process-create",
  5: "linux-supervisor-tree-observe",
  6: "linux-supervisor-native-unavailable",
};

const SUPERVISOR_REFUSALS: Readonly<Record<NativeRuntimeSupervisorPlatform, RefusalWords>> = {
  win32: WINDOWS_REFUSALS,
  darwin: MACOS_REFUSALS,
  linux: LINUX_REFUSALS,
};

const UNKNOWN_REFUSAL: Readonly<Record<NativeRuntimeSupervisorPlatform, string>> = {
  win32: "supervisor-unknown",
  darwin: "macos-supervisor-unknown",
  linux: "linux-supervisor-unknown",
};

/** Every word a macOS or Linux supervisor refusal can read as; none is a Windows refusal. */
export const NON_WINDOWS_SUPERVISOR_REFUSALS: readonly string[] = Object.freeze([
  ...Object.values(MACOS_REFUSALS),
  ...Object.values(LINUX_REFUSALS),
  UNKNOWN_REFUSAL.darwin,
  UNKNOWN_REFUSAL.linux,
]);

// The refusals the Windows supervisor sends before it has created its job object, so before any
// process of the tree existed (windows/keiko_runtime_supervisor.c: the gateway, grants and
// environment steps and the job creation itself precede `launch_in_job`). `supervisor-protocol` is
// excluded because a reconcile helper answers it for a tree that may exist, and every refusal
// after the job exists (`process-create`, `job-assign`, `job-observe`, `gateway-admit`) leaves a
// tree that needs its own proof. Only a refusal named here, received before a launch response,
// proves nothing was left. The macOS and Linux supervisors are not in this set: their refusals
// prove nothing here, and their trees keep the proof they always needed.
const REFUSED_BEFORE_TREE_EXISTED: ReadonlySet<string> = new Set([
  "supervisor-job-create",
  "supervisor-grants-frame",
  "supervisor-grants-directory",
  "supervisor-grants-acl",
  "supervisor-grants-capability",
  "supervisor-gateway-connect",
  "supervisor-environment-guard",
  "supervisor-relay-frame",
  "supervisor-relay-profile",
  "supervisor-relay-start",
  "supervisor-no-desktop",
  "supervisor-image-path",
]);

/**
 * What a confined Windows supervisor's launch response states about its sweeps: the stale tree
 * entries (#4068) and the profiles of runs whose supervisor is gone (#4495).
 */
export interface NativeRuntimeLaunchSweep {
  readonly removed: number;
  readonly failed: number;
  readonly profilesRemoved: number;
  readonly profilesFailed: number;
}

/** What the supervisor of a tree reports about it, as it reports it. */
export interface NativeRuntimeTreeObserver {
  readonly launchSweep?: (sweep: NativeRuntimeLaunchSweep) => void;
  /** The tree's root exit code from the reap proof (#4495); a number, never text. */
  readonly reaped?: (rootExitCode: number) => void;
}

// A confined Windows launch response carries the sweeps' four counts; every other launch is empty.
const LAUNCH_SWEEP_BYTES = 16;

export class NativeRuntimeTree implements RuntimeProcessTree {
  public readonly treeId: string;
  public readonly stdin: Writable;
  public readonly stdout: Readable;
  public readonly stderr: Readable;
  private readonly exitCallbacks = new Set<(code: number | null) => void>();
  private readonly proofWaiters = new Set<(proved: boolean) => void>();
  private responseBytes = Buffer.alloc(0);
  private proved = false;
  // A launch response arrived: the supervisor created the tree, so no refusal can prove it absent.
  private launched = false;
  private ended = false;
  private refusal: string | undefined;
  private rootExit: number | undefined;
  // The helper exited but its control pipe has not closed yet: a proof may still arrive.
  private draining = false;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    recoveryHandle: string,
    private readonly child: NativeRuntimeHelperProcess,
    // Named by every caller: a refusal number means something else for each supervisor.
    private readonly supervisor: NativeRuntimeSupervisorPlatform,
    private readonly observer: NativeRuntimeTreeObserver = {},
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
    if (kind === 1 && this.acceptLaunchPacket(packet)) {
      this.launched = true;
      return;
    }
    if (kind === 2 && packet.length === RESPONSE_HEADER_BYTES + 8) {
      this.acceptRootExit(packet.readUInt32LE(RESPONSE_HEADER_BYTES));
      this.proved = packet.readUInt32LE(RESPONSE_HEADER_BYTES + 4) === 0;
      if (this.proved) this.resolveProofWaiters(true);
      return;
    }
    if (kind === 3 && packet.length === RESPONSE_HEADER_BYTES + 2) this.acceptRefusal(packet);
    this.finish(null);
  }

  private acceptRefusal(packet: Buffer): void {
    const words = SUPERVISOR_REFUSALS[this.supervisor];
    this.refusal =
      words[packet.readUInt16LE(RESPONSE_HEADER_BYTES)] ?? UNKNOWN_REFUSAL[this.supervisor];
    // The Windows supervisor itself states that it refused before creating the tree: there is
    // nothing to reap, so the run's start failure names the refusal instead of an unproven reap.
    if (!this.launched && REFUSED_BEFORE_TREE_EXISTED.has(this.refusal)) this.proved = true;
  }

  // Only the Windows supervisor's reap proof carries the root's exit code (#4495), and only the
  // first proof counts. The code is recorded as the number it is: the relay root's own failures are
  // values no runtime returns (gateway_relay.h), so the number itself names them.
  private acceptRootExit(code: number): void {
    if (this.supervisor !== "win32" || this.rootExit !== undefined) return;
    this.rootExit = code;
    this.observer.reaped?.(code);
  }

  // A launch response is the bare header or, on a confined Windows launch, the header and the
  // sweeps' four counts. Any other length is malformed and ends the tree.
  private acceptLaunchPacket(packet: Buffer): boolean {
    if (packet.length === RESPONSE_HEADER_BYTES) return true;
    if (packet.length !== RESPONSE_HEADER_BYTES + LAUNCH_SWEEP_BYTES) return false;
    this.observer.launchSweep?.({
      removed: packet.readUInt32LE(RESPONSE_HEADER_BYTES),
      failed: packet.readUInt32LE(RESPONSE_HEADER_BYTES + 4),
      profilesRemoved: packet.readUInt32LE(RESPONSE_HEADER_BYTES + 8),
      profilesFailed: packet.readUInt32LE(RESPONSE_HEADER_BYTES + 12),
    });
    return true;
  }

  /** The root's exit code from the Windows supervisor's reap proof, once it arrived (#4495). */
  public rootExitCode(): number | undefined {
    return this.rootExit;
  }

  /** The closed step at which the supervisor refused the tree, when it said so (#4068). */
  public failureReason(): string | undefined {
    return this.refusal;
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
