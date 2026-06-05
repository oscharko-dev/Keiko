// MINOR (verifier) — O_EXCL TOCTOU coverage.
//
// `cmdInstall` checks `existsSync(targetPath)` and only then calls `writeAtomicExcl`,
// which uses `O_WRONLY|O_CREAT|O_EXCL` so an attacker who plants a file at `targetPath`
// in the race window between the two calls cannot trick the launcher into overwriting.
// The runtime defense exists; this test pins it by mocking `openSync` to throw an
// `EEXIST`-coded error (simulating "another process created the file between existsSync
// and openSync"). The launcher MUST surface the error (exit 1) and MUST NOT proceed.
//
// Mock scope is file-local so the rest of the launcher test suite (which uses the real
// filesystem) is unaffected.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const eexistOpen = vi.hoisted(() => (): never => {
  const err: NodeJS.ErrnoException = Object.assign(
    new Error("EEXIST: file already exists (mocked TOCTOU)"),
    { code: "EEXIST", errno: -17, syscall: "open" },
  );
  throw err;
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: eexistOpen,
  };
});

// Import AFTER vi.mock so the launcher binds the mocked `openSync`.
const { runLauncherCli } = await import("./launcher.js");

interface Captured {
  readonly io: { readonly out: (s: string) => void; readonly err: (s: string) => void };
  readonly out: () => string;
  readonly err: () => string;
}

function makeIo(): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("cmdInstall — O_EXCL TOCTOU defense (MINOR)", () => {
  it("surfaces EEXIST from openSync when a file appears between existsSync and openSync", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-launcher-toctou-"));
    tempRoots.push(root);
    const home = join(root, "home");
    const stateDir = join(root, "state");
    mkdirSync(home, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    // Pre-create the approved dir so `mkdirSync` doesn't go through the mocked `openSync`
    // path. (`writeFileSync` is still the real impl per `...actual` spread above.)
    mkdirSync(join(home, ".local/share/applications"), { recursive: true });
    // Sanity: the dir exists.
    writeFileSync(join(home, ".local/share/applications/.placeholder"), "");
    const c = makeIo();
    const code = runLauncherCli(
      ["install"],
      c.io,
      {},
      {
        homedir: () => home,
        platform: () => "linux",
        resolveExe: () => "/usr/local/bin/keiko",
        stateDir,
      },
    );
    // The mocked openSync threw EEXIST → `writeAtomicExcl` re-raises as a `TARGET_EXISTS`
    // LauncherError, which `runLauncherCli` catches and surfaces as a 1 exit. The launcher
    // MUST NOT silently overwrite.
    expect(code).toBe(1);
    expect(c.err()).toMatch(/TOCTOU|appeared between|TARGET_EXISTS|refusing to overwrite/i);
  });
});
