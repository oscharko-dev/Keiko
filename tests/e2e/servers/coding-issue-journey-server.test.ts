// #3390 audit F15: the launched-process-env helper is the only pure, directly testable piece of
// this harness entry point -- the rest of the file launches the real `keiko ui` production
// composition and is exercised by the live Playwright lane itself, never by a unit test. This
// proves the resolved, already-validated spend budget is threaded into the launched process env
// as the exact validated number, not a re-parse of the original (possibly differently formatted)
// environment string.
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { SESSION_PAIRING_LAUNCHER_SECRET_ENV } from "@oscharko-dev/keiko-server";

import {
  defaultStateDir,
  defaultUiStaticRoot,
  evaluationLocalGitMutationEnv,
  launchedEnv,
  resolveLauncherSecret,
} from "./coding-issue-journey-server.mjs";

describe("launchedEnv", () => {
  it("isolates only the governed Git subprocess HOME for evaluation", () => {
    const base = { HOME: "/host/home", PATH: "/usr/bin" };
    const gitEnv = evaluationLocalGitMutationEnv(base, "/private/evaluation-home");

    expect(gitEnv).toEqual({ HOME: "/private/evaluation-home", PATH: "/usr/bin" });
    expect(base.HOME).toBe("/host/home");
    expect(evaluationLocalGitMutationEnv(base, undefined)).toBeUndefined();
    expect(() => evaluationLocalGitMutationEnv(base, "relative/home")).toThrow(
      "qualification-git-identity-home-invalid",
    );
  });

  it("threads the resolved spend budget into the launched process env", () => {
    const result = launchedEnv(
      {
        PATH: "/usr/bin",
        KEIKO_QUALIFICATION_SPEND_BUDGET_USD: "bogus",
        KEIKO_QUALIFICATION_SPEND_LEDGER_PATH: "relative/untrusted.db",
      },
      25,
      "/tmp/qualification/spend.db",
      "a-resolved-launcher-secret",
    );
    expect(result.KEIKO_QUALIFICATION_SPEND_BUDGET_USD).toBe("25");
    expect(result.KEIKO_QUALIFICATION_SPEND_LEDGER_PATH).toBe("/tmp/qualification/spend.db");
    expect(result.KEIKO_CODING_RUNTIME_DEV_LANE).toBe("1");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("does not mutate the base env", () => {
    const base = { KEIKO_QUALIFICATION_SPEND_BUDGET_USD: "10" };
    launchedEnv(base, 40, "/tmp/qualification/spend.db", "a-resolved-launcher-secret");
    expect(base.KEIKO_QUALIFICATION_SPEND_BUDGET_USD).toBe("10");
  });

  // Live-run bug: the real Coding Workbench reported "Workbench is not paired" because this
  // harness never minted a launcher pairing attestation, and it never could -- the launched
  // `keiko ui` process never received a launcher secret under the key the real pairing port
  // reads. Threading it under `SESSION_PAIRING_LAUNCHER_SECRET_ENV` (imported from
  // `@oscharko-dev/keiko-server`, the SAME producer the pairing port itself exports the key
  // from -- never a restated literal) is what makes a minted attestation verifiable at all.
  it("threads the resolved launcher secret under the real pairing port's env key", () => {
    const result = launchedEnv(
      { PATH: "/usr/bin" },
      10,
      "/tmp/qualification/spend.db",
      "resolved-secret-value",
    );
    expect(result[SESSION_PAIRING_LAUNCHER_SECRET_ENV]).toBe("resolved-secret-value");
  });
});

describe("resolveLauncherSecret", () => {
  it("uses the operator-provided secret when present", () => {
    expect(
      resolveLauncherSecret({ KEIKO_QUALIFICATION_LAUNCHER_SECRET: "operator-secret-value" }),
    ).toBe("operator-secret-value");
  });

  it("generates a sufficiently long secret when none is configured, never a fixed fallback", () => {
    const first = resolveLauncherSecret({});
    const second = resolveLauncherSecret({});
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(second.length).toBeGreaterThanOrEqual(32);
    // Never reuses one hardcoded value across invocations -- unlike the scripted fixture servers'
    // shared constant secret, this harness launches the REAL product, so a fixed secret would be a
    // standing pairing credential against it.
    expect(first).not.toBe(second);
  });

  it("treats an empty configured value as absent rather than pairing with an empty secret", () => {
    expect(
      resolveLauncherSecret({ KEIKO_QUALIFICATION_LAUNCHER_SECRET: "" }).length,
    ).toBeGreaterThanOrEqual(32);
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

describe("defaultStateDir", () => {
  // Live-run bug, discovered by actually running `test:e2e:coding-issue-journey:live`: `keiko
  // ui`'s own `--ui-db` CLI validation (`packages/keiko-server/src/store/paths.ts`'s
  // `resolveUiDbPath`) fails closed with "UI database path must not be inside the current
  // workspace" for ANY path under the real process's `process.cwd()` unless that path sits under
  // the literal `<cwd>/.keiko` exemption -- Playwright's `webServer.cwd` is always the repo root,
  // so a state dir nested under a differently-named top-level directory (the previous
  // `.keiko-coding-issue-journey-e2e`) always failed this guard the moment the server actually
  // tried to launch `keiko ui` with a `--ui-db` under it.
  it("nests under .keiko so the resolved ui-db path satisfies keiko ui's own workspace guard", () => {
    const repoRoot = "/Users/example/keiko-checkout";
    const stateDir = defaultStateDir(repoRoot);
    expect(stateDir).toBe(resolve(repoRoot, ".keiko", "coding-issue-journey-e2e"));
    const uiDbPath = resolve(stateDir, "ui-db", "keiko-ui.db");
    expect(uiDbPath.startsWith(`${resolve(repoRoot, ".keiko")}${sep}`)).toBe(true);
  });
});
