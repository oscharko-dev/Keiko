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

  it("maps an unresolvable git executable to exit 127 (resolver returns not-found)", async () => {
    // KEIKO-0641: this test exercises the RESOLUTION-failure path (resolveGitExecutable returns
    // { ok: false, reason: "not-found" }) — spawn() is never reached. The distinct child.on('error')
    // branch (a resolved candidate that fails at execve, e.g. ENOEXEC) is covered separately below.
    const runner = createGitProcessRunner(() => ({ PATH: join(root, "no-binaries-here") }));
    const result = await runner(["--version"], { cwd: root, maxBytes: 1024, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("git executable unavailable");
  });

  it.skipIf(process.platform === "win32")(
    "settles a spawn-time execve failure via the child.on('error') handler (exit 127)",
    async () => {
      // KEIKO-0641: prior coverage gap — no test reached the wireGitProcessEvents child.on('error')
      // handler because every negative case failed at resolveGitExecutable first. Here the resolver
      // succeeds (an executable-permission-bit file in a trusted, non-workspace, non-writable dir),
      // but the file's shebang points at a non-existent interpreter, so execve() returns ENOENT on
      // the interpreter and Node emits an 'error' event on the child before any close. The runner
      // must still return the SPAWN_ERROR_RESULT shape (exit 127 / "git executable unavailable")
      // for parity with the resolver-failure branch — proving the fallthrough surface for a
      // salted-binary indicator is intact. A bad shebang (rather than a naked non-binary file) is
      // used because a naked non-binary file rejects synchronously as ENOEXEC on some platforms,
      // which would test spawn()'s throw path, not the intended 'error'-event handler.
      const bin = mkdtempSync(join(tmpdir(), "keiko-git-runner-badshebang-bin-"));
      try {
        const fakeGit = join(bin, "git");
        writeFileSync(fakeGit, "#!/nonexistent-keiko-audit/interp\nnot reachable\n", {
          mode: 0o755,
        });
        chmodSync(bin, 0o700);
        const runner = createGitProcessRunner(() => ({ PATH: bin }));
        const result = await runner(["--version"], {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(127);
        expect(result.stderr).toBe("git executable unavailable");
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
    },
  );

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

  it.skipIf(process.platform === "win32").each([
    // KEIKO-0733: a raw byte-index cut that bisects a multi-byte UTF-8 codepoint decodes the
    // dangling lead byte(s) as U+FFFD. "ab" (2 ASCII bytes) followed by a multi-byte codepoint;
    // maxBytes lands the cut inside the codepoint, leaving only its lead byte(s) captured.
    {
      label: "mid-3-byte sequence (only the lead byte survives the cut)",
      // "€" = E2 82 AC — capture "ab" + the first byte only.
      octal: "ab\\342\\202\\254",
      maxBytes: 3,
      expectedStdout: "ab",
    },
    {
      label: "mid-4-byte sequence (two of four bytes survive the cut)",
      // "😀" = F0 9F 98 80 — capture "ab" + the first two bytes only.
      octal: "ab\\360\\237\\230\\200",
      maxBytes: 4,
      expectedStdout: "ab",
    },
    {
      label: "2-byte lead byte alone survives the cut",
      // "é" = C3 A9 — capture "ab" + the lead byte only. Exercises the
      // utf8LeadByteSequenceLength 2-byte branch ((byte & 0xe0) === 0xc0), which the two cases
      // above never reach.
      octal: "ab\\303\\251",
      maxBytes: 3,
      expectedStdout: "ab",
    },
    {
      label: "a complete trailing codepoint at the cut boundary is preserved",
      // "€" = E2 82 AC followed by "cd"; the cap lands exactly at the end of the complete
      // 3-byte codepoint, so nothing should be trimmed. This kills a `>=` mutant on the
      // `sequenceLength > distanceFromEnd` guard: a `>=` mutant silently deletes this complete,
      // uncut "€" instead of leaving it alone.
      octal: "ab\\342\\202\\254cd",
      maxBytes: 5,
      expectedStdout: "ab€",
    },
  ])(
    "drops an incomplete trailing UTF-8 lead-byte sequence instead of emitting U+FFFD: $label",
    async ({ octal, maxBytes, expectedStdout }) => {
      const binDir = mkdtempSync(join(tmpdir(), "keiko-git-utf8-tail-bin-"));
      const fakeGit = join(binDir, "git");
      writeFileSync(fakeGit, `#!/bin/sh\nprintf '${octal}'\n`, "utf8");
      chmodSync(binDir, 0o700);
      chmodSync(fakeGit, 0o700);

      try {
        const runner = createGitProcessRunner(() => ({ PATH: binDir }));
        const result = await runner(["status"], {
          cwd: root,
          timeoutMs: 1_000,
          maxBytes,
        });

        expect(result.truncated).toBe(true);
        expect(result.stdout).toBe(expectedStdout);
        expect(result.stdout).not.toContain("�");
      } finally {
        rmSync(binDir, { recursive: true, force: true });
      }
    },
  );

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

  it.skipIf(process.platform === "win32")(
    "neutralizes a repository-local diff.external for local reads",
    async () => {
      const marker = join(root, "diff-external-executed.marker");
      const hook = join(root, "hostile-diff-external.sh");
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
      execFileSync("chmod", ["+x", hook]);
      execFileSync("git", ["config", "diff.external", hook], { cwd: root });

      const tracked = join(root, "tracked.txt");
      writeFileSync(tracked, "original\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd: root });
      writeFileSync(tracked, "changed\n");

      const result = await defaultGitProcessRunner([...GIT_BASE_ARGS, "-C", root, "diff"], {
        cwd: root,
        maxBytes: 4096,
        timeoutMs: 10_000,
      });

      // The repository-local hostile external-diff helper must never run, AND the read must still
      // succeed with a correct internal-differ patch. Order matters: this must be red because the
      // hostile script ran, never because the read itself failed (a blanket `-c diff.external=`
      // override would fail the whole invocation at exec time, which is not neutralization — see
      // the comment on LOCAL_READ_CONFIG_ARGS in runner.ts).
      expect(existsSync(marker)).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^diff --git /u);
    },
  );

  it.each([
    ["core.fsmonitor", "hostile", "false"],
    ["core.editor", "hostile-editor", "true"],
  ] as const)("overrides repository-local read setting %s", async (key, configured, expected) => {
    execFileSync("git", ["config", key, configured], { cwd: root });

    const result = await defaultGitProcessRunner(
      [...GIT_BASE_ARGS, "-C", root, "config", "--get", key],
      { cwd: root, maxBytes: 1_024, timeoutMs: 5_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it.each([
    ["core.fsmonitor", "hostile", "false"],
    ["core.hooksPath", "hostile", process.platform === "win32" ? "NUL" : "/dev/null"],
    ["core.sshCommand", "hostile", ""],
    ["credential.helper", "hostile", ""],
    ["core.pager", "hostile", "cat"],
    ["pager.fetch", "true", "false"],
    ["pager.pull", "true", "false"],
    ["alias.fetch", "hostile", ""],
    ["alias.pull", "hostile", ""],
    ["protocol.ext.allow", "always", "never"],
    ["fetch.recurseSubmodules", "true", "false"],
    ["submodule.recurse", "true", "false"],
  ] as const)("overrides repository network setting %s", async (key, configured, expected) => {
    execFileSync("git", ["config", key, configured], { cwd: root });

    const result = await defaultGitNetworkProcessRunner(["config", "--get", key], {
      cwd: root,
      timeoutMs: 1_000,
      maxBytes: 1_024,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
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
    "does not execute an ext protocol remote during a network operation",
    async () => {
      const marker = join(root, "ext-protocol-executed");
      execFileSync("git", ["remote", "add", "hostile", `ext::touch ${marker}`], { cwd: root });

      const result = await defaultGitNetworkProcessRunner(["ls-remote", "hostile"], {
        cwd: root,
        timeoutMs: 5_000,
        maxBytes: 4_096,
      });

      expect(result.exitCode).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    },
  );

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
