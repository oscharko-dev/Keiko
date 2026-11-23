import { describe, expect, it } from "vitest";
import { isBenignMonacoCancellation } from "./monaco-cancellation.js";

function pageError(name: string, message: string, stack: string): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = stack;
  return error;
}

describe("isBenignMonacoCancellation", () => {
  // The release build's hashed chunk: no frame names Monaco (#4123, Firefox smoke on #4523).
  const HASHED =
    "Canceled: Canceled\n    at e (http://127.0.0.1:32183/_next/static/chunks/0f3a9c.js:1:2)";

  it("accepts Monaco's cancellation from a hashed release chunk", () => {
    expect(isBenignMonacoCancellation(pageError("Canceled", "Canceled", HASHED))).toBe(true);
  });

  it("accepts the console form and a development stack that names Monaco", () => {
    expect(isBenignMonacoCancellation(new Error("Canceled: Canceled"))).toBe(true);
    const dev =
      "Error: Canceled\n    at x (webpack-internal:///./node_modules/monaco-editor/esm/vs/editor/common.js:1:1)";
    expect(isBenignMonacoCancellation(pageError("Error", "Canceled", dev))).toBe(true);
  });

  it("stays strict for every other error", () => {
    expect(isBenignMonacoCancellation(pageError("Error", "Canceled", HASHED))).toBe(false);
    expect(isBenignMonacoCancellation(pageError("TypeError", "Canceled", HASHED))).toBe(false);
    expect(isBenignMonacoCancellation(pageError("Canceled", "Request canceled", HASHED))).toBe(
      false,
    );
    expect(isBenignMonacoCancellation(new Error("boom"))).toBe(false);
  });
});
