// #3390 audit F15: the launched-process-env helper is the only pure, directly testable piece of
// this harness entry point -- the rest of the file launches the real `keiko ui` production
// composition and is exercised by the live Playwright lane itself, never by a unit test. This
// proves the resolved, already-validated spend budget is threaded into the launched process env
// as the exact validated number, not a re-parse of the original (possibly differently formatted)
// environment string.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { defaultUiStaticRoot, launchedEnv } from "./coding-issue-journey-server.mjs";

describe("launchedEnv", () => {
  it("threads the resolved spend budget into the launched process env", () => {
    const result = launchedEnv(
      { PATH: "/usr/bin", KEIKO_QUALIFICATION_SPEND_BUDGET_USD: "bogus" },
      25,
    );
    expect(result.KEIKO_QUALIFICATION_SPEND_BUDGET_USD).toBe("25");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("does not mutate the base env", () => {
    const base = { KEIKO_QUALIFICATION_SPEND_BUDGET_USD: "10" };
    launchedEnv(base, 40);
    expect(base.KEIKO_QUALIFICATION_SPEND_BUDGET_USD).toBe("10");
  });
});

describe("defaultUiStaticRoot", () => {
  // Live-run bug: from the COMPILED location
  // (`tests/e2e/servers/dist/tests/e2e/servers/coding-issue-journey-server.mjs`), resolving the
  // repo root by walking up from `import.meta.url` lands on `tests/e2e/servers/dist`, doubling
  // the `dist` segment (`.../dist/dist/ui/static`) and making `keiko ui` refuse to start. The
  // fix takes the repository root as a plain parameter -- resolved by the caller from
  // `process.cwd()`, which Playwright's `webServer.cwd` always sets to the repo root -- so this
  // proves the resolution is correct for ANY repo root, independent of where the compiled file
  // itself lives.
  it("resolves the static root under the given repo root, never under a compiled-file-relative dist", () => {
    const repoRoot = "/Users/example/keiko-checkout";
    expect(defaultUiStaticRoot(repoRoot)).toBe(resolve(repoRoot, "dist", "ui", "static"));
  });

  it("never resolves relative to the compiled file's own dist directory", () => {
    // The regression: computing the root from `import.meta.url` of the compiled file yields
    // `.../tests/e2e/servers/dist` as the "repo root", which then doubles the `dist` segment.
    const buggyRepoRootFromCompiledFile = resolve(
      "/Users/example/keiko-checkout",
      "tests",
      "e2e",
      "servers",
      "dist",
    );
    const correctRepoRoot = "/Users/example/keiko-checkout";
    expect(defaultUiStaticRoot(correctRepoRoot)).toBe(
      resolve(correctRepoRoot, "dist", "ui", "static"),
    );
    expect(defaultUiStaticRoot(correctRepoRoot)).not.toBe(
      resolve(buggyRepoRootFromCompiledFile, "dist", "ui", "static"),
    );
  });
});
