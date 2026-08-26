// #2906 review (comment 3863185744) — ui.pid write-side TOCTOU.
//
// The pre-fix `cmdStart` wrote the pid file via `assertNotSymlink(path)` (a standalone
// `lstatSync` CHECK) immediately followed by a SEPARATE `writeFileSync(path, ...)` USE. A symlink
// planted in the window between those two syscalls was followed by `writeFileSync`, letting a
// state-dir actor redirect the pid Keiko later trusts at any user-writable path. This test mocks
// `lstatSync` so the swap lands INSIDE the check itself — the earliest a real attacker's race
// could land — and asserts the decoy the symlink points at is never written to. The fix
// (`openPidFileNoFollow` in lifecycle.ts) opens with `O_NOFOLLOW` instead of checking then using,
// so there is no window left to race: this mock's swap simply never gets a chance to matter.
//
// Mirrors launcher-toctou.test.ts's technique (mock scope is file-local via `vi.mock`, hoisted
// above every import, so the rest of the lifecycle test suite — which uses the real filesystem —
// is unaffected).

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";

let armLstatSwap = false;
let swapPerformed = false;
let symlinkTargetPath = "";
let decoyPath = "";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (path: unknown, options?: unknown): unknown => {
      if (armLstatSwap && !swapPerformed && path === symlinkTargetPath) {
        swapPerformed = true;
        // Simulate an attacker planting a symlink in the instant between the pre-fix check and
        // the write it precedes: swap the target NOW, then report the pre-swap "does not exist"
        // reality the check believed it saw (assertNotSymlink treats ENOENT as "nothing to
        // follow" and lets the write proceed).
        actual.symlinkSync(decoyPath, symlinkTargetPath);
        const enoent: NodeJS.ErrnoException = Object.assign(new Error("ENOENT (mocked TOCTOU)"), {
          code: "ENOENT",
        });
        throw enoent;
      }
      return (actual.lstatSync as (...args: unknown[]) => unknown)(path, options);
    },
  };
});

// Import AFTER vi.mock so lifecycle.ts binds the mocked lstatSync.
const { runLifecycleCli } = await import("./lifecycle.js");

interface Captured {
  readonly io: { readonly out: (s: string) => void; readonly err: (s: string) => void };
}

// Captures rather than no-ops (matches lifecycle.test.ts's own makeIo): keeps every callback
// non-empty and gives a failing assertion somewhere to print the CLI's own output from.
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
  };
}

const tempRoots: string[] = [];

afterEach(() => {
  armLstatSwap = false;
  swapPerformed = false;
  symlinkTargetPath = "";
  decoyPath = "";
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("keiko start — ui.pid write-side TOCTOU (KEIKO-0886 follow-up, #2906 review)", () => {
  it("never writes the pid through a symlink planted in the check-then-write race window", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-lifecycle-toctou-")));
    tempRoots.push(root);
    const stateDir = join(root, ".keiko");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const decoy = join(root, "victim.txt");
    const original = "unchanged\n";
    writeFileSync(decoy, original, "utf8");
    symlinkTargetPath = join(stateDir, "ui.pid");
    decoyPath = decoy;
    armLstatSwap = true;

    const c = makeIo();
    const child = { pid: 55_555, unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess;
    await runLifecycleCli(
      "start",
      [],
      c.io,
      {},
      {
        cwd: root,
        homedir: () => root,
        spawnFn: () => child,
        fetchImpl: () => Promise.resolve(Response.json({ version: SDK_VERSION }, { status: 200 })),
        isProcessAlive: () => true,
        isPortAvailable: () => Promise.resolve(true),
        killProcess: vi.fn(),
        sleep: () => Promise.resolve(),
      },
    ).catch(() => undefined);

    // The pid must never be written through the swapped-in symlink, whatever the call's own
    // outcome was (it may resolve OR reject depending on how far the fixed code got before
    // refusing) -- the decoy's content is the actual security invariant this test pins.
    expect(readFileSync(decoy, "utf8")).toBe(original);
  });
});
