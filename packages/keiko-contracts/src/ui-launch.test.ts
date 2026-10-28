import { describe, expect, it } from "vitest";
import { isKeikoUiLaunchId } from "./ui-launch.js";

describe("shared UI launch identity", () => {
  it.each(["0123456789abcdef0123456789abcdef", "f".repeat(32), "0".repeat(32)])(
    "accepts the exact lowercase hexadecimal identity %s",
    (value) => {
      expect(isKeikoUiLaunchId(value)).toBe(true);
    },
  );
  it.each([
    undefined,
    null,
    12,
    {},
    "",
    "a".repeat(31),
    "a".repeat(33),
    "A".repeat(32),
    "g".repeat(32),
    `${"a".repeat(32)}\n`,
    `\n${"a".repeat(32)}`,
    "a".repeat(31) + "\0",
  ])("rejects malformed or non-string identity %#", (value) => {
    expect(isKeikoUiLaunchId(value)).toBe(false);
  });
});
