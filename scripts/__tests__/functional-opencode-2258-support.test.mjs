import { describe, expect, it } from "vitest";

import { functionalOpenCodePlatformTarget } from "../functional-opencode-2258-support.mjs";

describe("functional OpenCode #2258 staging", () => {
  it.each([
    ["darwin", "arm64", "macos-arm64"],
    ["darwin", "x64", "macos-x64"],
    ["win32", "x64", "windows-x64"],
    ["linux", "x64", "unsupported"],
    ["win32", "arm64", "unsupported"],
  ])("maps %s/%s to the approved target %s", (platform, arch, expected) => {
    expect(functionalOpenCodePlatformTarget(platform, arch)).toBe(expected);
  });
});
