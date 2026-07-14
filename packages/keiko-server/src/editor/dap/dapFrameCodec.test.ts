import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DapFrameRejectError, createDapFrameReader, writeDapFrame } from "./dapFrameCodec.js";

async function readOne(chunks: readonly Buffer[]): Promise<Buffer> {
  const frames: Buffer[] = [];
  for await (const frame of createDapFrameReader(Readable.from(chunks))) frames.push(frame);
  return frames[0] ?? Buffer.alloc(0);
}

describe("dapFrameCodec", () => {
  it("pins the maximum DAP payload to exactly 1 MiB", async () => {
    vi.resetModules();
    const codec = await import("./dapFrameCodec.js");
    expect(codec.DAP_MAX_PAYLOAD_BYTES).toBe(1_048_576);
  });

  it("uses exact content-free frame error metadata", () => {
    expect(new DapFrameRejectError("MALFORMED_HEADER")).toMatchObject({
      name: "DapFrameRejectError",
      message: "MALFORMED_HEADER",
      reason: "MALFORMED_HEADER",
    });
  });
  it("preserves a UTF-8 body split across chunks", async () => {
    const body = Buffer.from(JSON.stringify({ value: "Grüße" }), "utf8");
    const header = Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, "ascii");
    await expect(readOne([header, body.subarray(0, 4), body.subarray(4)])).resolves.toEqual(body);
  });

  it("rejects duplicate Content-Length headers", async () => {
    const source = Readable.from([
      Buffer.from("Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}", "ascii"),
    ]);
    await expect(async () => {
      for await (const _frame of createDapFrameReader(source)) void _frame;
    }).rejects.toMatchObject({ reason: "MALFORMED_HEADER" });
  });

  it("rejects a header over 8 KiB without buffering a body", async () => {
    const source = Readable.from([Buffer.alloc(8_193, 65)]);
    await expect(async () => {
      for await (const _frame of createDapFrameReader(source)) void _frame;
    }).rejects.toBeInstanceOf(DapFrameRejectError);
  });

  it("rejects a declared payload over 1 MiB before requesting a body chunk", async () => {
    let bodyPulled = false;
    async function* source(): AsyncGenerator<Buffer> {
      await Promise.resolve();
      yield Buffer.from("Content-Length: 1048577\r\n\r\n", "ascii");
      bodyPulled = true;
      yield Buffer.alloc(1);
    }
    await expect(async () => {
      for await (const _frame of createDapFrameReader(source())) void _frame;
    }).rejects.toMatchObject({ reason: "PAYLOAD_TOO_LARGE" });
    expect(bodyPulled).toBe(false);
  });

  it.each([
    Buffer.from("Content-Length: 10\r\n", "ascii"),
    Buffer.from("Content-Length: 10\r\n\r\nshort", "ascii"),
  ])("rejects truncated header or body at EOF", async (truncated) => {
    await expect(async () => {
      for await (const _frame of createDapFrameReader(Readable.from([truncated]))) void _frame;
    }).rejects.toMatchObject({ reason: "MALFORMED_HEADER" });
  });

  it("writes the UTF-8 byte length", () => {
    const chunks: Buffer[] = [];
    writeDapFrame({ write: (chunk) => void chunks.push(chunk) }, JSON.stringify({ value: "ü" }));
    expect(Buffer.concat(chunks).toString("utf8")).toBe('Content-Length: 14\r\n\r\n{"value":"ü"}');
  });

  it("preserves non-framing source failures", async () => {
    const failure = new Error("source failed");
    const source: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }),
    };
    await expect(async () => {
      for await (const _frame of createDapFrameReader(source)) void _frame;
    }).rejects.toBe(failure);
  });
});
