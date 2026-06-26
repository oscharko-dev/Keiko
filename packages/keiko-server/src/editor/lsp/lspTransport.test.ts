import { describe, expect, it } from "vitest";

import { createLspTransport } from "./lspTransport.js";
import { LspFrameRejectError } from "./lspFrameCodec.js";
import { createFakeLspProcess } from "./testing/fakeLspProcess.js";

// Flushes pending macrotasks: PassThrough delivers buffered chunks on the next event-loop turn, so a
// microtask drain is insufficient to observe a stderr count or an async responder reply.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("createLspTransport", () => {
  it("round-trips a request/response through a fake spawn handle", async () => {
    const fake = createFakeLspProcess({
      behavior: "normal",
      results: { "test/op": { value: 42 } },
    });
    const transport = createLspTransport(fake.handle, 1024 * 1024);
    const result = await transport.client.request<{ value: number }>(
      "test/op",
      {},
      {
        deadlineMs: 1000,
      },
    );
    expect(result).toEqual({ value: 42 });
    transport.dispose();
  });

  it("counts stderr bytes without exposing their content", async () => {
    const fake = createFakeLspProcess({ behavior: "normal" });
    const transport = createLspTransport(fake.handle, 1024 * 1024);
    fake.emitStderr("warning: nineteen-bytes");
    await settle();
    expect(transport.stderrBytesSeen()).toBe(Buffer.byteLength("warning: nineteen-bytes", "utf8"));
    transport.dispose();
  });

  it("accumulates stderr byte counts across multiple emissions", async () => {
    const fake = createFakeLspProcess({ behavior: "normal" });
    const transport = createLspTransport(fake.handle, 1024 * 1024);
    fake.emitStderr("aaa");
    fake.emitStderr("bbbb");
    await settle();
    expect(transport.stderrBytesSeen()).toBe(7);
    transport.dispose();
  });

  it("surfaces an oversized frame to onReaderError and stops reading", async () => {
    const fake = createFakeLspProcess({ behavior: "oversized", oversizedContentLength: 9_999_999 });
    let readerError: unknown;
    const transport = createLspTransport(fake.handle, 1024, {
      onReaderError: (error) => {
        readerError = error;
      },
    });
    const pending = transport.client.request("test/op", {}, { deadlineMs: 30 });
    await settle();
    await expect(pending).rejects.toThrow();
    expect(readerError).toBeInstanceOf(LspFrameRejectError);
    expect((readerError as LspFrameRejectError).reason).toBe("RESPONSE_TOO_LARGE");
    transport.dispose();
  });

  it("dispose rejects in-flight requests and is idempotent", async () => {
    const fake = createFakeLspProcess({ behavior: "slow" });
    const transport = createLspTransport(fake.handle, 1024 * 1024);
    const pending = transport.client.request("test/op", {}, { deadlineMs: 1000 });
    transport.dispose();
    transport.dispose();
    await expect(pending).rejects.toThrow();
  });
});

describe("createFakeLspProcess", () => {
  it("answers an initialize handshake", async () => {
    const fake = createFakeLspProcess({ behavior: "normal" });
    const transport = createLspTransport(fake.handle, 1024 * 1024);
    const result = await transport.client.request<{ capabilities: unknown }>(
      "initialize",
      {},
      {
        deadlineMs: 1000,
      },
    );
    expect(result).toHaveProperty("capabilities");
    transport.dispose();
  });

  it("ignores shutdown for the ignore-shutdown behavior", async () => {
    const fake = createFakeLspProcess({ behavior: "ignore-shutdown" });
    const transport = createLspTransport(fake.handle, 1024 * 1024);
    const pending = transport.client.request("shutdown", {}, { deadlineMs: 20 });
    await expect(pending).rejects.toThrow();
    transport.dispose();
  });

  it("emits an exit event on crash", () => {
    const fake = createFakeLspProcess({ behavior: "normal" });
    let exitCode: number | null = -1;
    fake.handle.onExit((code) => {
      exitCode = code;
    });
    fake.crash(1);
    expect(exitCode).toBe(1);
    expect(fake.exitEmitted()).toBe(true);
  });

  it("records kill signals and emits exit on SIGKILL", () => {
    const fake = createFakeLspProcess({ behavior: "ignore-shutdown" });
    fake.handle.kill("SIGTERM");
    fake.handle.kill("SIGKILL");
    expect(fake.killed()).toEqual(["SIGTERM", "SIGKILL"]);
    expect(fake.exitEmitted()).toBe(true);
  });

  it("handles an exit notification by emitting exit", async () => {
    const fake = createFakeLspProcess({ behavior: "normal" });
    const transport = createLspTransport(fake.handle, 1024 * 1024);
    transport.client.notify("exit", {});
    await settle();
    expect(fake.exitEmitted()).toBe(true);
    transport.dispose();
  });

  it("never lets an injected sentinel reach the stderr byte count", async () => {
    const sentinel = "SENTINEL-7f3a9c2e-DO-NOT-LEAK-0001";
    const fake = createFakeLspProcess({ behavior: "normal", sentinel });
    const transport = createLspTransport(fake.handle, 1024 * 1024);
    await settle();
    expect(transport.stderrBytesSeen()).toBe(Buffer.byteLength(sentinel, "utf8"));
    transport.dispose();
  });
});
