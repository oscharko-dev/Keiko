// Tests for NullOcrAdapter (Epic #189, Issue #202). Verifies the "never throws, always
// returns not-configured" contract.

import { describe, expect, it } from "vitest";

import { nullOcrAdapter } from "./null-ocr-adapter.js";

describe("nullOcrAdapter", () => {
  it("has kind 'ocr'", () => {
    expect(nullOcrAdapter.kind).toBe("ocr");
  });

  it("returns ok:false with reason ocr-not-configured for any input", async () => {
    const result = await nullOcrAdapter.ocrPage({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // PDF magic
      pageNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("ocr-not-configured");
  });

  it("returns ok:false for any pageNumber", async () => {
    const result = await nullOcrAdapter.ocrPage({
      bytes: new Uint8Array(0),
      pageNumber: 42,
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for empty bytes", async () => {
    const result = await nullOcrAdapter.ocrPage({
      bytes: new Uint8Array(0),
      pageNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("ocr-not-configured");
  });

  it("does not throw for any input", async () => {
    await expect(
      nullOcrAdapter.ocrPage({ bytes: new Uint8Array(1024).fill(0xff), pageNumber: 99 }),
    ).resolves.not.toThrow();
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(nullOcrAdapter)).toBe(true);
  });
});
