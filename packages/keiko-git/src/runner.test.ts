// Exercises the real spawn boundary: exit/output capture, byte caps, and the wall-clock timeout
// with SIGTERM escalation. The timeout case blocks git deterministically on a FIFO open (no
// writer ever appears) — no network, no ports, no sleeps racing real work.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitProcessRunner, defaultGitProcessRunner, GIT_BASE_ARGS } from "./runner.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-runner-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createGitProcessRunner", () => {
  it("captures stdout and a zero exit for a successful command", async () => {
    const result = await defaultGitProcessRunner(
      [...GIT_BASE_ARGS, "-C", root, "rev-parse", "--is-inside-work-tree"],
      { cwd: root, maxBytes: 1024, timeoutMs: 10_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("true");
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr and the non-zero exit for a failing command", async () => {
    const result = await defaultGitProcessRunner(
      [...GIT_BASE_ARGS, "-C", root, "rev-parse", "--verify", "definitely-missing-ref"],
      { cwd: root, maxBytes: 4096, timeoutMs: 10_000 },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
  });

  it.each(["--upload-pack=touch /tmp/x", "--receive-pack=evil", "--exec=evil", "--upload-pack"])(
    "refuses the remote-command option %s before spawning git",
    async (badArg) => {
      // A fake git on PATH would create a marker if it ran; the guard must reject before spawn.
      const marker = join(root, "spawned.marker");
      const result = await defaultGitProcessRunner([...GIT_BASE_ARGS, "clone", "--", badArg], {
        cwd: root,
        maxBytes: 1024,
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBe(128);
      expect(result.stderr).toContain("refused git option");
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("still allows legitimate look-alike flags (--exec-path, -c)", async () => {
    // These are used by real Keiko git invocations and must NOT be caught by the guard.
    const result = await defaultGitProcessRunner(
      [...GIT_BASE_ARGS, "-c", "gc.auto=0", "--exec-path"],
      { cwd: root, maxBytes: 4096, timeoutMs: 10_000 },
    );
    // --exec-path prints git's exec path and exits 0; the point is it was NOT refused (128 + message).
    expect(result.stderr).not.toContain("refused git option");
  });

  it("maps a missing binary to exit 127 via the spawn error path", async () => {
    const runner = createGitProcessRunner(() => ({ PATH: join(root, "no-binaries-here") }));
    const result = await runner(["--version"], { cwd: root, maxBytes: 1024, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("git executable unavailable");
  });

  it("truncates output at the byte cap and terminates the process", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(64 * 1024));
    execFileSync("git", ["add", "big.txt"], { cwd: root });
    const result = await defaultGitProcessRunner(
      [...GIT_BASE_ARGS, "-C", root, "cat-file", "-p", ":big.txt"],
      { cwd: root, maxBytes: 1024, timeoutMs: 10_000 },
    );
    expect(result.truncated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1024);
  });

  it("does not report truncation when output exactly fills the cap", async () => {
    const result = await defaultGitProcessRunner(
      [...GIT_BASE_ARGS, "-C", root, "rev-parse", "--is-inside-work-tree"],
      { cwd: root, maxBytes: Buffer.byteLength("true\n", "utf8"), timeoutMs: 10_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("true\n");
    expect(result.truncated).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "kills a wedged process at the timeout and flags timedOut",
    async () => {
      const fifo = join(root, "wedge.fifo");
      execFileSync("mkfifo", [fifo]);
      // `git config --file` opens the FIFO for reading and blocks forever: no writer will appear.
      const result = await defaultGitProcessRunner(
        [...GIT_BASE_ARGS, "config", "--file", fifo, "--list"],
        { cwd: root, maxBytes: 1024, timeoutMs: 250 },
      );
      expect(result.timedOut).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
    },
    15_000,
  );
});
