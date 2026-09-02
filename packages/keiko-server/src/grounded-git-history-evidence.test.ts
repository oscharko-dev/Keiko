import { captureActivityLog } from "./activityLogCapture.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import type {
  SearchScope,
  WorkspaceDirEntry,
  WorkspaceFs,
  WorkspaceStat,
} from "@oscharko-dev/keiko-workspace";
import type { GitProcessResult, GitProcessRunner } from "./gitRoutes.js";
import { defaultGitFileHistoryEvidenceProvider } from "./grounded-git-history-evidence.js";

const NOW = 1_700_000_000_000;
const RECORD_SEP = "\x1e";

let ROOT = "";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ok(stdout: string): GitProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", truncated: false };
}

function fail(stderr: string, exitCode = 128): GitProcessResult {
  return { exitCode, signal: null, stdout: "", stderr, truncated: false };
}

function nodeFs(): WorkspaceFs {
  return {
    readFileUtf8: (absolutePath): string => readFileSync(absolutePath, "utf8"),
    stat: (absolutePath): WorkspaceStat => {
      const stat = statSync(absolutePath);
      return {
        size: stat.size,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        hardLinkCount: stat.nlink,
        mtimeMs: stat.mtimeMs,
      };
    },
    readDir: (absolutePath): readonly WorkspaceDirEntry[] =>
      readdirSync(absolutePath, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      })),
    realPath: (absolutePath): string => realpathSync(absolutePath),
    exists: (absolutePath): boolean => {
      try {
        statSync(absolutePath);
        return true;
      } catch {
        return false;
      }
    },
    readFileBytes: (absolutePath, maxBytes): Promise<Uint8Array> =>
      Promise.resolve(readFileSync(absolutePath).subarray(0, maxBytes)),
  };
}

function deadlineReadProbe(
  fs: WorkspaceFs,
  deadlineReached: () => boolean,
): { readonly fs: WorkspaceFs; readonly lateReads: () => number } {
  let lateReads = 0;
  const record = (): void => {
    if (deadlineReached()) lateReads += 1;
  };
  return {
    fs: {
      ...fs,
      realPath: (absolutePath): string => {
        record();
        return fs.realPath(absolutePath);
      },
      stat: (absolutePath): WorkspaceStat => {
        record();
        return fs.stat(absolutePath);
      },
    },
    lateReads: () => lateReads,
  };
}

function scope(relativePaths: readonly string[] = []): SearchScope {
  return {
    scopeId: "scope-1",
    relativePaths,
    workspace: {
      root: ROOT,
      selectedRoot: ROOT,
      name: "demo",
      version: "0.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: [],
      languages: ["typescript"],
      ignoreLines: [],
    },
  };
}

function query(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "Investigate recent changes",
    caseSensitive: false,
    maxResults: 20,
    emittedAtMs: NOW,
  };
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "keiko-grounded-git-history-"));
  mkdirSync(join(ROOT, "src"), { recursive: true });
  writeFileSync(join(ROOT, "src/recent.ts"), "export const recent = true;\n");
  writeFileSync(join(ROOT, "src/stale.ts"), "export const stale = true;\n");
  writeFileSync(join(ROOT, "src/ignored.md"), "ignored\n");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("defaultGitFileHistoryEvidenceProvider", () => {
  it("caps both Git subprocesses to the request time remaining", async () => {
    let nowMs = NOW;
    const timeouts: number[] = [];
    const runner: GitProcessRunner = (args, options) => {
      timeouts.push(options.timeoutMs);
      if (args.includes("rev-parse")) {
        nowMs += 1_000;
        return Promise.resolve(ok(`${ROOT}\n`));
      }
      return Promise.resolve(ok(""));
    };

    await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => nowMs,
      deadlineAtMs: NOW + 1_500,
      runner,
    });

    expect(timeouts).toEqual([1_500, 500]);
  });

  it("does not start Git after the request deadline", async () => {
    let runnerCalls = 0;
    const runner: GitProcessRunner = () => {
      runnerCalls += 1;
      return Promise.resolve(ok(""));
    };

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      deadlineAtMs: NOW,
      runner,
    });

    expect(atoms).toEqual([]);
    expect(runnerCalls).toBe(0);
  });

  it("bounds a never-settling membership lookup and observes its late rejection", async () => {
    vi.useFakeTimers();
    const pending = deferred<GitProcessResult>();
    const runner: GitProcessRunner = () => pending.promise;
    const outcome = defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      deadlineAtMs: NOW + 10,
      runner,
    });
    const expectation = expect(outcome).resolves.toEqual([]);

    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    pending.reject(new Error("late git membership rejection"));
    await Promise.resolve();
  });

  it("forwards cancellation to Git and does not wait for a non-cooperative runner", async () => {
    const pending = deferred<GitProcessResult>();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const runner: GitProcessRunner = (_args, options) => {
      receivedSignal = options.abortSignal;
      return pending.promise;
    };
    const outcome = defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      signal: controller.signal,
      runner,
    });
    const expectation = expect(outcome).rejects.toBeInstanceOf(CancelledError);
    await vi.waitFor(() => {
      expect(receivedSignal).toBeDefined();
    });

    controller.abort();

    await expectation;
    expect(receivedSignal?.aborted).toBe(true);
    pending.resolve(ok(""));
  });

  it("stops path validation immediately when cancellation arrives during metadata I/O", async () => {
    const controller = new AbortController();
    const baseFs = nodeFs();
    let postAbortReads = 0;
    const fs: WorkspaceFs = {
      ...baseFs,
      realPath: (absolutePath): string => {
        if (controller.signal.aborted) postAbortReads += 1;
        return baseFs.realPath(absolutePath);
      },
      stat: (absolutePath): WorkspaceStat => {
        if (controller.signal.aborted) postAbortReads += 1;
        if (absolutePath.endsWith("src/recent.ts")) controller.abort();
        return baseFs.stat(absolutePath);
      },
    };
    const runner: GitProcessRunner = (args) =>
      Promise.resolve(
        args.includes("rev-parse")
          ? ok(`${ROOT}\n`)
          : ok(
              [
                `${RECORD_SEP}1700000000`,
                "src/recent.ts",
                "src/stale.ts",
                "src/ignored.md",
                "",
              ].join("\n"),
            ),
      );

    await expect(
      defaultGitFileHistoryEvidenceProvider({
        searchScope: scope(),
        query: query(),
        fs,
        nowMs: () => NOW,
        signal: controller.signal,
        runner,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(postAbortReads).toBe(0);
  });

  it("forwards a bounded signal to both Git subprocesses", async () => {
    const signals: AbortSignal[] = [];
    const runner: GitProcessRunner = (args, options) => {
      if (options.abortSignal !== undefined) signals.push(options.abortSignal);
      return Promise.resolve(args.includes("rev-parse") ? ok(`${ROOT}\n`) : ok(""));
    };

    await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      runner,
    });

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("starts no repository lookup after membership consumes the remaining time", async () => {
    let nowMs = NOW;
    const deadlineAtMs = NOW + 100;
    const probed = deadlineReadProbe(nodeFs(), () => nowMs >= deadlineAtMs);
    let runnerCalls = 0;
    const runner: GitProcessRunner = () => {
      runnerCalls += 1;
      nowMs = deadlineAtMs;
      return Promise.resolve(ok(`${ROOT}\n`));
    };

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: probed.fs,
      nowMs: () => nowMs,
      deadlineAtMs,
      runner,
    });

    expect(atoms).toEqual([]);
    expect(runnerCalls).toBe(1);
    expect(probed.lateReads()).toBe(0);
  });

  it("does not validate history paths after the history read consumes the remaining time", async () => {
    let nowMs = NOW;
    const deadlineAtMs = NOW + 100;
    const probed = deadlineReadProbe(nodeFs(), () => nowMs >= deadlineAtMs);
    let runnerCalls = 0;
    const runner: GitProcessRunner = (args) => {
      runnerCalls += 1;
      if (args.includes("rev-parse")) {
        return Promise.resolve(ok(`${ROOT}\n`));
      }
      nowMs = deadlineAtMs;
      return Promise.resolve(ok(`${RECORD_SEP}1700000000\nsrc/recent.ts\n`));
    };

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: probed.fs,
      nowMs: () => nowMs,
      deadlineAtMs,
      runner,
    });

    expect(atoms).toEqual([]);
    expect(runnerCalls).toBe(2);
    expect(probed.lateReads()).toBe(0);
  });

  // A virtual clock that expires inside path validation: the `stat` admitting `src/recent.ts`
  // returns a usable regular file AND leaves the request past its absolute deadline. `src/stale.ts`
  // was already validated and recorded before that, so a lane that kept what it had accumulated
  // would rank and emit both atoms after the deadline — the outcome the all-or-empty check after
  // the subprocess exists to prevent.
  function expiringStatFs(
    onExpire: () => void,
    expireOn: string,
  ): { readonly fs: WorkspaceFs; readonly statPaths: () => readonly string[] } {
    const baseFs = nodeFs();
    const statPaths: string[] = [];
    return {
      fs: {
        ...baseFs,
        stat: (absolutePath): WorkspaceStat => {
          const stat = baseFs.stat(absolutePath);
          statPaths.push(absolutePath);
          if (absolutePath.endsWith(expireOn)) onExpire();
          return stat;
        },
      },
      statPaths: () => statPaths,
    };
  }

  function historyRunner(stdout: string): GitProcessRunner {
    return (args) => Promise.resolve(args.includes("rev-parse") ? ok(`${ROOT}\n`) : ok(stdout));
  }

  it("discards the whole history lane when a mid-record path validation expires the deadline", async () => {
    let nowMs = NOW;
    const deadlineAtMs = NOW + 100;
    const probed = expiringStatFs(() => {
      nowMs = deadlineAtMs;
    }, "src/recent.ts");

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: probed.fs,
      nowMs: () => nowMs,
      deadlineAtMs,
      // One record whose second path is the one whose `stat` consumes the last of the budget.
      runner: historyRunner(
        [`${RECORD_SEP}1700000000`, "src/stale.ts", "src/recent.ts", ""].join("\n"),
      ),
    });

    expect(probed.statPaths().some((path) => path.endsWith("src/stale.ts"))).toBe(true);
    expect(atoms).toEqual([]);
  });

  it("discards the whole history lane when the last validated path expires the deadline", async () => {
    let nowMs = NOW;
    const deadlineAtMs = NOW + 100;
    const probed = expiringStatFs(() => {
      nowMs = deadlineAtMs;
    }, "src/recent.ts");

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: probed.fs,
      nowMs: () => nowMs,
      deadlineAtMs,
      // The expiring path is the final line of the final record, so no later loop iteration is
      // left to observe the trip: parsing itself has to report the lane as stopped.
      runner: historyRunner(
        `${RECORD_SEP}1700000000\nsrc/stale.ts${RECORD_SEP}1700000000\nsrc/recent.ts`,
      ),
    });

    expect(probed.statPaths().some((path) => path.endsWith("src/stale.ts"))).toBe(true);
    expect(atoms).toEqual([]);
  });

  it("turns bounded git log --name-only output into file-scoped recency/churn atoms", async () => {
    const mutableCalls: string[][] = [];
    const runner: GitProcessRunner = (args) => {
      mutableCalls.push([...args]);
      if (args.includes("rev-parse")) {
        return Promise.resolve(ok(`${ROOT}\n`));
      }
      return Promise.resolve(
        ok(
          [
            `${RECORD_SEP}1700000000`,
            "src/recent.ts",
            "src/deleted.ts",
            `${RECORD_SEP}1692224000`,
            "src/stale.ts",
            "../escape.ts",
            ".git/config",
            "",
          ].join("\n"),
        ),
      );
    };

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      runner,
      maxFiles: 10,
    });

    expect(atoms.map((atom) => atom.scopePath)).toEqual(["src/recent.ts", "src/stale.ts"]);
    expect(atoms.every((atom) => atom.provenance.kind === "git-history")).toBe(true);
    expect(atoms.every((atom) => atom.provenance.tool === "git-file-history")).toBe(true);
    expect(atoms.every((atom) => atom.metrics?.gitRecency !== undefined)).toBe(true);
    expect(atoms.every((atom) => atom.metrics?.gitChurn !== undefined)).toBe(true);
    expect(atoms[0]?.score).toBeGreaterThan(atoms[1]?.score ?? 0);
    const logArgs = mutableCalls[1] ?? [];
    expect(logArgs).toEqual(expect.arrayContaining(["-c", "core.quotepath=false", "log"]));
    expect(logArgs).toEqual(expect.arrayContaining(["--no-renames", "--name-only"]));
    expect(logArgs.some((arg) => arg.startsWith("--max-count="))).toBe(true);
    // KEIKO-0421: git log must be pathspec-scoped so GIT_HISTORY_COMMIT_LIMIT is spent
    // inside the selected root, not repo-wide. Repo root == scope root here → "." pathspec.
    const separatorIndex = logArgs.indexOf("--");
    expect(separatorIndex).toBeGreaterThanOrEqual(0);
    expect(logArgs.slice(separatorIndex + 1)).toEqual(["."]);
    // KEIKO-0516: repository resolution goes through the shared resolveGitMembership
    // primitive, which asks for --show-prefix in the same rev-parse call. The pre-fix
    // hand-rolled rev-parse asked only for --show-toplevel; the new call must include
    // both flags so the selectedRootPrefix is available without a second round-trip.
    const revParseCalls = mutableCalls.filter((args) => args.includes("rev-parse"));
    expect(revParseCalls).toHaveLength(1);
    expect(revParseCalls[0]).toEqual(expect.arrayContaining(["--show-toplevel", "--show-prefix"]));
  });

  it("scopes git log by the selected subfolder so the commit cap is not spent repo-wide (KEIKO-0421)", async () => {
    const subScopeRoot = join(ROOT, "src");
    mkdirSync(subScopeRoot, { recursive: true });
    // resolveGitMembership reads BOTH --show-toplevel AND --show-prefix from a single
    // rev-parse call, so the mock must emit both lines — otherwise the returned prefix
    // is empty and the log falls back to "." even when scope root != repo root. On macOS
    // the /var → /private/var realpath fallback masked this via relative(), but Linux
    // resolves the paths identically and needs the prefix directly. Trailing "/" mirrors
    // git's own --show-prefix output; trimTrailingSlash in keiko-git strips it.
    const mutableCalls: string[][] = [];
    const runner: GitProcessRunner = (args) => {
      mutableCalls.push([...args]);
      if (args.includes("rev-parse")) {
        return Promise.resolve(ok(`${ROOT}\nsrc/\n`));
      }
      return Promise.resolve(ok(""));
    };
    const scopedSearch: SearchScope = {
      ...scope(),
      workspace: { ...scope().workspace, root: subScopeRoot },
    };
    await defaultGitFileHistoryEvidenceProvider({
      searchScope: scopedSearch,
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      runner,
      maxFiles: 10,
    });
    const logArgs = mutableCalls[1] ?? [];
    const separatorIndex = logArgs.indexOf("--");
    expect(separatorIndex).toBeGreaterThanOrEqual(0);
    // Pathspec is literalised via :(literal) so a directory whose name looks like a git
    // pathspec magic word (e.g. ":(exclude)docs") is treated as a literal folder name.
    expect(logArgs.slice(separatorIndex + 1)).toEqual([":(literal)src"]);
  });

  it("respects selected relativePaths", async () => {
    const runner: GitProcessRunner = (args) =>
      Promise.resolve(
        args.includes("rev-parse")
          ? ok(`${ROOT}\n`)
          : ok([`${RECORD_SEP}1700000000`, "src/recent.ts", "src/stale.ts", ""].join("\n")),
      );

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(["src/stale.ts"]),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      runner,
      maxFiles: 10,
    });

    expect(atoms.map((atom) => atom.scopePath)).toEqual(["src/stale.ts"]);
  });

  it("does not emit history evidence for a path alias that resolves into a denied target", async () => {
    mkdirSync(join(ROOT, ".aws"), { recursive: true });
    writeFileSync(join(ROOT, ".aws/secret.ts"), "export const privateValue = true;\n");
    const lexicalPath = join(ROOT, "src/recent.ts");
    const deniedTarget = realpathSync(join(ROOT, ".aws/secret.ts"));
    const baseFs = nodeFs();
    let deniedStats = 0;
    const fs: WorkspaceFs = {
      ...baseFs,
      realPath: (absolutePath): string =>
        absolutePath === lexicalPath ? deniedTarget : baseFs.realPath(absolutePath),
      stat: (absolutePath): WorkspaceStat => {
        if (absolutePath === deniedTarget) deniedStats += 1;
        return baseFs.stat(absolutePath);
      },
    };
    const runner: GitProcessRunner = (args) =>
      Promise.resolve(
        args.includes("rev-parse")
          ? ok(`${ROOT}\n`)
          : ok([`${RECORD_SEP}1700000000`, "src/recent.ts", ""].join("\n")),
      );

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs,
      nowMs: () => NOW,
      runner,
      maxFiles: 10,
    });

    expect(deniedStats).toBe(0);
    expect(atoms).toEqual([]);
  });
});

describe("git-history evidence activity log (AGENTS.md §8 Rule 1)", () => {
  // Both git reads in this provider answer a failure with "no evidence". That is the right answer
  // — a grounded pack degrades rather than fails — but it used to leave the log with no way to
  // tell an ask whose history ring silently emptied from one where the repository genuinely had
  // no matching history. These pin that the difference is now recorded, and joinable to the ask.

  it("reports a failed history read under the ask's own correlation id", async () => {
    const activity = captureActivityLog();
    const runner: GitProcessRunner = (args) =>
      Promise.resolve(
        args.includes("rev-parse") ? ok(`${ROOT}\n`) : fail("fatal: bad revision 'HEAD'"),
      );

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      runner,
      maxFiles: 10,
      correlationId: "corr-grounded-ask-01",
      activityLog: activity.sink,
    });

    // The degraded ANSWER is unchanged: an empty ring, never a thrown ask.
    expect(atoms).toEqual([]);
    expect(activity.events).toHaveLength(1);
    expect(activity.events[0]).toMatchObject({
      level: "warn",
      category: "diagnostic",
      op: "git.process.failed",
      correlationId: "corr-grounded-ask-01",
      errorKind: "git-error",
      extra: { subcommand: "log", exitCode: 128 },
    });
  });

  it("reports a failed MEMBERSHIP read, which never reaches the history read at all", async () => {
    // `resolveGitRepositoryForHistory` returns early on a failed rev-parse, so this outcome never
    // passes the provider's own history branch. It is observed because the observation is on the
    // runner both reads share — the same reason the routes' membership failure is observed.
    const activity = captureActivityLog();
    const runner: GitProcessRunner = () =>
      Promise.resolve(fail("fatal: not a git repository (or any of the parent directories)"));

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      runner,
      maxFiles: 10,
      correlationId: "corr-grounded-ask-02",
      activityLog: activity.sink,
    });

    expect(atoms).toEqual([]);
    expect(activity.events).toHaveLength(1);
    expect(activity.events[0]).toMatchObject({
      op: "git.process.failed",
      correlationId: "corr-grounded-ask-02",
      errorKind: "not-a-repository",
      extra: { subcommand: "rev-parse" },
    });
  });

  it("reports a spawn-boundary refusal on the retrieval path as a security event", async () => {
    const activity = captureActivityLog();
    const runner: GitProcessRunner = (args) =>
      Promise.resolve(
        args.includes("rev-parse")
          ? ok(`${ROOT}\n`)
          : {
              ...fail("refused git option: --ext-diff"),
              refusal: "diff-enabling-flag" as const,
            },
      );

    await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      runner,
      maxFiles: 10,
      correlationId: "corr-grounded-ask-03",
      activityLog: activity.sink,
    });

    expect(activity.events).toHaveLength(1);
    expect(activity.events[0]).toMatchObject({
      level: "error",
      category: "security",
      op: "git.process.refused",
      correlationId: "corr-grounded-ask-03",
      extra: { refusal: "diff-enabling-flag" },
    });
  });

  it("writes nothing when the history read succeeds", async () => {
    const activity = captureActivityLog();
    const runner: GitProcessRunner = (args) =>
      Promise.resolve(
        args.includes("rev-parse")
          ? ok(`${ROOT}\n`)
          : ok([`${RECORD_SEP}1700000000`, "src/recent.ts", ""].join("\n")),
      );

    const atoms = await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      runner,
      maxFiles: 10,
      correlationId: "corr-grounded-ask-04",
      activityLog: activity.sink,
    });

    expect(atoms.map((atom) => atom.scopePath)).toEqual(["src/recent.ts"]);
    expect(activity.events).toEqual([]);
  });

  it("carries no repository path or git output into the line", async () => {
    const activity = captureActivityLog();
    const runner: GitProcessRunner = (args) =>
      Promise.resolve(
        args.includes("rev-parse")
          ? ok(`${ROOT}\n`)
          : fail(`fatal: unable to read ${ROOT}/.git/objects/ab/cdef`),
      );

    await defaultGitFileHistoryEvidenceProvider({
      searchScope: scope(),
      query: query(),
      fs: nodeFs(),
      nowMs: () => NOW,
      runner,
      maxFiles: 10,
      correlationId: "corr-grounded-ask-05",
      activityLog: activity.sink,
    });

    const serialized = JSON.stringify(activity.events);
    expect(serialized).not.toContain(ROOT);
    expect(serialized).not.toContain(".git/objects");
  });
});
