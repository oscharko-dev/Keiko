// Exercises the real spawn boundary: exit/output capture, byte caps, and the wall-clock timeout
// with SIGTERM escalation. The timeout case blocks git deterministically on a FIFO open (no
// writer ever appears) — no network, no ports, no sleeps racing real work.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyGitRemoteFailure } from "./classify.js";
import {
  createGitProcessRunner,
  defaultGitNetworkProcessRunner,
  defaultGitProcessRunner,
  GIT_BASE_ARGS,
} from "./runner.js";

let root: string;

function startCredentialChallengeServer(): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Keiko"' });
      response.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new TypeError("expected TCP server");
      resolve({ server, url: `http://127.0.0.1:${String(address.port)}/remote.git` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

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
      // KEIKO-0317: the marker assertion used to be dead — no fake git was planted on PATH, so
      // the check passed whether or not the guard fired. Plant a real fake `git` that writes the
      // marker on any execution, then override PATH so the runner would resolve it if it ever
      // reached the spawn. If the guard is removed, the marker gets written and this test fails.
      const bin = mkdtempSync(join(tmpdir(), "keiko-git-runner-fake-bin-"));
      const marker = join(root, "spawned.marker");
      const fakeGit = join(bin, "git");
      writeFileSync(fakeGit, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
      chmodSync(fakeGit, 0o755);
      // Trusted bin dir semantics: 0o700 keeps resolveGitExecutable happy on Linux where
      // realpath equality with a 0o777 tmpdir would otherwise reject the candidate.
      chmodSync(bin, 0o700);
      const runner = createGitProcessRunner(() => ({ PATH: bin }));
      try {
        const result = await runner([...GIT_BASE_ARGS, "clone", "--", badArg], {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(128);
        expect(result.stderr).toContain("refused git option");
        // Load-bearing: removing the guard leaks execution through to the fake git, which
        // writes the marker — this assertion then fails, proving the guard is what stopped it.
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
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

  it.skipIf(process.platform === "win32")(
    "refuses a repository-local git executable inherited through PATH",
    async () => {
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const runner = createGitProcessRunner(() => ({ PATH: bin }));
      const result = await runner(["--version"], { cwd: root, maxBytes: 1024, timeoutMs: 10_000 });
      // KEIKO-0263: the runner now names the untrusted-location refusal distinctly instead of
      // collapsing it into "git executable unavailable". The exit code stays 127 for existing
      // consumers that key off the shape.
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toBe("git executable in untrusted location refused");
    },
  );

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

  it.skipIf(process.platform === "win32")(
    "shares the output cap across stdout and stderr",
    async () => {
      const binDir = mkdtempSync(join(tmpdir(), "keiko-git-output-bin-"));
      const fakeGit = join(binDir, "git");
      writeFileSync(fakeGit, "#!/bin/sh\nprintf 'abcdefgh'\nprintf 'ijklmnop' >&2\n", "utf8");
      chmodSync(binDir, 0o700);
      chmodSync(fakeGit, 0o700);

      try {
        const runner = createGitProcessRunner(() => ({ PATH: binDir }));
        const result = await runner(["status"], {
          cwd: root,
          timeoutMs: 1_000,
          maxBytes: 12,
        });

        expect(
          Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
        ).toBeLessThanOrEqual(12);
        expect(result.truncated).toBe(true);
      } finally {
        rmSync(binDir, { recursive: true, force: true });
      }
    },
  );

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
    "neutralizes a repository-local executable fsmonitor for local reads",
    async () => {
      const marker = join(root, "fsmonitor-executed.marker");
      const hook = join(root, "hostile-fsmonitor.sh");
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
      execFileSync("chmod", ["+x", hook]);
      execFileSync("git", ["config", "core.fsmonitor", hook], { cwd: root });

      const result = await defaultGitProcessRunner(
        [...GIT_BASE_ARGS, "-C", root, "status", "--porcelain=v1"],
        { cwd: root, maxBytes: 4096, timeoutMs: 10_000 },
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("suppresses executable repository settings for network operations", async () => {
    const hooksDir = join(root, "hostile-hooks");
    mkdirSync(hooksDir);
    execFileSync("git", ["config", "core.hooksPath", hooksDir], { cwd: root });
    execFileSync("git", ["config", "core.sshCommand", `touch ${root}`], { cwd: root });
    const hooksResult = await defaultGitNetworkProcessRunner(
      ["config", "--get", "core.hooksPath"],
      { cwd: root, timeoutMs: 1_000, maxBytes: 1_024 },
    );
    const sshResult = await defaultGitNetworkProcessRunner(["config", "--get", "core.sshCommand"], {
      cwd: root,
      timeoutMs: 1_000,
      maxBytes: 1_024,
    });

    expect(hooksResult.stdout.trim()).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
    expect(sshResult.stdout).toBe("\n");
  });

  it("does not execute a repository credential helper during network authentication", async () => {
    const marker = join(root, "credential-helper-executed");
    const { server, url } = await startCredentialChallengeServer();
    execFileSync("git", ["config", "credential.helper", `!touch ${marker}`], { cwd: root });

    try {
      const result = await defaultGitNetworkProcessRunner([...GIT_BASE_ARGS, "ls-remote", url], {
        cwd: root,
        timeoutMs: 5_000,
        maxBytes: 4_096,
      });

      expect(result.exitCode).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await closeServer(server);
    }
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

  it.skipIf(process.platform === "win32")(
    "kills a wedged process when the bounded caller aborts",
    async () => {
      const fifo = join(root, "abort.fifo");
      execFileSync("mkfifo", [fifo]);
      const controller = new AbortController();
      const pending = defaultGitProcessRunner(
        [...GIT_BASE_ARGS, "config", "--file", fifo, "--list"],
        {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
          abortSignal: controller.signal,
        },
      );
      controller.abort();
      const result = await pending;
      expect(result.signal).toBe("SIGTERM");
      expect(result.truncated).toBe(true);
      expect(result.timedOut).toBe(false);
    },
    15_000,
  );

  // KEIKO-0184: `truncated` is also set on abort (the runner terminates the child so the
  // originator-disconnect unblocks the caller), which used to make classifyGitRemoteFailure
  // report every aborted run as "output-truncated". The runner now carries a distinct `aborted`
  // bit so the classifier can tell them apart.
  it.skipIf(process.platform === "win32")(
    "flags aborted separately from truncated so classifier can distinguish the two",
    async () => {
      const fifo = join(root, "abort-flag.fifo");
      execFileSync("mkfifo", [fifo]);
      const controller = new AbortController();
      const pending = defaultGitProcessRunner(
        [...GIT_BASE_ARGS, "config", "--file", fifo, "--list"],
        {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
          abortSignal: controller.signal,
        },
      );
      controller.abort();
      const result = await pending;
      expect(result.aborted).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(classifyGitRemoteFailure(result)).toBe("cancelled");
      expect(classifyGitRemoteFailure(result)).not.toBe("output-truncated");
    },
    15_000,
  );
});
