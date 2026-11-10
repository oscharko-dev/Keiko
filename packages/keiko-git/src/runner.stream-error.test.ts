import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// #4068 (W7): on Windows, CreateProcess refuses a working directory at or above MAX_PATH. Node then
// destroys both stdio pipes with `read ENOTCONN` before the child's own `error`. A pipe error
// without a listener is an uncaught exception, and the BFF's process guard terminates on one, so
// connecting a deeply nested Git folder killed the server. A fake child reproduces that ordering on
// every platform.
class FakeChild extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly kills: (string | undefined)[] = [];
  public kill(signal?: string): boolean {
    this.kills.push(signal);
    return true;
  }
}

const children: FakeChild[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (): FakeChild => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  };
});

afterEach(() => {
  children.length = 0;
});

function streamError(): Error {
  return Object.assign(new Error("read ENOTCONN"), { code: "ENOTCONN", syscall: "read" });
}

describe("git runner stdio stream failures (#4068)", () => {
  it.each(["stdout", "stderr"] as const)(
    "settles a %s pipe error as a spawn failure instead of throwing it",
    async (stream) => {
      const { createGitProcessRunner } = await import("./runner.js");
      const run = createGitProcessRunner(() => ({ ...process.env }));
      const pending = run(["status", "--porcelain"], {
        cwd: process.cwd(),
        maxBytes: 1024,
        timeoutMs: 10_000,
      });
      const child = children.at(-1);
      if (child === undefined) {
        // No git on this host: the runner refuses before spawning, which is not this path.
        await expect(pending).resolves.toMatchObject({ exitCode: 127 });
        return;
      }
      child[stream].destroy(streamError());
      await expect(pending).resolves.toMatchObject({
        exitCode: 127,
        stderr: "git executable unavailable",
      });
      expect(child.kills.length).toBeGreaterThan(0);
      // The child's own late error and close must not settle twice or throw.
      child.emit("error", streamError());
      child.emit("close", null, null);
    },
  );
});
