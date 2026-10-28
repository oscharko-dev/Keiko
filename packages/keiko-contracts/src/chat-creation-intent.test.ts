import { describe, expect, it } from "vitest";
import { isDesktopChatCreationRequestId } from "./bff-wire.js";

describe("opaque bounded chat creation identity", () => {
  it.each(["request-a", "window:legacy-window", "x".repeat(160)])("accepts %s", (value) => {
    expect(isDesktopChatCreationRequestId(value)).toBe(true);
  });

  it.each([
    undefined,
    null,
    false,
    12,
    {},
    [],
    "",
    "x".repeat(161),
    "bad/path",
    "bad\nvalue",
    "bad\u0000value",
    "Ａ",
    " padded",
    "padded ",
  ])("rejects %j", (value) => {
    expect(isDesktopChatCreationRequestId(value)).toBe(false);
  });
});
