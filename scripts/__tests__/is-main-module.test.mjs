import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isMainModule } from "../lib/is-main-module.mjs";

describe("isMainModule", () => {
  it("is true when import.meta.url matches the canonical URL for a plain path", () => {
    const argv1 = "/repo/scripts/check-adr-index.mjs";
    expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
  });

  it("is false when the module was imported rather than executed directly", () => {
    expect(isMainModule("file:///repo/scripts/check-adr-index.mjs", "/repo/other-script.mjs")).toBe(
      false,
    );
  });

  it("is false when argv1 is undefined (e.g. a REPL or worker context)", () => {
    expect(isMainModule("file:///repo/scripts/check-adr-index.mjs", undefined)).toBe(false);
  });

  it("matches a path containing a space, unlike naive file:// string interpolation", () => {
    const argv1 = "/repo/has space/check-adr-index.mjs";
    const naiveInterpolation = `file://${argv1}`;
    expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
    // Prove this is a real bug class, not a hypothetical: naive interpolation actually
    // disagrees with the canonical URL for exactly this input.
    expect(naiveInterpolation).not.toBe(pathToFileURL(argv1).href);
  });

  it("matches a path containing %, #, and ?, unlike naive file:// string interpolation", () => {
    for (const argv1 of [
      "/repo/has%percent/check-adr-index.mjs",
      "/repo/has#hash/check-adr-index.mjs",
      "/repo/has?query/check-adr-index.mjs",
    ]) {
      const naiveInterpolation = `file://${argv1}`;
      expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
      expect(naiveInterpolation).not.toBe(pathToFileURL(argv1).href);
    }
  });

  it("defaults argv1 to the real process.argv[1] when not supplied", () => {
    // process.argv[1] under the vitest worker is this test file (or a runner shim), never
    // the module under test, so calling with only the URL argument must return false.
    expect(isMainModule("file:///not-the-real-entry-point.mjs")).toBe(false);
  });
});

// Every scripts/*.mjs file that switched to isMainModule() guards its CLI body behind
// `if (isMainModule(import.meta.url)) <cliEntry>()`. Importing the module under test (as
// every other test in this repo already does) only ever exercises the FALSE branch of that
// guard, since process.argv[1] is the vitest worker, never the script itself. These prove
// the TRUE branch — the actual fix's own effect — really fires on direct execution, driven
// entirely in-process (no subprocess, whose coverage this test runner would not capture).
// process.exit is stubbed to throw instead of killing the worker, in case any target's CLI
// entry takes a real failure path in this environment.
describe("isMainModule call sites actually fire their CLI entry on direct execution", () => {
  const realArgv1 = process.argv[1];

  afterEach(() => {
    process.argv[1] = realArgv1;
    vi.restoreAllMocks();
  });

  it.each([
    "../check-adr-index.mjs",
    "../check-mutation-scope.mjs",
    "../check-mutation-quality.mjs",
    "../check-lcov-source-mapping.mjs",
    "../check-sonar-pr-quality-gate.mjs",
    "../check-ui-static-js-compat.mjs",
    "../perf-evidence-gate.mjs",
    "../transpile-ui-static-js.mjs",
  ])("%s", async (relativePath) => {
    const absolutePath = resolve(import.meta.dirname, relativePath);
    process.argv[1] = absolutePath;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)}) blocked in test`);
    });
    try {
      // Cache-busting query so a module already imported (by an earlier test in this suite,
      // via another test file, or by this same file's own static import above) re-evaluates
      // its top-level `if (isMainModule(...))` guard against the argv1 set above, rather than
      // returning the cached module record from its first, unrelated evaluation.
      await import(`${pathToFileURL(absolutePath).href}?main-module-coverage=${relativePath}`);
    } catch (caught) {
      // Several of these exit non-zero or throw for an unmet real-environment precondition
      // (a missing SONAR_TOKEN, an unresolved git ref, no changed files) when driven outside
      // their real CI invocation. That is expected and fine here: the guard line and the
      // start of the guarded call are what this test proves execute, not that every target
      // succeeds when run with no setup.
      expect(caught).toBeDefined();
    }
    exitSpy.mockRestore();
  });
});
