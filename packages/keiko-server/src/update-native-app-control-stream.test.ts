import { duplexPair, type Duplex } from "node:stream";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeNativeAppControlFrame } from "@oscharko-dev/keiko-contracts/runtime/native-runtime-wire";
import { NativeAppControlStream } from "./update-native-app-control-stream.js";

const streams: Duplex[] = [];

function fixture(): {
  readonly stream: NativeAppControlStream;
  readonly peer: Duplex;
  readonly socket: Duplex;
} {
  const [socket, peer] = duplexPair();
  streams.push(socket, peer);
  return { stream: new NativeAppControlStream(socket), peer, socket };
}

afterEach(() => {
  for (const stream of streams.splice(0)) stream.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("private native app control stream", () => {
  it("refuses an already cancelled request before sending or opening a receiver", async () => {
    const { stream, socket } = fixture();
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn();
    await expect(stream.read(performance.now() + 1000, send, controller.signal)).rejects.toThrow(
      "control-aborted",
    );
    expect(send).not.toHaveBeenCalled();
    expect(socket.listenerCount("data")).toBe(0);
  });

  it("settles caller cancellation and leaves the stream available for owned teardown", async () => {
    const { stream, peer, socket } = fixture();
    const controller = new AbortController();
    const reply = stream.read(performance.now() + 1000, undefined, controller.signal);
    controller.abort();
    await expect(reply).rejects.toThrow("control-aborted");
    expect(socket.listenerCount("data")).toBe(0);
    const cancelled = stream.read(performance.now() + 1000);
    peer.write(encodeNativeAppControlFrame(9, Buffer.alloc(32)));
    expect((await cancelled).kind).toBe(9);
  });

  it("assembles fragmented bytes and retains the next complete native frame", async () => {
    const { stream, peer } = fixture();
    const first = encodeNativeAppControlFrame(1, Buffer.alloc(40));
    const second = encodeNativeAppControlFrame(9, Buffer.alloc(32));
    const reply = stream.read(performance.now() + 1000);
    peer.write(first.subarray(0, 5));
    peer.write(Buffer.concat([first.subarray(5), second]));
    expect((await reply).kind).toBe(1);
    expect((await stream.read(performance.now() + 1000)).kind).toBe(9);
  });

  it("preserves a partial timed-out response for the original bounded cancellation", async () => {
    vi.useFakeTimers();
    const { stream, peer } = fixture();
    const started = encodeNativeAppControlFrame(3, Buffer.alloc(36));
    const cancelled = encodeNativeAppControlFrame(9, Buffer.alloc(32));
    const first = stream.read(performance.now() + 20).catch((error: unknown) => error);
    peer.write(started.subarray(0, 17));
    await vi.advanceTimersByTimeAsync(21);
    expect(await first).toMatchObject({ message: "native-app-control-response-timeout" });
    const resumed = stream.read(performance.now() + 1000);
    peer.write(Buffer.concat([started.subarray(17), cancelled]));
    expect((await resumed).kind).toBe(3);
    expect((await stream.read(performance.now() + 1000)).kind).toBe(9);
  });

  it("rejects expired receipt delivery even before the timer callback runs", async () => {
    const { stream, peer } = fixture();
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const reply = stream.read(200).catch((error: unknown) => error);
    clock = 201;
    peer.write(encodeNativeAppControlFrame(1, Buffer.alloc(40)));
    expect(await reply).toMatchObject({ message: "native-app-control-deadline-expired" });
  });

  it("rejects a concurrent reader without displacing the existing receiver", async () => {
    const { stream, peer } = fixture();
    const reply = stream.read(performance.now() + 1000);
    await expect(stream.read(performance.now() + 1000)).rejects.toThrow("unavailable");
    peer.write(encodeNativeAppControlFrame(1, Buffer.alloc(40)));
    expect((await reply).kind).toBe(1);
  });

  it("rejects an oversized advertised response before buffering its body", async () => {
    const { stream, peer } = fixture();
    const bytes = encodeNativeAppControlFrame(1, Buffer.alloc(40));
    bytes.writeUInt32LE(0xffffffff, 8);
    const reply = stream.read(performance.now() + 1000);
    peer.write(bytes.subarray(0, 12));
    await expect(reply).rejects.toThrow("protocol-refused");
    await expect(stream.read(performance.now() + 1000)).rejects.toThrow("protocol-refused");
  });

  it("refuses excess data under its fixed buffer ceiling", async () => {
    const { stream, peer } = fixture();
    const reply = stream.read(performance.now() + 1000);
    peer.write(Buffer.alloc(1000));
    await expect(reply).rejects.toThrow("protocol-refused");
  });

  it("settles EOF and removes the response listeners", async () => {
    const { stream, peer, socket } = fixture();
    const reply = stream.read(performance.now() + 1000);
    peer.end();
    await expect(reply).rejects.toThrow("control-ended");
    expect(socket.listenerCount("data")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    await expect(stream.read(performance.now() + 1000)).rejects.toThrow("unavailable");
  });

  it("owns an idle transport error and refuses the next exchange", async () => {
    const { stream, socket } = fixture();
    const failure = new Error("synthetic-transport-failure");
    expect(() => socket.emit("error", failure)).not.toThrow();
    await expect(stream.read(performance.now() + 1000)).rejects.toBe(failure);
  });

  it("settles a synchronous send refusal without leaving the reader or timer", async () => {
    vi.useFakeTimers();
    const { stream, socket } = fixture();
    await expect(
      stream.read(performance.now() + 1000, () => {
        throw new Error("synthetic-send-failure");
      }),
    ).rejects.toThrow("send-refused");
    expect(socket.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
