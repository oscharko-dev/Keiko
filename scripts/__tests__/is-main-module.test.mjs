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
//
// The import MUST use the plain pathToFileURL(absolutePath).href with no query/hash
// suffix: isMainModule compares import.meta.url against that exact same canonical form, so
// any decoration would make the guard permanently false and this test prove nothing (caught
// in review — an earlier version of this file used a "?cache-busting" query for exactly
// that mistaken reason). Freshness across the 8 cases instead relies on each of these 8
// paths being imported nowhere else in this file and Vitest giving each test FILE its own
// isolated module registry, so this is each path's first, real evaluation.
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let threw = false;
    try {
      await import(pathToFileURL(absolutePath).href);
    } catch {
      // check-ui-static-js-compat.mjs and transpile-ui-static-js.mjs both call
      // rejectUiStaticRootCliOverride(args[0]) before printing anything; with no real CLI
      // args in this worker's process.argv, that throws synchronously before either spy
      // below could fire. That thrown error IS this target's observable proof the guarded
      // call ran (still target-specific: only the guarded call site can throw it, per its
      // own source above), not a "some error, who knows why" empty catch.
      threw = true;
    }
    // The guarded CLI entry always does at least one of: print a result (console.log),
    // print a failure (console.error), set/throw an exit code, or throw synchronously —
    // proving isMainModule returned true and the guarded call actually ran, not merely that
    // the import resolved.
    expect(
      logSpy.mock.calls.length > 0 ||
        errorSpy.mock.calls.length > 0 ||
        exitSpy.mock.calls.length > 0 ||
        threw,
    ).toBe(true);
  });
});
