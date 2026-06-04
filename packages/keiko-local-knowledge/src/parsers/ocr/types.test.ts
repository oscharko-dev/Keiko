// Types-only tests for OcrAdapter and OcrPageResult (Epic #189, Issue #202). These are
// structural / compile-time tests — no runtime logic is imported from types.ts because
// types.ts has no runtime exports. We use the type-pin pattern from the codebase standard
// (`_support.ts` `must<T>()` pattern) to verify the discriminated unions compile correctly.

import { describe, expect, it } from "vitest";

import type { OcrAdapter, OcrPageResult } from "./types.js";

// Type-pin helper: compile-time assertion that a value is assignable to T.
function pin<T>(_value?: T): T | undefined {
  return _value;
}

describe("OcrPageResult (type-level)", () => {
  it("accepts a valid success result", () => {
    const ok: OcrPageResult = { ok: true, text: "Hello page", confidence: 0.95 };
    expect(ok.ok).toBe(true);
  });

  it("accepts a valid not-configured failure", () => {
    const fail: OcrPageResult = { ok: false, reason: "ocr-not-configured" };
    expect(fail.ok).toBe(false);
  });

  it("accepts a timeout failure", () => {
    const fail: OcrPageResult = { ok: false, reason: "timeout" };
    expect(fail.ok).toBe(false);
  });

  it("accepts an unsupported-input failure", () => {
    const fail: OcrPageResult = { ok: false, reason: "unsupported-input" };
    expect(fail.ok).toBe(false);
  });

  it("exposes text and confidence on success variant", () => {
    const result: OcrPageResult = { ok: true, text: "x", confidence: 1 };
    expect(typeof result.text).toBe("string");
    expect(typeof result.confidence).toBe("number");
  });

  it("exposes reason on failure variant", () => {
    const result: OcrPageResult = { ok: false, reason: "ocr-not-configured" };
    expect(result.reason).toBe("ocr-not-configured");
  });
});

describe("OcrAdapter (type-level)", () => {
  it("satisfies the OcrAdapter interface structurally", () => {
    const adapter: OcrAdapter = {
      kind: "ocr",
      ocrPage: (_input) => Promise.resolve({ ok: false, reason: "ocr-not-configured" }),
    };
    expect(adapter.kind).toBe("ocr");
    pin<OcrAdapter>(adapter);
  });
});
