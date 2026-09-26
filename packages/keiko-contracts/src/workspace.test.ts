// KEIKO-0398 — the workspace default option tables are shared singletons.
//
// The module header calls them "the frozen constant tables the type layer must expose as values",
// but they carried only an `as const` type assertion, which is erased at compile time and emits no
// runtime protection at all. Any consumer that mutated a field in place instead of spreading —
// an unsafe-cast TypeScript call site, or one of this repository's plain-JS consumers under
// scripts/ — silently corrupted the shared default for every other importer for the rest of the
// process. DEFAULT_CONTEXT_REQUEST.discovery is the same object reference as
// DEFAULT_DISCOVERY_OPTIONS, not a copy, so a mutation through either export corrupted both.
//
// These assertions run under ESM strict mode, where writing to a frozen object throws TypeError
// rather than failing silently.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_REQUEST,
  DEFAULT_DISCOVERY_OPTIONS,
  DEFAULT_READ_OPTIONS,
} from "./workspace.js";

describe("workspace default option tables", () => {
  it("freezes every exported default table at runtime", () => {
    expect(Object.isFrozen(DEFAULT_DISCOVERY_OPTIONS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_READ_OPTIONS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONTEXT_REQUEST)).toBe(true);
  });

  it("freezes the nested discovery options reachable through DEFAULT_CONTEXT_REQUEST", () => {
    // Same object identity, so freezing DEFAULT_DISCOVERY_OPTIONS covers both reachable paths.
    expect(DEFAULT_CONTEXT_REQUEST.discovery).toBe(DEFAULT_DISCOVERY_OPTIONS);
    expect(Object.isFrozen(DEFAULT_CONTEXT_REQUEST.discovery)).toBe(true);
  });

  it("throws instead of silently corrupting a shared default", () => {
    expect(() => {
      (DEFAULT_DISCOVERY_OPTIONS as { maxDepth: number }).maxDepth = 1;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_READ_OPTIONS as { maxBytes: number }).maxBytes = 1;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_CONTEXT_REQUEST as { budgetBytes: number }).budgetBytes = 1;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_CONTEXT_REQUEST.discovery as { maxFiles: number }).maxFiles = 1;
    }).toThrow(TypeError);
  });

  it("keeps the documented default values", () => {
    expect(DEFAULT_DISCOVERY_OPTIONS).toEqual({
      maxDepth: 40,
      maxFiles: 50_000,
      applyGitignore: true,
    });
    expect(DEFAULT_READ_OPTIONS).toEqual({ maxBytes: 262_144 });
    expect(DEFAULT_CONTEXT_REQUEST.budgetBytes).toBe(65_536);
    expect(DEFAULT_CONTEXT_REQUEST.maxBytesPerFile).toBe(8_192);
  });
});
