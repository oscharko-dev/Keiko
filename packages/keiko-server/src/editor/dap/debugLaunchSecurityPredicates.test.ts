import { describe, expect, it } from "vitest";
import {
  isSafeDapSocketBasename,
  isSafeDebugScriptName,
  isSha256Digest,
  isSupportedNodeDebugExtension,
} from "./debugLaunchSecurityPredicates.js";

describe("debug launch security predicates", () => {
  it("accepts only an exact lowercase SHA-256 digest", () => {
    for (const character of ["0", "9", "a", "f"]) {
      expect(isSha256Digest(character.repeat(64))).toBe(true);
    }
    for (const value of [
      "a".repeat(63),
      "a".repeat(65),
      `/${"a".repeat(63)}`,
      `:${"a".repeat(63)}`,
      `@${"a".repeat(63)}`,
      `A${"a".repeat(63)}`,
      `g${"a".repeat(63)}`,
      `-${"a".repeat(63)}`,
      `${"a".repeat(63)}\n`,
    ]) {
      expect(isSha256Digest(value)).toBe(false);
    }
  });

  it("accepts only closed normalized npm script names", () => {
    for (const value of [
      "0",
      "9",
      "A",
      "Z",
      "a",
      "z",
      "build",
      "test:unit",
      "lint.fix",
      "build_ui-2",
    ]) {
      expect(isSafeDebugScriptName(value)).toBe(true);
    }
    for (const value of [
      "",
      "-build",
      ".build",
      ":build",
      "@build",
      "[build",
      "`build",
      "{build",
      "build/",
      "build!",
      "build script",
      "build\n",
    ]) {
      expect(isSafeDebugScriptName(value)).toBe(false);
    }
  });

  it("accepts only a non-empty safe basename with one exact socket suffix", () => {
    for (const value of [
      "0.sock",
      "9.sock",
      "A.sock",
      "Z.sock",
      "a.sock",
      "z.sock",
      "debug-1.sock",
      "debug_name.sock",
      "debug.name.sock",
    ]) {
      expect(isSafeDapSocketBasename(value)).toBe(true);
    }
    for (const value of [
      "",
      ".sock",
      "dap",
      "dap.socket",
      "dap.sock/extra",
      "dap!.sock",
      "dap/.sock",
      "dap@.sock",
      "dap[.sock",
      "dap`.sock",
      "dap{.sock",
      "dap sock",
      "dap.sock\n",
    ]) {
      expect(isSafeDapSocketBasename(value)).toBe(false);
    }
  });

  it("accepts exactly the supported Node and TypeScript extensions", () => {
    for (const extension of [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".JS", ".TS"]) {
      expect(isSupportedNodeDebugExtension(extension)).toBe(true);
    }
    for (const extension of ["", ".jsx", ".tsx", ".json", ".md", "js", ".js "]) {
      expect(isSupportedNodeDebugExtension(extension)).toBe(false);
    }
  });
});
