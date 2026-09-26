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
