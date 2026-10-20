import type { Duplex } from "node:stream";
import { performance } from "node:perf_hooks";
import {
  MAX_APP_CONTROL_PAYLOAD_BYTES,
  RESPONSE_HEADER_BYTES,
  decodeNativeAppControlFrame,
  nativeAppControlFrameLength,
  type NativeAppControlFrame,
} from "@oscharko-dev/keiko-contracts/runtime/native-runtime-wire";

interface PendingAppRead {
  readonly deadline: number;
  readonly resolve: (frame: NativeAppControlFrame) => void;
  readonly reject: (error: Error) => void;
  readonly onData: (chunk: Buffer) => void;
  readonly onError: (error: Error) => void;
  readonly onEnd: () => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

/** One private app-owner stream. Partial responses survive a bounded cancellation attempt. */
export class NativeAppControlStream {
  private buffered: Buffer = Buffer.alloc(0);
  private failure: Error | undefined;
  private reading = false;

  public constructor(private readonly socket: Duplex) {
    socket.pause();
    socket.on("error", (error: Error): void => {
      this.failure ??= error;
    });
  }

  public read(
    deadline: number,
    send?: () => void,
    signal?: AbortSignal,
  ): Promise<NativeAppControlFrame> {
    if (
      this.reading ||
      this.failure !== undefined ||
      this.socket.destroyed ||
      this.socket.readableEnded
    )
      return Promise.reject(this.failure ?? new Error("native-app-control-unavailable"));
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      return Promise.reject(new Error("native-app-control-deadline-expired"));
    if (signal?.aborted) return Promise.reject(new Error("native-app-control-aborted"));
    this.reading = true;
    return this.readResponse(deadline, send, signal);
  }

  public write(bytes: Buffer, deadline: number): void {
    if (this.failure !== undefined || this.socket.destroyed || performance.now() >= deadline)
      throw this.failure ?? new Error("native-app-control-write-refused");
    this.socket.write(bytes);
  }

  private takeFrame(): NativeAppControlFrame | undefined {
    if (this.buffered.length < RESPONSE_HEADER_BYTES) return undefined;
    const length = nativeAppControlFrameLength(this.buffered.subarray(0, RESPONSE_HEADER_BYTES));
    if (this.buffered.length < length) return undefined;
    const result = decodeNativeAppControlFrame(this.buffered.subarray(0, length));
    this.buffered = this.buffered.subarray(length);
    return result;
  }

  private receive(chunk: Buffer): NativeAppControlFrame | undefined {
    try {
      const maximum = 2 * (RESPONSE_HEADER_BYTES + MAX_APP_CONTROL_PAYLOAD_BYTES);
      if (this.buffered.length + chunk.length > maximum)
        throw new Error("native-app-control-buffer-refused");
      this.buffered = Buffer.concat([this.buffered, chunk]);
      return this.takeFrame();
    } catch (error) {
      this.failure = new Error("native-app-control-protocol-refused", { cause: error });
      throw this.failure;
    }
  }

  private readResponse(
    deadline: number,
    send?: () => void,
    signal?: AbortSignal,
  ): Promise<NativeAppControlFrame> {
    return new Promise((resolve, reject): void => {
      const reader: PendingAppRead = {
        deadline,
        resolve,
        reject,
        settled: false,
        timer: undefined,
        signal,
        onAbort: (): void => {
          this.finish(reader, new Error("native-app-control-aborted"));
        },
        onError: (error): void => {
          this.finish(reader, error);
        },
        onEnd: (): void => {
          this.finish(reader, new Error("native-app-control-ended"));
        },
        onData: (chunk): void => {
          this.onData(reader, chunk, reject);
        },
      };
      reader.timer = setTimeout(
        (): void => {
          this.finish(reader, new Error("native-app-control-response-timeout"));
        },
        Math.max(0, deadline - performance.now()),
      );
      this.attachReader(reader);
      if (signal?.aborted) {
        reader.onAbort();
        return;
      }
      try {
        send?.();
        this.onData(reader, Buffer.alloc(0), reject);
        if (!reader.settled) this.socket.resume();
      } catch (error) {
        this.detachReader(reader);
        throw new Error("native-app-control-send-refused", { cause: error });
      }
    });
  }

  private attachReader(reader: PendingAppRead): void {
    this.socket
      .on("data", reader.onData)
      .once("error", reader.onError)
      .once("end", reader.onEnd)
      .once("close", reader.onEnd);
    reader.signal?.addEventListener("abort", reader.onAbort, { once: true });
  }

  private onData(
    reader: PendingAppRead,
    chunk: Buffer,
    reject: Parameters<ConstructorParameters<PromiseConstructor>[0]>[1],
  ): void {
    if (reader.settled) return;
    try {
      const frame = this.receive(chunk);
      if (frame !== undefined) this.finish(reader, undefined, frame);
    } catch (error) {
      this.detachReader(reader);
      reject(error);
    }
  }

  private finish(reader: PendingAppRead, error?: Error, frame?: NativeAppControlFrame): void {
    if (!this.detachReader(reader)) return;
    if (error !== undefined) reader.reject(error);
    else if (frame === undefined || performance.now() >= reader.deadline)
      reader.reject(new Error("native-app-control-deadline-expired"));
    else reader.resolve(frame);
  }

  private detachReader(reader: PendingAppRead): boolean {
    if (reader.settled) return false;
    reader.settled = true;
    clearTimeout(reader.timer);
    reader.signal?.removeEventListener("abort", reader.onAbort);
    this.reading = false;
    this.socket.pause();
    this.socket.off("data", reader.onData);
    this.socket.off("error", reader.onError);
    this.socket.off("end", reader.onEnd);
    this.socket.off("close", reader.onEnd);
    return true;
  }
}
