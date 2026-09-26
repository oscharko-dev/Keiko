import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  CODING_RUNTIME_MAX_LINE_BYTES,
  createCodingRuntimeLineParser,
  createCodingRuntimeStderrDrainer,
} from "./codingRuntimeProcessIo.js";

describe("coding runtime process I/O", () => {
  it("delivers newline-delimited stdout records", () => {
    const records: string[] = [];
    const parser = createCodingRuntimeLineParser({ onLine: (line) => records.push(line) });

    expect(parser.push(Buffer.from('{"ready":true}\n', "utf8"))).toEqual({ ok: true });
    expect(records).toEqual(['{"ready":true}']);
  });

  it("drains every complete record before rejecting an oversized remainder", () => {
    const records: string[] = [];
    const parser = createCodingRuntimeLineParser({ onLine: (line) => records.push(line) });
    const input = Buffer.concat([
      Buffer.from("first\nsecond\r\n", "utf8"),
      Buffer.alloc(CODING_RUNTIME_MAX_LINE_BYTES + 1, 0x61),
    ]);

    expect(parser.push(input)).toEqual({ ok: false, reason: "line-oversized" });
    expect(records).toEqual(["first", "second"]);
  });

  it("fails closed for malformed UTF-8, oversized complete records, and terminal partial records", () => {
    const malformed = createCodingRuntimeLineParser({ onLine: vi.fn() });
    const oversized = createCodingRuntimeLineParser({ onLine: vi.fn() });
    const terminal = createCodingRuntimeLineParser({ onLine: vi.fn() });
    const invalidTerminal = createCodingRuntimeLineParser({ onLine: vi.fn() });

    expect(malformed.push(Buffer.from([0xc3, 0x28, 0x0a]))).toEqual({
      ok: false,
      reason: "utf8-invalid",
    });
    expect(
      oversized.push(
        Buffer.concat([Buffer.alloc(CODING_RUNTIME_MAX_LINE_BYTES + 1, 0x61), Buffer.of(0x0a)]),
      ),
    ).toEqual({ ok: false, reason: "line-oversized" });
    expect(terminal.push(Buffer.from("tail", "utf8"))).toEqual({ ok: true });
    expect(terminal.finish()).toEqual({ ok: true });
    expect(invalidTerminal.push(Buffer.of(0xc3))).toEqual({ ok: true });
    expect(invalidTerminal.finish()).toEqual({ ok: false, reason: "utf8-invalid" });
  });

  it("preserves split UTF-8 code points, handles empty chunks, and flushes a terminal record", () => {
    const records: string[] = [];
    const parser = createCodingRuntimeLineParser({ onLine: (line) => records.push(line) });
    const emoji = Buffer.from("😀", "utf8");

    expect(parser.push(Buffer.alloc(0))).toEqual({ ok: true });
    expect(parser.push(emoji.subarray(0, 2))).toEqual({ ok: true });
    expect(
      parser.push(Buffer.concat([emoji.subarray(2), Buffer.from("\r\nlast", "utf8")])),
    ).toEqual({
      ok: true,
    });
    expect(parser.finish()).toEqual({ ok: true });
    expect(records).toEqual(["😀", "last"]);
  });

  it("KEIKO-0741: a stderr chunk exactly filling the remaining byte budget is NOT marked truncated", () => {
    // addCount's boundary was `<` -- a chunk exactly equal to the remaining budget fell through
    // to `this.truncated = true`. It must be `<=` so the exact-fit case fits without being marked
    // truncated or overflowed. saturatingCount's overflow check (`>`) is unchanged.
    const drainer = createCodingRuntimeStderrDrainer({ maxBytes: 64, maxLines: 4 });
    drainer.push(Buffer.alloc(64, "x"));
    const state = drainer.snapshot();
    expect(state.bytes).toBe(64);
    expect(state.truncated).toBe(false);
    expect(state.overflowed).toBe(false);
    // One-byte overflow past the budget still trips both flags.
    drainer.push(Buffer.from("y"));
    const overflowed = drainer.snapshot();
    expect(overflowed.bytes).toBe(64);
    expect(overflowed.truncated).toBe(true);
    expect(overflowed.overflowed).toBe(true);
  });

  it("drains a 1 MiB stderr producer without retaining producer content or buffering it", () => {
    const summaries: unknown[] = [];
    const drainer = createCodingRuntimeStderrDrainer({
      maxBytes: 64,
      maxLines: 4,
      summaryIntervalBytes: 16,
      onSummary: (summary) => summaries.push(summary),
    });
    const sentinel = "stderr-sentinel-process-io";
    const stderr = new PassThrough({ highWaterMark: 1024 });
    stderr.on("data", (chunk: Buffer) => {
      drainer.push(chunk);
    });
    const producerChunk = `${sentinel}\n`.padEnd(1024, "x");

    for (let index = 0; index < 1024; index += 1) stderr.write(producerChunk);
    const state = drainer.snapshot();

    expect(stderr.readableLength).toBe(0);
    expect(stderr.writableLength).toBe(0);
    expect(state).toMatchObject({ bytes: 64, lines: 4, truncated: true, overflowed: true });
    expect(summaries).not.toHaveLength(0);
    expect(JSON.stringify({ state, summaries })).not.toContain(sentinel);
  });
});
