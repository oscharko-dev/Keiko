import { describe, expect, it } from "vitest";

import { assertManagedRootAllowed } from "./portable-root-policy.js";

describe("portable managed-root policy", () => {
  it("allows only the canonical macOS system application root", () => {
    expect(() => {
      assertManagedRootAllowed("/Applications/Keiko.app", "/Users/keiko/.keiko", "macos-arm64");
    }).not.toThrow();
    expect(() => {
      assertManagedRootAllowed("/Applications/Other.app", "/Users/keiko/.keiko", "macos-arm64");
    }).toThrow("user-local or the canonical Keiko macOS app");
  });

  // #4358 audit: the uninstall's helper rejects a bare share root through its own check; the policy
  // rejects it at the door as well, so no install root can be the root of a volume or share.
  it.each([
    ["windows-x64", "C:\\"],
    ["windows-x64", "D:/"],
    ["windows-x64", "\\\\server\\share"],
    ["windows-x64", "\\\\server\\share\\"],
    ["windows-x64", "/"],
    ["linux-x64", "/"],
    ["macos-arm64", "/"],
  ] as const)("rejects the root of a volume or share: %s %s", (target, root) => {
    expect(() => {
      assertManagedRootAllowed(root, "/Users/keiko/.keiko", target);
    }).toThrow("below a drive or share root");
  });

  it("does not take a directory below a drive or share root for a root", () => {
    for (const [target, root] of [
      ["windows-x64", String.raw`C:\Keiko`],
      ["windows-x64", String.raw`\\server\share\Keiko`],
    ] as const) {
      let message = "";
      try {
        assertManagedRootAllowed(root, "/Users/keiko/.keiko", target);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).not.toContain("below a drive or share root");
    }
  });

  it("rejects managed roots inside Keiko runtime state", () => {
    expect(() => {
      assertManagedRootAllowed("/Users/keiko/.keiko/managed", "/Users/keiko/.keiko", "windows-x64");
    }).toThrow("separate from .keiko runtime state");
  });

  it("rejects runtime state inside the managed root", () => {
    expect(() => {
      assertManagedRootAllowed(
        "/Users/keiko/Applications/Keiko",
        "/Users/keiko/Applications/Keiko/.keiko",
        "windows-x64",
      );
    }).toThrow("separate from .keiko runtime state");
  });
});
