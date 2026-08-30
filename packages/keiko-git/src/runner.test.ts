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
  readFileSync,
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
  gitSubcommand,
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
        // Escaped, not a literal glyph: a literal U+FFFD in analyzable source text fails
        // scripts/sonar-analysis-scope.mjs's sourceEncodingFailures check (source files are
        // expected to be clean UTF-8 with no replacement characters); the escape sequence below
        // is the identical runtime value, so the assertion itself is unchanged.
        expect(result.stdout).not.toContain("\uFFFD");
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

  it.skipIf(process.platform === "win32")(
    "still neutralizes diff.external when a caller places -c <key>=<value> before the subcommand",
    async () => {
      // Final review of #2907: findSubcommandIndex only special-cased "-C <path>" as a
      // value-taking pre-subcommand flag, so a caller passing "-c core.quotepath=false" (the
      // exact shape grounded-git-history-evidence.ts's gitHistoryArgs() already uses ahead of
      // "log") made subcommand detection stop one token early, silently turning
      // withDiffFamilyNeutralized into a no-op for any diff-family invocation shaped this way.
      const marker = join(root, "diff-external-c-flag-executed.marker");
      const hook = join(root, "hostile-diff-external-c-flag.sh");
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
      execFileSync("chmod", ["+x", hook]);
      execFileSync("git", ["config", "diff.external", hook], { cwd: root });

      const tracked = join(root, "tracked-c-flag.txt");
      writeFileSync(tracked, "original\n");
      execFileSync("git", ["add", "tracked-c-flag.txt"], { cwd: root });
      writeFileSync(tracked, "changed\n");

      const result = await defaultGitProcessRunner(
        [...GIT_BASE_ARGS, "-C", root, "-c", "core.quotepath=false", "diff"],
        { cwd: root, maxBytes: 4096, timeoutMs: 10_000 },
      );

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

  // Audit finding on #3348: injecting --no-ext-diff --no-textconv before the caller's remaining
  // arguments did not enforce the invariant — a later --ext-diff/--textconv, or a -c/--config-env
  // override of diff.external (and sibling dangerous keys), reached spawn unexamined. These tests
  // prove the preflight now rejects the override BEFORE the child process is ever created, and
  // that show/log -p are neutralized like diff.
  describe("external-diff boundary preflight (audit finding #3348)", () => {
    function plantMarkerGit(): { readonly bin: string; readonly marker: string } {
      const bin = mkdtempSync(join(tmpdir(), "keiko-git-runner-fake-bin-"));
      const marker = join(root, `spawned-${String(Math.random()).slice(2)}.marker`);
      const fakeGit = join(bin, "git");
      writeFileSync(fakeGit, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
      chmodSync(fakeGit, 0o755);
      chmodSync(bin, 0o700);
      return { bin, marker };
    }

    it("rejects a later --ext-diff before spawning git (the override the finding names)", async () => {
      const { bin, marker } = plantMarkerGit();
      const runner = createGitProcessRunner(() => ({ PATH: bin }));
      try {
        const result = await runner([...GIT_BASE_ARGS, "diff", "--ext-diff"], {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(128);
        expect(result.stderr).toContain("refused git option");
        // Load-bearing: this is the exact reproduction from the finding
        // (`defaultGitProcessRunner([...GIT_BASE_ARGS, "diff", "--ext-diff"], …)`); if the
        // preflight is removed, the marker gets written and this assertion fails.
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
    });

    it("rejects a bare --textconv before spawning git", async () => {
      const { bin, marker } = plantMarkerGit();
      const runner = createGitProcessRunner(() => ({ PATH: bin }));
      try {
        const result = await runner([...GIT_BASE_ARGS, "show", "--textconv", "HEAD:f"], {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(128);
        expect(result.stderr).toContain("refused git option");
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
    });

    it.each([
      { label: "-c diff.external=<cmd> (two-token)", args: ["-c", "diff.external=/bin/true"] },
      { label: "-cdiff.external=<cmd> (joined)", args: ["-cdiff.external=/bin/true"] },
      { label: "-c=diff.external=<cmd> (=-joined)", args: ["-c=diff.external=/bin/true"] },
      {
        label: "--config-env diff.external=<envvar> (two-token)",
        args: ["--config-env", "diff.external=KEIKO_AUDIT_EVIL"],
      },
      {
        label: "--config-env=diff.external=<envvar> (joined)",
        args: ["--config-env=diff.external=KEIKO_AUDIT_EVIL"],
      },
    ])("rejects a $label override before the subcommand", async ({ args: configArgs }) => {
      const { bin, marker } = plantMarkerGit();
      const runner = createGitProcessRunner(() => ({ PATH: bin }));
      try {
        const result = await runner([...GIT_BASE_ARGS, ...configArgs, "diff"], {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(128);
        expect(result.stderr).toContain("refused git option");
        expect(result.stderr).toContain("diff.external");
        // Body-free: the denied KEY may appear in the redacted refusal, the VALUE never does.
        expect(result.stderr).not.toContain("/bin/true");
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
    });

    it("rejects a -c override with a differently-cased dangerous key (case-insensitive)", async () => {
      const { bin, marker } = plantMarkerGit();
      const runner = createGitProcessRunner(() => ({ PATH: bin }));
      try {
        const result = await runner([...GIT_BASE_ARGS, "-c", "DIFF.External=/bin/true", "diff"], {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(128);
        expect(result.stderr).toContain("refused git option");
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
    });

    it.each([
      "pager.log",
      "alias.evil",
      "protocol.ext.allow",
      "diff.mydriver.textconv",
      "diff.mydriver.command",
      "core.sshCommand",
      "credential.helper",
    ])("rejects a -c override of the dangerous key %s", async (key) => {
      const { bin, marker } = plantMarkerGit();
      const runner = createGitProcessRunner(() => ({ PATH: bin }));
      try {
        const result = await runner([...GIT_BASE_ARGS, "-c", `${key}=x`, "diff"], {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(128);
        expect(result.stderr).toContain("refused git option");
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
    });

    it("rejects a dangling -c with no following value (cannot prove safe)", async () => {
      const { bin, marker } = plantMarkerGit();
      const runner = createGitProcessRunner(() => ({ PATH: bin }));
      try {
        const result = await runner([...GIT_BASE_ARGS, "-c"], {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(128);
        expect(result.stderr).toContain("refused git option");
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
    });

    it("rejects a -c value with no = at all when the bare value matches a dangerous key", async () => {
      // Required shape: `-c core.pager` (no "=value") is malformed as a real config override,
      // but the key extraction must still treat the whole value as the key and deny it — a key
      // with no `=` is denied if it matches, never silently allowed.
      const { bin, marker } = plantMarkerGit();
      const runner = createGitProcessRunner(() => ({ PATH: bin }));
      try {
        const result = await runner([...GIT_BASE_ARGS, "-c", "core.pager", "diff"], {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(128);
        expect(result.stderr).toContain("refused git option");
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
    });

    it("still allows the real production call shape: -c core.quotepath=false before log", async () => {
      // grounded-git-history-evidence.ts's gitHistoryArgs() places this exact override ahead of
      // `log`. This must never be rejected by the new preflight — only the dangerous keys are.
      const result = await defaultGitProcessRunner(
        [...GIT_BASE_ARGS, "-C", root, "-c", "core.quotepath=false", "log", "--max-count=1"],
        { cwd: root, maxBytes: 4096, timeoutMs: 10_000 },
      );
      expect(result.stderr).not.toContain("refused git option");
    });

    it("still allows the existing -c gc.auto=0 look-alike shape", async () => {
      // Guards against a regression on the pre-existing "still allows legitimate look-alike
      // flags" test above: an unrelated, safe -c key must never be caught by the new deny list.
      const result = await defaultGitProcessRunner(
        [...GIT_BASE_ARGS, "-c", "gc.auto=0", "status"],
        { cwd: root, maxBytes: 4096, timeoutMs: 10_000 },
      );
      expect(result.stderr).not.toContain("refused git option");
    });

    // Empirically verified (git 2.50) before writing this test: unlike bare `diff` — which
    // invokes a configured diff.external / .gitattributes diff.<driver>.command AUTOMATICALLY,
    // no flag needed — bare `show`/`log -p` do NOT; both require the caller to pass `--ext-diff`
    // explicitly. That flag is exactly what forbiddenDiffEnablingFlag above refuses at preflight
    // (see the "rejects a bare --textconv before spawning git" case using `show --textconv`
    // above), so a real-execution "plant a hostile diff.external and call plain show" test would
    // pass identically with or without this DIFF_FAMILY_SUBCOMMANDS change — proving nothing (the
    // AGENTS.md §7 trap this file's own KEIKO-0317 comment already warns about). The injection is
    // still added as defense in depth (mirrors this file's existing belt-and-suspenders pattern
    // for `diff`, and closes the surface for any future git behaviour change), and the argv-level
    // proof below is the correct, non-vacuous way to verify the injection itself.
    it.each([
      { label: "show", args: ["show", "HEAD"] },
      { label: "log -p", args: ["log", "-p"] },
    ])(
      "injects --no-ext-diff --no-textconv right after $label, not only diff",
      async ({ args: callerArgs }) => {
        const bin = mkdtempSync(join(tmpdir(), "keiko-git-diff-family-bin-"));
        const argvFile = join(bin, "argv.captured");
        const fakeGit = join(bin, "git");
        writeFileSync(
          fakeGit,
          `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvFile}'; done\nexit 0\n`,
        );
        chmodSync(fakeGit, 0o755);
        chmodSync(bin, 0o700);
        try {
          const runner = createGitProcessRunner(() => ({ PATH: bin }));
          await runner(callerArgs, { cwd: root, maxBytes: 1024, timeoutMs: 5_000 });
          const capturedArgv = readFileSync(argvFile, "utf8")
            .split("\n")
            .filter((line) => line.length > 0);
          const subcommand = callerArgs[0] ?? "";
          const subcommandIndex = capturedArgv.indexOf(subcommand);
          expect(subcommandIndex).toBeGreaterThanOrEqual(0);
          expect(capturedArgv.slice(subcommandIndex + 1, subcommandIndex + 3)).toEqual([
            "--no-ext-diff",
            "--no-textconv",
          ]);
        } finally {
          rmSync(bin, { recursive: true, force: true });
        }
      },
    );
  });
});

describe("refusal classification (AGENTS.md §8 Rule 1 evidence)", () => {
  // The refusal MESSAGE is not body-free: for the config-override family the token carries a
  // caller-chosen segment (`-c alias.<name>`, `-c pager.<cmd>`). `refusal` is the half a consumer
  // may log, so it is produced here rather than parsed out of `stderr` downstream.
  it.each([
    {
      label: "--upload-pack",
      args: ["clone", "--upload-pack=/bin/sh"],
      expected: "remote-command-option",
    },
    {
      label: "--receive-pack",
      args: ["push", "--receive-pack=/bin/sh"],
      expected: "remote-command-option",
    },
    { label: "--exec", args: ["send-pack", "--exec=/bin/sh"], expected: "remote-command-option" },
    {
      label: "--ext-diff",
      args: [...GIT_BASE_ARGS, "diff", "--ext-diff"],
      expected: "diff-enabling-flag",
    },
    {
      label: "--textconv",
      args: [...GIT_BASE_ARGS, "show", "--textconv", "HEAD:f"],
      expected: "diff-enabling-flag",
    },
    {
      label: "-c diff.external",
      args: [...GIT_BASE_ARGS, "-c", "diff.external=/bin/true", "diff"],
      expected: "config-override",
    },
    {
      label: "--config-env credential.helper",
      args: [...GIT_BASE_ARGS, "--config-env=credential.helper=EVIL", "fetch"],
      expected: "config-override",
    },
    {
      label: "-c alias.<caller-chosen>",
      args: [...GIT_BASE_ARGS, "-c", "alias.co=!sh", "status"],
      expected: "config-override",
    },
  ])("names the $label refusal class on the result", async ({ args, expected }) => {
    const result = await defaultGitProcessRunner(args, {
      cwd: root,
      maxBytes: 1024,
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(128);
    expect(result.refusal).toBe(expected);
    // types.ts states the real runner always sets `aborted`; the preflight path is a real-runner
    // terminal result, so a consumer must not have to read "absent" as a third state here.
    expect(result.aborted).toBe(false);
  });

  it.each([
    { label: "two-token", flag: ["--config-env", "safe.key=ENVVAR"] },
    { label: "joined", flag: ["--config-env=safe.key=ENVVAR"] },
  ])(
    "still neutralizes the diff family when a $label --config-env precedes the subcommand",
    async ({ flag }) => {
      // The security half of the subcommand-detection defect. `--config-env` with a key the
      // deny-list does not name is permitted (that is the point of key-level, not flag-level,
      // denial), but it used to stop subcommand detection dead — so `withDiffFamilyNeutralized`
      // saw no diff command and `--no-ext-diff --no-textconv` were never injected. A
      // repository-local `diff.external` or `textconv` would then run, which is exactly what
      // #3348 closed. Asserted at the SPAWN, against the argv git actually receives, because the
      // unit-level `gitSubcommand` check alone cannot prove the injection happened.
      const bin = mkdtempSync(join(tmpdir(), "keiko-git-configenv-"));
      const capture = join(bin, "argv.txt");
      const fakeGit = join(bin, "git");
      writeFileSync(fakeGit, `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\nexit 0\n`);
      chmodSync(fakeGit, 0o755);
      chmodSync(bin, 0o700);
      const runner = createGitProcessRunner(() => ({ PATH: bin }));
      try {
        await runner([...GIT_BASE_ARGS, ...flag, "diff"], {
          cwd: root,
          maxBytes: 4096,
          timeoutMs: 10_000,
        });
        const argv = readFileSync(capture, "utf8").trim().split("\n");
        expect(argv).toContain("--no-ext-diff");
        expect(argv).toContain("--no-textconv");
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
    },
  );

  it("keeps the refusal order when one argv trips two preflight families at once", async () => {
    // Every case above trips exactly one family, so reordering REFUSAL_CHECKS would not change any
    // of their answers. This argv trips the remote-command check AND the config-override check;
    // only the table's order decides which class is reported, so this is the case that pins it.
    const result = await defaultGitProcessRunner(
      [...GIT_BASE_ARGS, "-c", "diff.external=/bin/true", "clone", "--upload-pack=/bin/sh"],
      { cwd: root, maxBytes: 1024, timeoutMs: 10_000 },
    );

    expect(result.exitCode).toBe(128);
    expect(result.refusal).toBe("remote-command-option");
  });

  // `resolveGitExecutable` performs the writable-location check only when `platform !== "win32"`,
  // so this POSIX mode-bit fixture is not structurally untrusted on Windows: the candidate is
  // accepted there and `refusal` stays absent. Skipped rather than weakened, matching the
  // neighbouring resolver tests.
  it.skipIf(process.platform === "win32")(
    "names the untrusted-executable refusal, which exits 127 like a missing git",
    async () => {
      // KEIKO-0263's planted-binary indicator. Both this and a genuinely absent git exit 127 and both
      // classify as `git-missing`, so the ONLY thing separating them used to be the stderr text —
      // which is not body-free and can never reach an activity log or an evidence manifest.
      const bin = mkdtempSync(join(tmpdir(), "keiko-git-untrusted-"));
      const fakeGit = join(bin, "git");
      writeFileSync(fakeGit, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeGit, 0o755);
      // World-writable directory: exactly the "must not trust this location" condition.
      chmodSync(bin, 0o777);
      const runner = createGitProcessRunner(() => ({ PATH: bin }));
      try {
        const result = await runner([...GIT_BASE_ARGS, "--version"], {
          cwd: root,
          maxBytes: 1024,
          timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(127);
        expect(result.refusal).toBe("untrusted-executable");
      } finally {
        rmSync(bin, { force: true, recursive: true });
      }
    },
  );

  it("leaves `refusal` absent on every result that reached a real git process", async () => {
    // The discriminator a consumer relies on: `refusal !== undefined` must mean "Keiko refused
    // this", never "git failed". Both a success and an ordinary git failure are checked, because a
    // field set unconditionally would still pass a success-only assertion.
    const succeeded = await defaultGitProcessRunner([...GIT_BASE_ARGS, "--version"], {
      cwd: root,
      maxBytes: 4096,
      timeoutMs: 10_000,
    });
    // `root` is a real repository (see beforeEach), so a genuine git failure needs a request git
    // itself rejects: resolving a ref that was never created exits 128 — the SAME exit code the
    // refusal uses, which is exactly why `refusal` and not `exitCode` is the discriminator.
    const failed = await defaultGitProcessRunner(
      [...GIT_BASE_ARGS, "-C", root, "rev-parse", "--verify", "refs/heads/never-created"],
      { cwd: root, maxBytes: 4096, timeoutMs: 10_000 },
    );
    expect(succeeded.exitCode).toBe(0);
    expect(succeeded.refusal).toBeUndefined();
    expect(failed.exitCode).toBe(128);
    expect(failed.refusal).toBeUndefined();
  });
});

describe("gitSubcommand", () => {
  // The pre-subcommand argv grammar lives in ONE place (findSubcommandIndex). These cases pin that
  // a consumer reading the subcommand through this export gets the same answer the diff-family
  // neutralization does — a second copy of the grammar in a consumer would name the wrong token
  // the moment a caller adds a global flag.
  it.each([
    { label: "bare subcommand", args: ["status"], expected: "status" },
    { label: "after GIT_BASE_ARGS", args: [...GIT_BASE_ARGS, "diff"], expected: "diff" },
    {
      label: "after -C <path>",
      args: [...GIT_BASE_ARGS, "-C", "/tmp/x", "for-each-ref"],
      expected: "for-each-ref",
    },
    {
      label: "after -c <key>=<value>",
      args: [...GIT_BASE_ARGS, "-c", "core.quotepath=false", "log"],
      expected: "log",
    },
  ])("resolves the subcommand $label", ({ args, expected }) => {
    expect(gitSubcommand(args)).toBe(expected);
  });

  it.each([
    {
      label: "two-token --config-env",
      args: [...GIT_BASE_ARGS, "--config-env", "safe.key=ENVVAR", "diff"],
      expected: "diff",
    },
    {
      label: "joined --config-env=<name>=<envvar>",
      args: [...GIT_BASE_ARGS, "--config-env=safe.key=ENVVAR", "show"],
      expected: "show",
    },
  ])("resolves the subcommand past a $label", ({ args, expected }) => {
    // `--config-env` is a flag this module already KNOWS — `forbiddenTwoTokenConfigOverride`
    // handles it by name — but the pre-subcommand table did not list it, so detection stopped at
    // the flag and reported no subcommand. That silently disabled the diff-family neutralization
    // for every argv carrying it (see the spawn-level regression below).
    expect(gitSubcommand(args)).toBe(expected);
  });

  it("accepts a token at the inclusive maximum length and rejects one past it", () => {
    // The guard is /^[a-z][a-z0-9-]{0,31}$/ — 32 characters inclusive. Without the accepting half,
    // tightening the quantifier to {0,30} would keep the 33-character rejection green.
    expect(gitSubcommand([...GIT_BASE_ARGS, "a".repeat(32)])).toBe("a".repeat(32));
    expect(gitSubcommand([...GIT_BASE_ARGS, "a".repeat(33)])).toBeUndefined();
  });

  it.each([
    { label: "an empty argv", args: [] },
    { label: "no subcommand at all", args: [...GIT_BASE_ARGS] },
    { label: "only a global flag", args: ["--version"] },
    { label: "a dangling -C with no value", args: ["-C"] },
  ])("returns undefined when there is no subcommand token ($label)", ({ args }) => {
    expect(gitSubcommand(args)).toBeUndefined();
  });

  it.each([
    { label: "an absolute path", token: "/etc/passwd" },
    { label: "a windows path", token: "C:\\Users\\me\\secret" },
    { label: "a config value", token: "diff.external=/bin/sh" },
    { label: "text with whitespace", token: "not a subcommand" },
    { label: "an over-long token", token: "a".repeat(33) },
    { label: "an upper-case token", token: "STATUS" },
  ])("refuses to name $label as a subcommand", ({ token }) => {
    // This is what makes the value safe to put in an activity log: every Keiko call site passes a
    // literal, but this function reads whatever sits at the subcommand position, so anything that
    // is not a plausible subcommand name must come back as `undefined` rather than be copied out.
    expect(gitSubcommand([...GIT_BASE_ARGS, token])).toBeUndefined();
  });
});
