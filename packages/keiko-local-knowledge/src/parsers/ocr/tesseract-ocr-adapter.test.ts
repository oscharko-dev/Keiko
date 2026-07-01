import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_KNOWLEDGE_OCR_ENGINE_ENV,
  LOCAL_KNOWLEDGE_OCR_LANG_ENV,
  LOCAL_KNOWLEDGE_OCR_MAX_BYTES_ENV,
  LOCAL_KNOWLEDGE_OCR_TESSERACT_BIN_ENV,
  LOCAL_KNOWLEDGE_OCR_TIMEOUT_MS_ENV,
  createOcrAdapterFromEnv,
  createTesseractOcrAdapter,
  resolveOcrRuntimeFromEnv,
  type TesseractCommandRunner,
} from "./tesseract-ocr-adapter.js";

describe("createTesseractOcrAdapter", () => {
  it("runs the configured command runner and normalizes OCR stdout", async () => {
    const runner = vi.fn<TesseractCommandRunner>((_request) =>
      Promise.resolve({ ok: true, stdout: Buffer.from("  scanned text\f\n", "utf8") }),
    );
    const adapter = createTesseractOcrAdapter({
      command: "/usr/local/bin/tesseract",
      language: "deu",
      timeoutMs: 123,
      maxInputBytes: 100,
      extraArgs: ["--psm", "6"],
      runner,
    });

    const result = await adapter.ocrPage({ bytes: new Uint8Array([1, 2, 3]), pageNumber: 1 });

    expect(result).toEqual({ ok: true, text: "scanned text", confidence: 0 });
    expect(runner).toHaveBeenCalledWith({
      command: "/usr/local/bin/tesseract",
      args: ["stdin", "stdout", "-l", "deu", "--psm", "6"],
      stdin: new Uint8Array([1, 2, 3]),
      timeoutMs: 123,
    });
  });

  it("rejects empty and oversized inputs without invoking the engine", async () => {
    const runner = vi.fn<TesseractCommandRunner>(() =>
      Promise.resolve({ ok: true, stdout: Buffer.from("unused", "utf8") }),
    );
    const adapter = createTesseractOcrAdapter({ maxInputBytes: 2, runner });

    expect(await adapter.ocrPage({ bytes: new Uint8Array(0), pageNumber: 1 })).toEqual({
      ok: false,
      reason: "unsupported-input",
    });
    expect(await adapter.ocrPage({ bytes: new Uint8Array([1, 2, 3]), pageNumber: 1 })).toEqual({
      ok: false,
      reason: "unsupported-input",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("surfaces timeout and engine-error as OCR failures", async () => {
    const timeout = createTesseractOcrAdapter({
      runner: () => Promise.resolve({ ok: false, reason: "timeout" }),
    });
    const failing = createTesseractOcrAdapter({
      runner: () => Promise.resolve({ ok: false, reason: "engine-error" }),
    });

    expect(await timeout.ocrPage({ bytes: new Uint8Array([1]), pageNumber: 1 })).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(await failing.ocrPage({ bytes: new Uint8Array([1]), pageNumber: 1 })).toEqual({
      ok: false,
      reason: "engine-error",
    });
  });

  it("maps runner rejections to engine-error instead of throwing", async () => {
    const adapter = createTesseractOcrAdapter({
      runner: () => Promise.reject(new Error("spawn failed")),
    });

    await expect(adapter.ocrPage({ bytes: new Uint8Array([1]), pageNumber: 1 })).resolves.toEqual({
      ok: false,
      reason: "engine-error",
    });
  });

  it("passes AbortSignal through to the command runner", async () => {
    const controller = new AbortController();
    const runner = vi.fn<TesseractCommandRunner>((request) => {
      expect(request.signal).toBe(controller.signal);
      return Promise.resolve({ ok: true, stdout: Buffer.from("ok", "utf8") });
    });
    const adapter = createTesseractOcrAdapter({ runner });

    await adapter.ocrPage({
      bytes: new Uint8Array([1]),
      pageNumber: 1,
      signal: controller.signal,
    });

    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe("resolveOcrRuntimeFromEnv", () => {
  it("uses the null adapter when OCR is not configured", async () => {
    const adapter = createOcrAdapterFromEnv({});
    const result = await adapter.ocrPage({ bytes: new Uint8Array([1]), pageNumber: 1 });

    expect(result).toEqual({ ok: false, reason: "ocr-not-configured" });
  });

  it("creates a configured Tesseract adapter from env without requiring a real binary in tests", async () => {
    const runner = vi.fn<TesseractCommandRunner>(() =>
      Promise.resolve({ ok: true, stdout: Buffer.from("env text", "utf8") }),
    );
    const resolved = resolveOcrRuntimeFromEnv(
      {
        [LOCAL_KNOWLEDGE_OCR_ENGINE_ENV]: "tesseract",
        [LOCAL_KNOWLEDGE_OCR_TESSERACT_BIN_ENV]: "/opt/tesseract",
        [LOCAL_KNOWLEDGE_OCR_LANG_ENV]: "eng+deu",
        [LOCAL_KNOWLEDGE_OCR_TIMEOUT_MS_ENV]: "77",
        [LOCAL_KNOWLEDGE_OCR_MAX_BYTES_ENV]: "42",
      },
      { runner },
    );

    const result = await resolved.adapter.ocrPage({ bytes: new Uint8Array([9]), pageNumber: 1 });

    expect(resolved).toMatchObject({ engine: "tesseract", configured: true });
    expect(result).toEqual({ ok: true, text: "env text", confidence: 0 });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/opt/tesseract",
        args: ["stdin", "stdout", "-l", "eng+deu"],
        timeoutMs: 77,
      }),
    );
  });

  it("fails closed for an unsupported configured engine", async () => {
    const resolved = resolveOcrRuntimeFromEnv({ [LOCAL_KNOWLEDGE_OCR_ENGINE_ENV]: "remote" });
    const result = await resolved.adapter.ocrPage({ bytes: new Uint8Array([1]), pageNumber: 1 });

    expect(resolved).toMatchObject({ engine: "unsupported", configured: true });
    expect(result).toEqual({ ok: false, reason: "engine-error" });
  });
});
