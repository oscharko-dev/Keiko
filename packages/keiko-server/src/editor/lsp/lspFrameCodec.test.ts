import { describe, expect, it } from "vitest";

import {
  createLspFrameReader,
  LspFrameRejectError,
  writeLspFrame,
  type LspByteSink,
} from "./lspFrameCodec.js";

function frame(body: string): Buffer {
  const bytes = Buffer.from(body, "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${String(bytes.length)}\r\n\r\n`, "ascii"),
    bytes,
  ]);
}

async function* fromChunks(chunks: readonly Buffer[]): AsyncGenerator<Buffer, void, void> {
  await Promise.resolve();
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collect(source: AsyncGenerator<Buffer, void, void>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const body of source) {
    out.push(body);
  }
  return out;
}

describe("createLspFrameReader", () => {
  it("reads a single well-formed frame", async () => {
    const bodies = await collect(createLspFrameReader(fromChunks([frame('{"a":1}')]), 1024));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.toString("utf8")).toBe('{"a":1}');
  });

  it("reads multiple sequential frames from one chunk", async () => {
    const merged = Buffer.concat([frame('{"id":1}'), frame('{"id":2}'), frame('{"id":3}')]);
    const bodies = await collect(createLspFrameReader(fromChunks([merged]), 1024));
    expect(bodies.map((b) => b.toString("utf8"))).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
  });

  it("reassembles a frame delivered across split chunks", async () => {
    const whole = frame('{"hello":"world"}');
    const mid = Math.floor(whole.length / 2);
    const chunks = [whole.subarray(0, mid), whole.subarray(mid)];
    const bodies = await collect(createLspFrameReader(fromChunks(chunks), 1024));
    expect(bodies[0]?.toString("utf8")).toBe('{"hello":"world"}');
  });

  it("does not split a multi-byte UTF-8 character straddling a chunk boundary", async () => {
    const whole = frame('{"emoji":"😀"}');
    const splitInsideEmoji = whole.length - 2;
    const chunks = [whole.subarray(0, splitInsideEmoji), whole.subarray(splitInsideEmoji)];
    const bodies = await collect(createLspFrameReader(fromChunks(chunks), 1024));
    expect(bodies[0]?.toString("utf8")).toBe('{"emoji":"😀"}');
  });

  it("reads an empty body (Content-Length: 0)", async () => {
    const bodies = await collect(createLspFrameReader(fromChunks([frame("")]), 1024));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.length).toBe(0);
  });

  it("rejects a frame whose Content-Length exceeds maxFrameBytes before reading the body", async () => {
    const header = Buffer.from("Content-Length: 9999\r\n\r\n", "ascii");
    let captured: unknown;
    try {
      await collect(createLspFrameReader(fromChunks([header]), 16));
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(LspFrameRejectError);
    expect((captured as LspFrameRejectError).reason).toBe("RESPONSE_TOO_LARGE");
  });

  it("rejects a garbled header as MALFORMED_HEADER", async () => {
    const garbled = Buffer.from("Content-Bogus: nope\r\n\r\n{}", "ascii");
    let captured: unknown;
    try {
      await collect(createLspFrameReader(fromChunks([garbled]), 1024));
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(LspFrameRejectError);
    expect((captured as LspFrameRejectError).reason).toBe("MALFORMED_HEADER");
  });

  it("waits for more chunks when the header terminator has not yet arrived", async () => {
    const partialHeader = Buffer.from("Content-Length: 7\r\n", "ascii");
    const rest = Buffer.from('\r\n{"a":1}', "ascii");
    const bodies = await collect(createLspFrameReader(fromChunks([partialHeader, rest]), 1024));
    expect(bodies[0]?.toString("utf8")).toBe('{"a":1}');
  });

  it("yields nothing for an empty source", async () => {
    const bodies = await collect(createLspFrameReader(fromChunks([]), 1024));
    expect(bodies).toEqual([]);
  });

  it("accepts a frame exactly at the maxFrameBytes boundary", async () => {
    const body = '{"x":"ab"}';
    const bytes = Buffer.from(body, "utf8");
    const bodies = await collect(createLspFrameReader(fromChunks([frame(body)]), bytes.length));
    expect(bodies[0]?.toString("utf8")).toBe(body);
  });
});

describe("writeLspFrame", () => {
  it("writes a Content-Length header plus the body bytes", () => {
    let written: Buffer | undefined;
    const sink: LspByteSink = {
      write: (chunk) => {
        written = chunk;
      },
    };
    writeLspFrame(sink, '{"ok":true}');
    expect(written?.toString("ascii")).toBe('Content-Length: 11\r\n\r\n{"ok":true}');
  });

  it("uses UTF-8 byte length, not string length, for the Content-Length", () => {
    let written: Buffer | undefined;
    const sink: LspByteSink = {
      write: (chunk) => {
        written = chunk;
      },
    };
    const body = '{"e":"😀"}';
    writeLspFrame(sink, body);
    const expectedBytes = Buffer.from(body, "utf8").length;
    expect(written?.toString("utf8")).toBe(
      `Content-Length: ${String(expectedBytes)}\r\n\r\n${body}`,
    );
  });

  it("round-trips through the reader", async () => {
    const chunks: Buffer[] = [];
    const sink: LspByteSink = { write: (chunk) => chunks.push(chunk) };
    writeLspFrame(sink, '{"round":"trip"}');
    const bodies = await collect(createLspFrameReader(fromChunks(chunks), 1024));
    expect(bodies[0]?.toString("utf8")).toBe('{"round":"trip"}');
  });
});
