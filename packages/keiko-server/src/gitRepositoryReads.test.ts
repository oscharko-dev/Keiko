import { captureActivityLog } from "./activityLogCapture.test-support.js";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHistoryResponse } from "@oscharko-dev/keiko-contracts";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import type { RouteContext } from "./routes.js";
import type { UiStore } from "./store/index.js";
import {
  handleGitHistory,
  handleGitRemotes,
  handleGitSummary,
  invalidateGitSummaryCache,
  parseHistory,
  parseShortstatHistory,
  parseRemotes,
} from "./gitRepositoryReads.js";
import {
  defaultGitNetworkProcessRunner,
  defaultGitProcessRunner,
  gitEnv,
  networkGitEnv,
  selectedRootPathspecArgs,
  type GitProcessRunner,
} from "./gitRoutes.js";
import { writeNodeExecutableFixture } from "./editor/lsp/testing/executableFixture.js";

let root: string;
let store: UiStore;

function deps(runner: GitProcessRunner, redactor = buildRedactor({})): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor,
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    gitRouteOptions: { runner, maxDiffBytes: 64, maxStatusBytes: 4096, maxChanges: 10 },
  };
}

function ctx(path: string): RouteContext {
  return {
    correlationId: undefined,
    req: Readable.from([]) as unknown as IncomingMessage,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

const ok = (stdout: string): Awaited<ReturnType<GitProcessRunner>> => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: "",
  truncated: false,
});

const fail = (stderr: string, exitCode = 128): Awaited<ReturnType<GitProcessRunner>> => ({
  exitCode,
  signal: null,
  stdout: "",
  stderr,
  truncated: false,
});

// Porcelain v2 NUL-separated payload helper (matches `status --porcelain=v2 --branch -z`).
function porcelain(records: readonly string[]): string {
  return records.join("\0") + "\0";
}

async function runRealGit(args: readonly string[]): Promise<void> {
  const result = await defaultGitProcessRunner(args, {
    cwd: root,
    maxBytes: 8192,
    timeoutMs: 60_000,
  });
  expect(result.exitCode, result.stderr).toBe(0);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "keiko-git-reads-"));
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  // A git process the fixture spawned can still be closing when the tree is removed; retry the
  // teardown instead of failing the suite on a transient ENOTEMPTY/EBUSY (CI, PR #3381 round 2).
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("GET /api/git/summary", () => {
  it("summarizes a clean repository with upstream, remote aliases, and last-sync metadata", async () => {
    // FETCH_HEAD must resolve UNDER the repository root for lastSync to be reported (containment
    // guard). Create a real file inside the repo and return its realpath from the rev-parse mock,
    // matching the realpath'd repositoryRoot that resolveRepository computes.
    const fetchHead = join(root, "FETCH_HEAD");
    await writeFile(fetchHead, "0".repeat(40));
    const realFetchHead = await realpath(fetchHead);
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(
        ok(porcelain(["# branch.head main", "# branch.upstream origin/main", "# branch.ab +0 -0"])),
      )
      .mockResolvedValueOnce(
        ok(
          "origin\thttps://example.invalid/repo.git (fetch)\norigin\thttps://example.invalid/repo.git (push)\n",
        ),
      )
      .mockResolvedValueOnce(ok(`${realFetchHead}\n`));

    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      schemaVersion: "1",
      state: "available",
      available: true,
      branch: "main",
      detached: false,
      upstream: { ref: "origin/main", remote: "origin", branch: "main" },
      ahead: 0,
      behind: 0,
      clean: true,
      remotes: [
        {
          name: "origin",
        },
      ],
    });
    expect(JSON.stringify(result.body)).not.toContain("https://example.invalid/repo.git");
    // The in-repo FETCH_HEAD exists and is contained, so lastSync is reported.
    expect((result.body as { lastSync?: unknown }).lastSync).toBeDefined();
  });

  it("deduplicates repeated summary reads for the same deps and root within the TTL", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok(porcelain(["# branch.head main", "# branch.ab +0 -0"])))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(""));
    const sharedDeps = deps(runner, (value) => value);
    const path = `/api/git/summary?root=${encodeURIComponent(root)}`;

    const first = await handleGitSummary(ctx(path), sharedDeps);
    const second = await handleGitSummary(ctx(path), sharedDeps);

    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it("omits lastSync when the FETCH_HEAD path resolves outside the repository root", async () => {
    // A FETCH_HEAD path outside the repo (e.g. a manipulated rev-parse result) must be rejected by
    // the containment guard even though the file exists and is stat-able. The file lives in its own
    // temp dir that is a sibling of the repo root, so it is genuinely out of tree.
    const outsideDir = await mkdtemp(join(tmpdir(), "keiko-git-reads-outside-"));
    const outside = join(outsideDir, "FETCH_HEAD");
    await writeFile(outside, "0".repeat(40));
    const realOutside = await realpath(outside);
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok(porcelain(["# branch.head main"])))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(`${realOutside}\n`));

    try {
      const result = await handleGitSummary(
        ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
        deps(runner, (value) => value),
      );
      expect((result.body as { lastSync?: unknown }).lastSync).toBeUndefined();
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("counts staged, unstaged, untracked, and conflicted entries on a dirty worktree", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(
        ok(
          porcelain([
            "# branch.head main",
            "# branch.ab +1 -2",
            "1 M. N... 100644 100644 100644 aaa bbb src/staged.ts",
            "1 .M N... 100644 100644 100644 ccc ddd src/dirty.ts",
            "u UU N... 100644 100644 100644 100644 eee fff ggg src/conflict.ts",
            "? src/new.ts",
          ]),
        ),
      )
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(fail("missing", 1));

    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(result.body).toMatchObject({
      available: true,
      clean: false,
      ahead: 1,
      behind: 2,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 1,
      conflictedCount: 1,
      remotes: [],
    });
  });

  it("reports no upstream as zeroed ahead/behind and undefined upstream", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok(porcelain(["# branch.head feature"])))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(fail("missing", 1));

    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(result.body).toMatchObject({ branch: "feature", ahead: 0, behind: 0 });
    expect((result.body as { upstream?: unknown }).upstream).toBeUndefined();
  });

  it("reports a detached HEAD", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok(porcelain(["# branch.head (detached)"])))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(fail("missing", 1));

    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(result.body).toMatchObject({ available: true, detached: true });
    expect((result.body as { branch?: unknown }).branch).toBeUndefined();
  });

  it("returns an empty remotes list when none are configured", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok(porcelain(["# branch.head main"])))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(fail("missing", 1));

    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(result.body).toMatchObject({ remotes: [] });
  });

  it("surfaces an unsafe repository without exposing the secret path", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(fail("fatal: detected dubious ownership in repository at '/secret'"));

    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.body).toMatchObject({
      state: "unsafe",
      available: false,
      reason: "unsafe-repository",
      remotes: [],
      ahead: 0,
      behind: 0,
    });
    expect(JSON.stringify(result.body)).not.toContain("/secret");
  });

  it("maps a missing Git executable to a git-missing unavailable summary", async () => {
    const runner = vi.fn<GitProcessRunner>().mockResolvedValueOnce(fail("spawn git ENOENT", 127));

    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.body).toMatchObject({
      state: "unavailable",
      available: false,
      reason: "git-missing",
    });
  });

  it("maps a status command failure to an unavailable summary", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(fail("fatal: detected dubious ownership"))
      // The summary route reads `status` and `remote -v` concurrently, so a fake scripted with
      // only the two calls above answers a third call with `undefined` — a value no
      // GitProcessRunner can return. The base result keeps the fake inside its own declared
      // contract instead of relying on the route never dereferencing that answer.
      .mockResolvedValue(ok(""));

    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.body).toMatchObject({
      state: "unsafe",
      available: false,
      reason: "unsafe-repository",
    });
  });

  it("marks process-truncated status output as truncated", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce({ ...ok(porcelain(["# branch.head main"])), truncated: true })
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(fail("missing", 1));

    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(result.body).toMatchObject({ truncated: true });
  });

  it("omits lastSync when FETCH_HEAD cannot be stat-ed", async () => {
    const missing = join(root, "does-not-exist", "FETCH_HEAD");
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok(porcelain(["# branch.head main"])))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(`${missing}\n`));

    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect((result.body as { lastSync?: unknown }).lastSync).toBeUndefined();
  });

  // Codex P2 (thread 3788736980): a restored archive or `touch -d 1960-01-01` leaves FETCH_HEAD
  // with a pre-epoch mtime, which Node reports as a NEGATIVE mtimeMs -- forwarding that verbatim
  // would make the wire contract's own validator (isGitLastSyncMetadata, which requires a
  // non-negative integer) reject a response this route itself produced, failing the summary fetch
  // for an otherwise valid local repository. Omitted here rather than surfaced as a meaningless
  // negative timestamp, the same way every other "cannot determine" case in readLastSync is.
  it("omits lastSync when FETCH_HEAD has a pre-epoch mtime", async () => {
    const fetchHead = join(root, "FETCH_HEAD");
    await writeFile(fetchHead, "0".repeat(40));
    const realFetchHead = await realpath(fetchHead);
    const preEpoch = new Date("1960-01-01T00:00:00Z");
    await utimes(realFetchHead, preEpoch, preEpoch);
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok(porcelain(["# branch.head main"])))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(`${realFetchHead}\n`));

    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect((result.body as { lastSync?: unknown }).lastSync).toBeUndefined();
  });
});

// A large untracked tree makes `git status` outgrow the byte cap; the runner then kills git and
// returns this exact shape. That cut is a bounded, truncated summary, not an unavailable repository.
describe("GET /api/git/summary — byte-cap cut (large untracked tree)", () => {
  const capCut = (
    stdout: string,
    overrides: Partial<Awaited<ReturnType<GitProcessRunner>>> = {},
  ): Awaited<ReturnType<GitProcessRunner>> => ({
    exitCode: null,
    signal: "SIGTERM",
    stdout,
    stderr: "",
    truncated: true,
    ...overrides,
  });

  async function summaryFor(
    statusRun: Awaited<ReturnType<GitProcessRunner>>,
    activity = captureActivityLog(),
  ): Promise<{ readonly body: unknown; readonly activity: ReturnType<typeof captureActivityLog> }> {
    const runner: GitProcessRunner = (args) => {
      const subcommand = args[4];
      if (subcommand === "rev-parse") return Promise.resolve(ok(`${root}\n`));
      if (subcommand === "status") return Promise.resolve(statusRun);
      return Promise.resolve(ok(""));
    };
    const base = deps(runner, (value) => value);
    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      {
        ...base,
        gitRouteOptions: { ...base.gitRouteOptions, runner, activityLog: activity.sink },
      },
    );
    expect(result.status).toBe(200);
    return { body: result.body, activity };
  }

  it.each([
    {
      name: "inside a plain record",
      stdout: porcelain(["# branch.head main", "# branch.ab +2 -1", "? a.ts"]) + "? node_mod",
      untracked: 1,
    },
    {
      name: "right after a NUL",
      stdout: porcelain(["# branch.head main", "# branch.ab +2 -1", "? a.ts", "? b.ts"]),
      untracked: 2,
    },
    {
      name: "inside the old-path record of a rename",
      stdout:
        porcelain(["# branch.head main", "# branch.ab +2 -1", "? a.ts"]) +
        "2 R. N... 100644 100644 100644 aaa bbb R100 renamed.ts\0old-na",
      untracked: 1,
    },
    {
      name: "right after the first record of a rename",
      stdout: porcelain([
        "# branch.head main",
        "# branch.ab +2 -1",
        "? a.ts",
        "2 R. N... 100644 100644 100644 aaa bbb R100 renamed.ts",
      ]),
      untracked: 1,
    },
  ])("summarizes a status the cap cut $name", async ({ stdout, untracked }) => {
    const { body, activity } = await summaryFor(capCut(stdout));

    expect(body).toMatchObject({
      state: "available",
      available: true,
      branch: "main",
      ahead: 2,
      behind: 1,
      untrackedCount: untracked,
      stagedCount: 0,
      truncated: true,
      clean: false,
    });
    expect(activity.withOp("git.process.failed")).toHaveLength(0);
    expect(activity.withOp("git.status.bounded")[0]).toMatchObject({
      extra: { surface: "summary", maxBytes: 4096 },
    });
  });

  it("summarizes a status whose only complete records are the branch headers as not clean", async () => {
    const { body } = await summaryFor(
      capCut(porcelain(["# branch.oid abc", "# branch.head main"]) + "? node"),
    );

    expect(body).toMatchObject({
      available: true,
      branch: "main",
      untrackedCount: 0,
      truncated: true,
      clean: false,
    });
  });

  // Each row is a whole, bounded status but for the one thing its name says.
  const wholeCut = porcelain(["# branch.head main", "? a.ts"]);

  it.each([
    { name: "a cut header", run: capCut("# branch.oi") },
    // The v2 header is a block: a cut inside it would read as a branch without an upstream, so
    // the block counts only when something of an entry follows it.
    {
      name: "a cut inside the header block",
      run: capCut(porcelain(["# branch.oid abc", "# branch.head main"]) + "# branch.ab +1"),
    },
    {
      name: "a cut right after a header record",
      run: capCut(porcelain(["# branch.oid abc", "# branch.head main"])),
    },
    { name: "a timeout", run: capCut(wholeCut, { timedOut: true }) },
    { name: "an abort", run: capCut(wholeCut, { aborted: true }) },
    { name: "git error output", run: capCut(wholeCut, { stderr: "x" }) },
    { name: "exit 128", run: capCut(wholeCut, { exitCode: 128 }) },
  ])("keeps $name an unavailable summary", async ({ run }) => {
    const { body } = await summaryFor(run);

    expect(body).toMatchObject({ available: false, state: "unavailable" });
  });
});

function syntheticHead(subject: string): string {
  return ["a".repeat(40), "aaaaaaa", "", "author", "date", "", subject].join("\0");
}

describe("GET /api/git/history", () => {
  function logRecord(fields: {
    sha: string;
    short: string;
    parents: string;
    author: string;
    date: string;
    refs: string;
    subject: string;
    paths?: readonly string[];
  }): string {
    const head = [
      fields.sha,
      fields.short,
      fields.parents,
      fields.author,
      fields.date,
      fields.refs,
      fields.subject,
    ].join("\0");
    const paths = fields.paths ?? [];
    // `log --name-only -z`: a commit listing paths ends with an empty token, one listing none is
    // just its header and a NUL.
    return paths.length === 0
      ? `${head}\0`
      : `${head}\n${paths.map((path) => `${path}\0`).join("")}\0`;
  }

  it("parses commit entries with refs, parents, and changed-file counts", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(
        ok(
          logRecord({
            sha: "1111111111111111111111111111111111111111",
            short: "1111111",
            parents: "2222222",
            author: "Ada Lovelace",
            date: "2026-06-27T10:00:00+00:00",
            refs: "HEAD -> main, origin/main",
            subject: "Add feature",
            paths: ["a.ts", "dir/b.ts", "we\nird é.ts"],
          }),
        ),
      );

    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      available: true,
      limit: 50,
      skip: 0,
      entries: [
        {
          sha: "1111111111111111111111111111111111111111",
          shortSha: "1111111",
          subject: "Add feature",
          author: "Ada Lovelace",
          date: "2026-06-27T10:00:00+00:00",
          refs: ["HEAD -> main", "origin/main"],
          parentCount: 1,
          changedFileCount: 3,
        },
      ],
    });
  });

  it("treats a merge commit with no listed paths as parentCount 2 and zero changed files", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(
        ok(
          logRecord({
            sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            short: "aaaaaaa",
            parents: "bbbbbbb ccccccc",
            author: "Merger",
            date: "2026-06-27T11:00:00+00:00",
            refs: "",
            subject: "Merge branch 'feature'",
          }),
        ),
      );

    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(result.body).toMatchObject({
      entries: [{ parentCount: 2, changedFileCount: 0, refs: [] }],
    });
  });

  it("returns empty history for a repository with no commits", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(
        fail("fatal: your current branch 'main' does not have any commits yet"),
      );

    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.body).toMatchObject({ available: true, entries: [] });
  });

  it("rejects a non-integer limit with a 400", async () => {
    const runner = vi.fn<GitProcessRunner>();

    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}&limit=abc`),
      deps(runner),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a non-integer skip with a 400", async () => {
    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}&skip=1.5`),
      deps(vi.fn<GitProcessRunner>()),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("clamps an out-of-range limit and reflects it in the response and git args", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok(""));

    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}&limit=9999`),
      deps(runner, (value) => value),
    );

    expect(result.body).toMatchObject({ limit: 200, entries: [] });
    expect(runner.mock.calls[1]?.[0]).toEqual(expect.arrayContaining(["--max-count=200"]));
  });

  it("marks truncated when the returned entry count equals the limit", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(
        ok(
          [
            logRecord({
              sha: "1111111111111111111111111111111111111111",
              short: "1111111",
              parents: "",
              author: "A",
              date: "2026-06-27T10:00:00+00:00",
              refs: "",
              subject: "first",
            }),
            logRecord({
              sha: "2222222222222222222222222222222222222222",
              short: "2222222",
              parents: "1111111",
              author: "B",
              date: "2026-06-27T11:00:00+00:00",
              refs: "",
              subject: "second",
            }),
          ].join(""),
        ),
      );

    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}&limit=2`),
      deps(runner, (value) => value),
    );

    expect(result.body).toMatchObject({ truncated: true });
    expect((result.body as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it("returns an unavailable history for an unsafe repository", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(fail("fatal: detected dubious ownership"));

    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.body).toMatchObject({
      state: "unsafe",
      available: false,
      reason: "unsafe-repository",
      entries: [],
    });
  });

  it("maps a missing Git executable to a git-missing unavailable history", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(fail("git executable unavailable", 127));

    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.body).toMatchObject({ available: false, reason: "git-missing", entries: [] });
  });

  it("marks process-truncated history output as truncated", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce({ ...ok(""), truncated: true })
      .mockResolvedValueOnce(ok(""));

    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(result.body).toMatchObject({ truncated: true });
  });
});

// The selected root is the unit of scope for every other Git read (status filters change records by
// `selectedRootPrefix`, diff pathspecs the same prefix). History used to be the one exception: it
// ran `git log` with `-C <repositoryRoot>` and no pathspec, so a user who selected a subfolder was
// shown commits that never touched it — and the "showing the most recent N commits" truncation
// label was computed over that repository-wide page. These exercise the real `git` binary so the
// proof is the observed commit set, not an argument shape.
describe("GET /api/git/history — selected-root scoping", () => {
  async function commitFile(relativePaths: readonly string[], subject: string): Promise<void> {
    for (const relativePath of relativePaths) {
      const target = join(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${subject}\n`, "utf8");
    }
    await runRealGit(["add", "--all"]);
    await runRealGit(["commit", "--quiet", "-m", subject]);
  }

  // Four commits: two that never touch `sub/`, one that only touches it, and one that spans both.
  async function initMixedHistory(): Promise<void> {
    await runRealGit(["init", "--quiet"]);
    await runRealGit(["config", "user.email", "fixture@example.invalid"]);
    await runRealGit(["config", "user.name", "Keiko Fixture"]);
    // Hermetic: a commit otherwise spawns a DETACHED `git maintenance run --auto`, which can outlive
    // the test and write into `.git/objects` while `afterEach` removes the tree (ENOTEMPTY on the
    // loaded coverage runner). Nothing here measures maintenance, so none may run.
    await runRealGit(["config", "gc.auto", "0"]);
    await runRealGit(["config", "gc.autoDetach", "false"]);
    await runRealGit(["config", "maintenance.auto", "false"]);
    await commitFile(["outside/first.txt"], "outside first");
    await commitFile(["sub/inside.txt"], "inside only");
    await commitFile(["outside/second.txt"], "outside second");
    await commitFile(["sub/spanning.txt", "outside/spanning.txt"], "spans both");
  }

  async function readHistory(selectedRoot: string, query = ""): Promise<GitHistoryResponse> {
    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(selectedRoot)}${query}`),
      deps(defaultGitProcessRunner, (value) => value),
    );
    expect(result.status).toBe(200);
    return result.body as GitHistoryResponse;
  }

  it("returns only the commits that touched the selected subfolder", async () => {
    await initMixedHistory();

    const history = await readHistory(join(root, "sub"));

    expect(history.available).toBe(true);
    expect(history.entries.map((entry) => entry.subject)).toEqual(["spans both", "inside only"]);
  });

  it("keeps a selected root that IS the repository root unscoped", async () => {
    await initMixedHistory();

    const history = await readHistory(root);

    expect(history.entries.map((entry) => entry.subject)).toEqual([
      "spans both",
      "outside second",
      "inside only",
      "outside first",
    ]);
  });

  it("reports an available, empty history for a subfolder no commit has touched", async () => {
    await initMixedHistory();
    // A folder that exists on disk but was never committed: git exits 0 with no records, which must
    // stay "available with nothing to show" rather than borrowing the empty-repository or the
    // unavailable envelope.
    await mkdir(join(root, "untouched"), { recursive: true });

    const history = await readHistory(join(root, "untouched"));

    expect(history.available).toBe(true);
    expect(history.reason).toBeUndefined();
    expect(history.entries).toHaveLength(0);
    expect(history.truncated).toBe(false);
  });

  it("counts only the files a commit changed inside the selected subfolder", async () => {
    await initMixedHistory();

    const spanning = (await readHistory(join(root, "sub"))).entries.find(
      (entry) => entry.subject === "spans both",
    );

    expect(spanning?.changedFileCount).toBe(1);
  });

  it("reports the truncation label against the scoped page, not the repository", async () => {
    await initMixedHistory();

    // Three requested, two in scope: the page is complete, so it must NOT claim truncation even
    // though the repository holds four commits (which is what the unscoped read returned).
    const complete = await readHistory(join(root, "sub"), "&limit=3");
    expect(complete.entries).toHaveLength(2);
    expect(complete.truncated).toBe(false);

    // One requested, two in scope: a full page still means "there may be more".
    const partial = await readHistory(join(root, "sub"), "&limit=1");
    expect(partial.entries).toHaveLength(1);
    expect(partial.truncated).toBe(true);
  });

  it("passes the derived selected-root pathspec to git as the argument tail", async () => {
    const prefix = basename(root);
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${dirname(root)}\n${prefix}\n`))
      .mockResolvedValueOnce(ok(""));

    await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    // Derived from the production translator so a change to the pathspec form cannot leave this
    // fixture asserting a shape the route no longer emits.
    const pathspec = selectedRootPathspecArgs(prefix);
    expect(pathspec).toHaveLength(2);
    const args = runner.mock.calls[1]?.[0] ?? [];
    expect(args.slice(-pathspec.length)).toEqual([...pathspec]);
  });

  it("emits no pathspec separator at the repository root", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok(""));

    await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(selectedRootPathspecArgs("")).toHaveLength(0);
    expect(runner.mock.calls[1]?.[0]).not.toContain("--");
  });
});

describe("GET /api/git/remotes", () => {
  it("lists multiple remotes with deduplicated fetch/push URLs", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(
        ok(
          [
            "origin\thttps://example.invalid/origin.git (fetch)",
            "origin\thttps://example.invalid/origin.git (push)",
            "upstream\thttps://example.invalid/upstream.git (fetch)",
            "upstream\thttps://example.invalid/upstream.git (push)",
            "",
          ].join("\n"),
        ),
      );

    const result = await handleGitRemotes(
      ctx(`/api/git/remotes?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      available: true,
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://example.invalid/origin.git",
          pushUrl: "https://example.invalid/origin.git",
        },
        {
          name: "upstream",
          fetchUrl: "https://example.invalid/upstream.git",
          pushUrl: "https://example.invalid/upstream.git",
        },
      ],
    });
  });

  it("returns an empty remotes list when none are configured", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok(""));

    const result = await handleGitRemotes(
      ctx(`/api/git/remotes?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    expect(result.body).toMatchObject({ available: true, remotes: [] });
  });

  it("surfaces an unsafe repository as unavailable", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(fail("fatal: detected dubious ownership"));

    const result = await handleGitRemotes(
      ctx(`/api/git/remotes?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.body).toMatchObject({
      state: "unsafe",
      available: false,
      reason: "unsafe-repository",
      remotes: [],
    });
  });

  it("maps a missing Git executable to a git-missing unavailable remotes response", async () => {
    const runner = vi.fn<GitProcessRunner>().mockResolvedValueOnce(fail("spawn git ENOENT", 127));

    const result = await handleGitRemotes(
      ctx(`/api/git/remotes?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.body).toMatchObject({
      available: false,
      reason: "git-missing",
      remotes: [],
    });
  });
});

// The local-read env is config-isolated (no user gitconfig / credential helper / SSH identity); the
// network-sync env preserves only the account/SSH-agent state needed for credentials and never
// prompts or inherits arbitrary process secrets.
describe("git process env factories", () => {
  it("hardens the local-read env: HOME and global config point at the null device", () => {
    const env = gitEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    if (process.platform === "win32") {
      expect(env.GIT_CONFIG_GLOBAL).toBe("NUL");
    } else {
      expect(env.HOME).toBe("/nonexistent");
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    }
  });

  it("keeps the network-sync env credential-capable but allowlisted and fail-closed", () => {
    const sentinelKey = "KEIKO_NETWORK_ENV_SENTINEL";
    vi.stubEnv(sentinelKey, "inherited-value");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws-secret-that-must-not-reach-git");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/tmp/attacker.gitconfig");
    vi.stubEnv("GIT_ASKPASS", "/tmp/unsafe-askpass");
    vi.stubEnv("SSH_ASKPASS", "/tmp/unsafe-ssh-askpass");
    vi.stubEnv("HOME", "/home/keiko-test-user");
    vi.stubEnv("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock");
    try {
      const env = networkGitEnv();
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env[sentinelKey]).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.HOME).toBe("/home/keiko-test-user");
      expect(env.HOME).not.toBe("/nonexistent");
      expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
      // SSH runs in BatchMode and requires known host keys, so it fails closed instead of prompting
      // or silently trusting a first-use host.
      expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
      expect(env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
      expect(env.GIT_SSH_COMMAND).toContain("NumberOfPasswordPrompts=0");
      expect(env.GIT_SSH_COMMAND).not.toContain("accept-new");
      expect(env.GIT_ASKPASS).not.toBe("/tmp/unsafe-askpass");
      expect(env.SSH_ASKPASS).not.toBe("/tmp/unsafe-ssh-askpass");
      expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
      expect(env.GCM_INTERACTIVE).toBe("never");
      expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
      // User git config remains discoverable through HOME/XDG, but env-level GIT_CONFIG_* overrides
      // are not inherited from the caller.
      expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // This child-observed fixture is a POSIX script. On Windows the helper writes git.CMD,
  // which the production image-only resolver correctly refuses rather than invoking a shell.
  it.skipIf(process.platform === "win32")(
    "uses the hardened network env at the actual fetch and pull spawn boundary",
    async () => {
      const binDir = await mkdtemp(join(tmpdir(), "keiko-git-network-bin-"));
      const capturePath = join(binDir, "git-env.jsonl");
      writeNodeExecutableFixture(
        binDir,
        "git",
        [
          'const fs = require("node:fs");',
          `fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + "\\n");`,
          "process.exit(0);",
        ].join("\n"),
      );
      vi.stubEnv("PATH", `${binDir}${delimiter}${process.env.PATH ?? ""}`);
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws-secret-that-must-not-reach-git");
      vi.stubEnv("GIT_CONFIG_GLOBAL", "/tmp/attacker.gitconfig");
      vi.stubEnv("GIT_ASKPASS", "/tmp/unsafe-askpass");
      try {
        const fetch = await defaultGitNetworkProcessRunner(["fetch", "--no-tags"], {
          cwd: root,
          maxBytes: 4096,
          timeoutMs: 5_000,
        });
        const pull = await defaultGitNetworkProcessRunner(["pull", "--ff-only"], {
          cwd: root,
          maxBytes: 4096,
          timeoutMs: 5_000,
        });
        for (const result of [fetch, pull]) {
          expect(result).toMatchObject({
            exitCode: 0,
            truncated: false,
            credentialHelperSource: "none",
          });
        }
        const records = (await readFile(capturePath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { args: readonly string[]; env: NodeJS.ProcessEnv });
        expect(
          records.map((record) =>
            record.args.find((arg) => arg === "config" || arg === "fetch" || arg === "pull"),
          ),
        ).toEqual(["config", "fetch", "config", "pull"]);
        for (const record of records) {
          const discovery = record.args.includes("config");
          // Only the bounded host-helper discovery can read system configuration. Both remote
          // operations restore isolation; every phase retains the same credential/secret floor.
          expect(record.env.GIT_CONFIG_NOSYSTEM).toBe(discovery ? "0" : "1");
          if (discovery) {
            expect(record.args.slice(-6)).toEqual([
              "config",
              "--null",
              "--show-scope",
              "--no-includes",
              "--get-regexp",
              String.raw`^credential(\..*)?\.helper$`,
            ]);
          }
          expect(record.args).toContain("protocol.ext.allow=never");
          expect(record.args).toContain("credential.helper=");
          expect(record.env.GIT_TERMINAL_PROMPT).toBe("0");
          expect(record.env.GCM_INTERACTIVE).toBe("never");
          expect(record.env.SSH_ASKPASS_REQUIRE).toBe("never");
          expect(record.env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
          expect(record.env.GIT_SSH_COMMAND).toContain("NumberOfPasswordPrompts=0");
          expect(record.env.GIT_ASKPASS).not.toBe("/tmp/unsafe-askpass");
          expect(record.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
          expect(record.env.GIT_CONFIG_GLOBAL).toBeUndefined();
        }
      } finally {
        vi.unstubAllEnvs();
        await rm(binDir, { recursive: true, force: true });
      }
    },
  );
});

// Read routes are local and never authenticate. An auth-shaped failure therefore has no dedicated
// outcome here — it falls through classifyFailure to "git-error" (the auth-failed OUTCOME is exercised
// end-to-end only by the sync routes). These tests lock that mapping across the three handlers.
describe("read routes — auth-shaped status failure maps to git-error", () => {
  const authStderr =
    "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled";

  async function summaryWithStatus(
    statusResult: Awaited<ReturnType<GitProcessRunner>>,
  ): Promise<unknown> {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(statusResult)
      // The summary route reads `status` and `remote -v` concurrently, so a fake scripted with
      // only the two calls above answers a third call with `undefined` — a value no
      // GitProcessRunner can return. The base result keeps the fake inside its own declared
      // contract instead of relying on the route never dereferencing that answer.
      .mockResolvedValue(ok(""));
    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(runner),
    );
    return result.body;
  }

  it("summary maps an auth-shaped status failure to git-error", async () => {
    expect(await summaryWithStatus(fail(authStderr, 128))).toMatchObject({
      available: false,
      reason: "git-error",
    });
  });

  it("history maps an auth-shaped log failure to git-error", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(fail(authStderr, 128));
    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}`),
      deps(runner),
    );
    expect(result.body).toMatchObject({ available: false, reason: "git-error", entries: [] });
  });

  it("remotes maps an auth-shaped read failure to git-error", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(fail(authStderr, 128));
    const result = await handleGitRemotes(
      ctx(`/api/git/remotes?root=${encodeURIComponent(root)}`),
      deps(runner),
    );
    expect(result.body).toMatchObject({ available: false, reason: "git-error", remotes: [] });
  });
});

// When `rev-parse --show-toplevel` resolves a repository root that does NOT contain the selected
// root, resolveRepository surfaces "repository-root-outside-root" and every read short-circuits to an
// unavailable envelope (a single rev-parse mock drives all three handlers).
describe("read routes — repository root outside the selected root", () => {
  function revParseOutside(): GitProcessRunner {
    return vi.fn<GitProcessRunner>().mockResolvedValueOnce(ok("/totally/unrelated/repository\n"));
  }

  it("summary reports repository-root-outside-root", async () => {
    const result = await handleGitSummary(
      ctx(`/api/git/summary?root=${encodeURIComponent(root)}`),
      deps(revParseOutside()),
    );
    expect(result.body).toMatchObject({
      available: false,
      reason: "repository-root-outside-root",
    });
  });

  it("history reports repository-root-outside-root", async () => {
    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}`),
      deps(revParseOutside()),
    );
    expect(result.body).toMatchObject({
      available: false,
      reason: "repository-root-outside-root",
      entries: [],
    });
  });

  it("remotes reports repository-root-outside-root", async () => {
    const result = await handleGitRemotes(
      ctx(`/api/git/remotes?root=${encodeURIComponent(root)}`),
      deps(revParseOutside()),
    );
    expect(result.body).toMatchObject({
      available: false,
      reason: "repository-root-outside-root",
      remotes: [],
    });
  });
});

// Regression coverage for the S8786 backtracking fixes in parseRemotes/parseChangedFileCount: both
// used to combine an unanchored unbounded quantifier with a fixed suffix, so a long non-matching
// run forced an O(n^2) retry-at-every-position scan. These assert the bounded rewrites stay fast
// on adversarial input while still producing the same results as before on realistic input (the
// "GET /api/git/remotes" and "GET /api/git/history" suites above are unmodified and cover that).
describe("parseRemotes / parseShortstatHistory — bounded regex safety (S8786)", () => {
  it("keeps the widest-valid-split behavior for a remote URL containing internal whitespace", () => {
    const stdout = "origin\thttps://example.invalid/a b.git (fetch)";
    expect(parseRemotes(stdout)).toEqual([
      { name: "origin", fetchUrl: "https://example.invalid/a b.git", pushUrl: undefined },
    ]);
  });

  it("ignores a remote line whose name contains whitespace, matching the original anchored regex", () => {
    const stdout = "not a valid name\thttps://example.invalid/x.git (fetch)";
    expect(parseRemotes(stdout)).toEqual([]);
  });

  it("parses a pathologically long non-matching remotes line without catastrophic backtracking", () => {
    // Shape that made the previous `(\S+)\t(.+?)\s+\(...\)$` regex quadratic: no tab at all, so
    // `(\S+)` alone never finds a name/URL split, and there is no `(fetch|push)` suffix either.
    const adversarial = `name${"x ".repeat(20000)}`;
    const start = Date.now();
    expect(parseRemotes(adversarial)).toEqual([]);
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("extracts the changed-file count from a pathologically long non-matching shortstat line without catastrophic backtracking", () => {
    const head = syntheticHead("subject");
    // Shape that made the previous `(\d+)\s+files?\s+changed` regex quadratic: a long digit run
    // followed by a long whitespace run, with no "files changed" text anywhere.
    const remainder = `${"1".repeat(20000)}${" ".repeat(20000)}x`;
    const record = `${head}\n${remainder}`;

    const start = Date.now();
    const entries = parseShortstatHistory(record);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.changedFileCount).toBe(0);
  });
});

describe("git summary response cache partitioning", () => {
  // The cache is keyed on the UNDERLYING runner's identity (`runnerIdentity`), never on the
  // normalized `runner` — which is a fresh per-request activity-log wrapper. Keying on the wrapper
  // would mint a unique key for every request and turn this 2s cache into a permanent miss with
  // nothing failing: the responses stay correct, the cache just silently stops existing. That half
  // is already pinned by "deduplicates repeated summary reads for the same deps and root within
  // the TTL" above. What was NOT pinned is the other half — that the runner leg of the key does
  // any work at all — which is what a wrapper-keyed cache would also destroy, in the opposite
  // direction, by making every entry unshareable.

  function summaryRunner(): ReturnType<typeof vi.fn<GitProcessRunner>> {
    return vi.fn<GitProcessRunner>((args: readonly string[]) => {
      if (args.includes("rev-parse")) return Promise.resolve(ok(`${root}\n`));
      if (args.includes("status")) return Promise.resolve(ok(porcelain(["# branch.head main"])));
      return Promise.resolve(ok(""));
    });
  }

  it("does not replay an unavailable summary to a later request", async () => {
    // The cache stores failure bodies too. Replaying one would hand a later request a projection
    // whose cause sits on an earlier request's timeline under an earlier correlation id — nothing
    // in that request's own log would explain it. The entry is dropped as soon as it resolves
    // unavailable, so the next request recomputes and records its own failure.
    const activity = captureActivityLog();
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValue(fail("fatal: not a git repository (or any of the parent directories)"));
    const dependencies = deps(runner);
    const path = `/api/git/summary?root=${encodeURIComponent(root)}`;
    const options = { runner, activityLog: activity.sink, maxStatusBytes: 4096, timeoutMs: 5_000 };

    const first = await handleGitSummary(
      { ...ctx(path), correlationId: "corr-cache-first-01" },
      dependencies,
      options,
    );
    const callsAfterFirst = runner.mock.calls.length;
    const second = await handleGitSummary(
      { ...ctx(path), correlationId: "corr-cache-second-1" },
      dependencies,
      options,
    );

    expect(first.body).toMatchObject({ available: false });
    expect(second.body).toMatchObject({ available: false });
    // Recomputed, not replayed — and the second request has its own failure line under its own id.
    expect(runner.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(activity.events.map((event) => event.correlationId)).toContain("corr-cache-second-1");
  });

  it("shares one in-flight computation across genuinely concurrent requests, by design", async () => {
    // The complement of the eviction test above: two requests that are ALREADY concurrent when the
    // first misses the cache share the same promise — that is the cache's job. Both get an accurate
    // response; only one runner call happens, so only one activity-log line exists, under whichever
    // request started the computation. This pins that behaviour explicitly rather than leaving it
    // as an unstated side effect of the eviction fix.
    const activity = captureActivityLog();
    // `computeGitSummary` runs `status` and `remote -v` CONCURRENTLY via `Promise.all`, so a
    // single-slot resolver would have its first capture silently overwritten by the second call —
    // whichever call lost its resolver would leave `Promise.all` hanging forever. Every pending
    // call gets its own resolver here instead.
    const pendingResolvers: ((value: Awaited<ReturnType<GitProcessRunner>>) => void)[] = [];
    const runner = vi.fn<GitProcessRunner>((args: readonly string[]) => {
      if (args.includes("rev-parse")) return Promise.resolve(ok(`${root}\n`));
      return new Promise((resolve) => {
        pendingResolvers.push(resolve);
      });
    });
    const dependencies = deps(runner);
    const path = `/api/git/summary?root=${encodeURIComponent(root)}`;
    const options = { runner, activityLog: activity.sink, maxStatusBytes: 4096, timeoutMs: 5_000 };

    const first = handleGitSummary(
      { ...ctx(path), correlationId: "corr-concurrent-first" },
      dependencies,
      options,
    );
    // `computeGitSummary` does real async work (realpath, membership resolution) before it ever
    // calls the runner, backed by libuv I/O callbacks — a microtask-only loop would starve those
    // callbacks and hang forever. `setImmediate` yields to the macrotask queue on every iteration.
    // Waits for BOTH concurrent calls (`status` and `remote -v`), not just the first.
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (pendingResolvers.length >= 2) {
          resolve();
          return;
        }
        setImmediate(poll);
      };
      poll();
    });
    const second = handleGitSummary(
      { ...ctx(path), correlationId: "corr-concurrent-second" },
      dependencies,
      options,
    );
    const failure = fail("fatal: not a git repository (or any of the parent directories)");
    for (const resolve of pendingResolvers) resolve(failure);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.body).toStrictEqual(secondResult.body);
    // `computeGitSummary` runs `status` AND `remote -v` concurrently, so ONE shared computation
    // correctly produces TWO failure lines (one per failed subcommand) — that is not a bug, it is
    // two real subprocess failures. What the shared-computation guarantee actually rules out is a
    // SECOND independent computation: proven by the runner call count (4, not 8 — membership +
    // status + remote-v + last-sync's rev-parse, run exactly ONCE) and by every line carrying the
    // FIRST request's correlation id, never the second's.
    expect(runner.mock.calls).toHaveLength(4);
    expect(activity.events).toHaveLength(2);
    expect(activity.events.map((event) => event.correlationId)).toEqual([
      "corr-concurrent-first",
      "corr-concurrent-first",
    ]);
    expect(activity.events.map((event) => event.extra?.subcommand).sort()).toEqual([
      "remote",
      "status",
    ]);
  });

  // #3644: a summary read right after a Git action must compute the post-action state. Replaying
  // the entry cached before the action left Sync on its pre-action choice until the TTL passed.
  it("recomputes the summary once a finished Git action invalidates the cache", async () => {
    const path = `/api/git/summary?root=${encodeURIComponent(root)}`;
    const runner = summaryRunner();
    const dependencies = deps(runner);

    await handleGitSummary(ctx(path), dependencies);
    const firstRun = runner.mock.calls.length;
    await handleGitSummary(ctx(path), dependencies);
    expect(runner.mock.calls).toHaveLength(firstRun);

    invalidateGitSummaryCache(dependencies);
    await handleGitSummary(ctx(path), dependencies);
    expect(runner.mock.calls).toHaveLength(firstRun * 2);
  });

  it("still partitions the cache by runner, so two fake runners never share an entry", async () => {
    const path = `/api/git/summary?root=${encodeURIComponent(root)}`;
    const first = summaryRunner();
    const second = vi.fn<GitProcessRunner>((args: readonly string[]) =>
      Promise.resolve(
        args.includes("rev-parse") ? ok(`${root}\n`) : fail("fatal: detected dubious ownership"),
      ),
    );
    const dependencies = deps(first);

    const available = await handleGitSummary(ctx(path), dependencies);
    // The SAME deps object and the same URL — the runner is varied through the handler's own
    // options argument, not by rebuilding deps, because the cache is a WeakMap keyed on deps: a
    // fresh deps object would land in a different bucket and the runner leg of the key would go
    // untested. Only the runner differs here, so the second read must compute its own answer.
    // Every other leg of the cache key is held EQUAL to the deps fixture's own options
    // (`maxStatusBytes`, `timeoutMs`): with the defaults instead, the two reads would differ on a
    // cap rather than on the runner and the test would pass even with the runner leg deleted.
    const unsafe = await handleGitSummary(ctx(path), dependencies, {
      runner: second,
      maxDiffBytes: 64,
      maxStatusBytes: 4096,
      maxChanges: 10,
    });

    expect(available.body).toMatchObject({ available: true });
    expect(unsafe.body).toMatchObject({ available: false, reason: "unsafe-repository" });
    expect(second.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("repository read activity log (AGENTS.md §8 Rule 1)", () => {
  // Each of these three handlers threads `ctx.correlationId` into `optionsWithDefaults` by hand.
  // The parameter's type is `string | undefined`, so a stray `undefined` at any one of them
  // type-checks and would silently bind that whole route's git failures to
  // `UNKNOWN_CORRELATION_ID` — a line no operator can join back to the request that caused it.
  // Covered per route rather than by sampling one, because the three call sites are independent.

  const READ_HANDLERS = [
    { label: "summary", run: handleGitSummary, path: "/api/git/summary" },
    { label: "remotes", run: handleGitRemotes, path: "/api/git/remotes" },
    { label: "history", run: handleGitHistory, path: "/api/git/history" },
  ] as const;

  it.each(READ_HANDLERS)(
    "reports the $label route's git failure under that request's correlation id",
    async ({ label, run, path }) => {
      const activity = captureActivityLog();
      const correlationId = `corr-reads-${label}-01`;
      const runner = vi
        .fn<GitProcessRunner>()
        .mockResolvedValue(fail("fatal: not a git repository (or any of the parent directories)"));

      const result = await run(
        { ...ctx(`${path}?root=${encodeURIComponent(root)}`), correlationId },
        deps(runner),
        { runner, activityLog: activity.sink },
      );

      // The response keeps its content-free unavailable projection; only the LOG gains the reason.
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ available: false });
      expect(activity.events).not.toHaveLength(0);
      expect(activity.events[0]).toMatchObject({
        op: "git.process.failed",
        correlationId,
        errorKind: "unavailable",
        extra: { subcommand: "rev-parse", failureKind: "not-a-repository" },
      });
      expect(JSON.stringify(result.body)).not.toContain("not a git repository");
    },
  );
});

// `changedFileCount` is read from `git log --name-only -z`, not from `--shortstat`, because counting
// inserted and deleted lines reads and diffs every blob and made the History tab take seconds on a
// large repository. These run the real `git` binary: the oracle for the count is `--shortstat`
// itself, so the proof is that the cheaper read agrees with the expensive one on every commit shape,
// and the cap tests prove a cut page never returns a count that is short.
describe("GET /api/git/history — changed-file count without diffing contents", () => {
  async function git(args: readonly string[], maxBytes = 1_000_000): Promise<string> {
    const result = await defaultGitProcessRunner(args, { cwd: root, maxBytes, timeoutMs: 60_000 });
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  }

  async function initRepository(): Promise<void> {
    await git(["init", "--quiet", "--initial-branch=main"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await git(["config", "user.name", "Keiko Fixture"]);
    await git(["config", "gc.auto", "0"]);
    await git(["config", "gc.autoDetach", "false"]);
    await git(["config", "maintenance.auto", "false"]);
  }

  async function put(relativePath: string, content: string | Buffer): Promise<void> {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  async function commitAll(subject: string): Promise<void> {
    await git(["add", "--all"]);
    await git(["commit", "--quiet", "-m", subject]);
  }

  const body = Array.from({ length: 40 }, (_, index) => `line ${String(index)}`).join("\n");

  // add, modify, delete, rename, binary, a path with non-ASCII characters, a subfolder and a merge.
  async function initShapedHistory(): Promise<void> {
    await initRepository();
    await put("top.txt", "top\n");
    await put("sub/keep.txt", "keep\n");
    await put("sub/old-name.txt", body);
    await commitAll("add three files");
    await put("top.txt", "top changed\n");
    await put("sub/keep.txt", "keep changed\n");
    await commitAll("modify two files");
    await git(["rm", "--quiet", "top.txt"]);
    await commitAll("delete one file");
    await git(["mv", "sub/old-name.txt", "sub/new-name.txt"]);
    await commitAll("rename one file");
    await put("sub/blob.bin", Buffer.from([0, 1, 2, 3, 0, 255, 0]));
    await put("sub/ünïcode.txt", "u\n");
    await commitAll("binary and non-ASCII");
    await git(["checkout", "--quiet", "-b", "side"]);
    await put("side.txt", "side\n");
    await commitAll("side work");
    await git(["checkout", "--quiet", "main"]);
    await put("main-only.txt", "main\n");
    await commitAll("main work");
    await git(["merge", "--quiet", "--no-ff", "-m", "merge side", "side"]);
  }

  async function shortstatCounts(pathspec: readonly string[]): Promise<Map<string, number>> {
    const out = await git([
      "log",
      "--no-color",
      "--pretty=format:\x1e%H",
      "--shortstat",
      ...pathspec,
    ]);
    const counts = new Map<string, number>();
    for (const record of out.split("\x1e").filter((entry) => entry.length > 0)) {
      const [sha = "", ...rest] = record.split("\n");
      const match = /(\d+) files? changed/u.exec(rest.join("\n"));
      counts.set(sha, match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10));
    }
    return counts;
  }

  async function readHistory(selectedRoot: string, query = ""): Promise<GitHistoryResponse> {
    const result = await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(selectedRoot)}${query}`),
      deps(defaultGitProcessRunner, (value) => value),
    );
    expect(result.status).toBe(200);
    return result.body as GitHistoryResponse;
  }

  it("never asks git to count lines: the read lists names and does not use --shortstat", async () => {
    await initShapedHistory();
    const seen: (readonly string[])[] = [];
    const runner: GitProcessRunner = (args, options) => {
      seen.push(args);
      return defaultGitProcessRunner(args, options);
    };

    await handleGitHistory(
      ctx(`/api/git/history?root=${encodeURIComponent(root)}`),
      deps(runner, (value) => value),
    );

    const log = seen.find((args) => args.includes("log"));
    expect(log).toContain("--name-only");
    expect(log).toContain("-z");
    expect(log).not.toContain("--shortstat");
  });

  it("agrees with --shortstat on every commit shape at the repository root", async () => {
    await initShapedHistory();
    const expected = await shortstatCounts([]);

    const history = await readHistory(root);

    expect(history.entries.length).toBe(expected.size);
    expect(history.entries.length).toBeGreaterThanOrEqual(8);
    const actual = new Map(history.entries.map((entry) => [entry.sha, entry.changedFileCount]));
    expect(actual).toEqual(expected);
    const bySubject = new Map(history.entries.map((entry) => [entry.subject, entry]));
    expect(bySubject.get("rename one file")?.changedFileCount).toBe(1);
    expect(bySubject.get("binary and non-ASCII")?.changedFileCount).toBe(2);
    expect(bySubject.get("add three files")?.changedFileCount).toBe(3);
    expect(history.entries.find((entry) => entry.parentCount === 2)).toMatchObject({
      changedFileCount: 0,
    });
  });

  it("reports the exact subject, author and date of a merge, an empty commit and a normal commit", async () => {
    await initShapedHistory();
    await git(["commit", "--quiet", "--allow-empty", "-m", "empty commit"]);

    const history = await readHistory(root);

    const bySubject = new Map(history.entries.map((entry) => [entry.subject, entry]));
    for (const subject of ["empty commit", "merge side", "main work"]) {
      const entry = bySubject.get(subject);
      expect(entry, subject).toBeDefined();
      expect(entry?.author).toBe("Keiko Fixture");
      expect(entry?.date).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]+[+-]\d{2}:\d{2}$/u);
      expect(entry?.subject).not.toContain("\0");
    }
    expect(bySubject.get("empty commit")).toMatchObject({ parentCount: 1, changedFileCount: 0 });
    expect(bySubject.get("merge side")).toMatchObject({ parentCount: 2, changedFileCount: 0 });
    expect(bySubject.get("main work")?.changedFileCount).toBe(1);
  });

  it("cannot be made to forge or split a record by file names holding separators or a header", async () => {
    await initRepository();
    await put("seed.txt", "seed\n");
    await commitAll("seed");
    const forgedHead = [
      "f".repeat(40),
      "fffffff",
      "",
      "Forged Author",
      "2020-01-01T00:00:00+00:00",
      "",
      "forged subject",
    ].join("\x1f");
    const names = [
      "record\x1esep.txt",
      "field\x1fsep.txt",
      forgedHead,
      `\x1e${forgedHead}`,
      "new\nline.txt",
      "e".repeat(40),
    ];
    for (const name of names) await put(name, `${String(name.length)}\n`);
    await commitAll("hostile names");
    await put("after.txt", "after\n");
    await commitAll("after hostile");
    const expected = await shortstatCounts([]);

    const history = await readHistory(root);

    expect(history.entries.map((entry) => entry.subject)).toEqual([
      "after hostile",
      "hostile names",
      "seed",
    ]);
    expect(history.entries.some((entry) => entry.author === "Forged Author")).toBe(false);
    expect(new Map(history.entries.map((entry) => [entry.sha, entry.changedFileCount]))).toEqual(
      expected,
    );
    expect(
      history.entries.find((entry) => entry.subject === "hostile names")?.changedFileCount,
    ).toBe(names.length);
  });

  it("keeps every commit when the repository asks git to print signature verification", async () => {
    await initRepository();
    const tools = await mkdtemp(join(tmpdir(), "keiko-fake-gpg-"));
    try {
      const gpg = writeNodeExecutableFixture(
        tools,
        "fake-gpg",
        [
          "const args = process.argv.slice(2);",
          'if (args.includes("--verify")) {',
          '  process.stdout.write("[GNUPG:] GOODSIG 0123456789ABCDEF fake\\n[GNUPG:] VALIDSIG 0123456789ABCDEF 2026-01-01 1 0 4 0 1 8 00 0123456789ABCDEF\\n");',
          '  process.stderr.write("gpg: Signature made fake\\ngpg: Good signature from fake\\n");',
          "  process.exit(0);",
          "}",
          "process.stdin.resume();",
          'process.stdin.on("end", () => {',
          '  process.stderr.write("[GNUPG:] SIG_CREATED D 1 8 00 0 fake\\n");',
          '  process.stdout.write("-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n");',
          "});",
        ].join("\n"),
      );
      await git(["config", "gpg.program", gpg]);
      await git(["config", "user.signingkey", "FAKEKEY"]);
      await git(["config", "log.showSignature", "true"]);
      await put("one.txt", "1\n");
      await git(["add", "--all"]);
      await git(["commit", "--quiet", "-S", "-m", "signed one"]);
      await put("two.txt", "2\n");
      await git(["add", "--all"]);
      await git(["commit", "--quiet", "-S", "-m", "signed two"]);
      // The fixture really makes plain `git log` print verification lines, or this proves nothing.
      expect(await git(["log", "--max-count=1"])).toContain("gpg:");

      const history = await readHistory(root);

      expect(history.entries.map((entry) => entry.subject)).toEqual(["signed two", "signed one"]);
      expect(history.entries.map((entry) => entry.changedFileCount)).toEqual([1, 1]);
    } finally {
      await rm(tools, { recursive: true, force: true });
    }
  });

  it("keeps the fields of a commit whose author holds the old field separator", async () => {
    await initRepository();
    await put("one.txt", "1\n");
    await git(["add", "--all"]);
    await git([
      "commit",
      "--quiet",
      "--author=Odd\x1fAuthor <odd@example.invalid>",
      "-m",
      "odd\x1fsubject",
    ]);

    const history = await readHistory(root);

    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      author: "Odd\x1fAuthor",
      subject: "odd\x1fsubject",
      changedFileCount: 1,
    });
  });

  it("ends the page at an unreadable record and reports it, never skipping it", () => {
    const good = syntheticHead("good");
    const bad = ["not-an-object-id", "x", "", "a", "d", "", "bad"].join("\0");

    const page = parseHistory(`${good}\nf\0\0${bad}\0${good}\0`);

    expect(page.map((entry) => entry.subject)).toEqual(["good"]);
  });

  it("agrees with --shortstat inside a selected subfolder", async () => {
    await initShapedHistory();
    const expected = await shortstatCounts(["--", "sub"]);

    const history = await readHistory(join(root, "sub"));

    expect(new Map(history.entries.map((entry) => [entry.sha, entry.changedFileCount]))).toEqual(
      expected,
    );
    const bySubject = new Map(history.entries.map((entry) => [entry.subject, entry]));
    expect(bySubject.get("add three files")?.changedFileCount).toBe(2);
    expect(bySubject.get("modify two files")?.changedFileCount).toBe(1);
  });

  async function wideCommit(count: number): Promise<void> {
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        put(`wide/file-number-${String(index).padStart(4, "0")}.txt`, "w\n"),
      ),
    );
    await commitAll("wide commit");
  }

  it("returns the exact count of one commit whose path list outgrows the byte cap", async () => {
    await initRepository();
    await put("first.txt", "first\n");
    await commitAll("small first");
    await wideCommit(3000);

    const history = await readHistory(root);

    // The cap (4096 bytes times the history factor here) cuts inside the newest record: it is not returned short, the
    // shortstat read of just that commit supplies its true count, and the page reports truncated.
    expect(history.available).toBe(true);
    expect(history.entries.map((entry) => entry.subject)).toEqual(["wide commit"]);
    expect(history.entries[0]?.changedFileCount).toBe(3000);
    expect(history.truncated).toBe(true);
  });

  it("drops a record the cap cut instead of returning a short count", async () => {
    await initRepository();
    await wideCommit(3000);
    await put("after-1.txt", "1\n");
    await commitAll("small one");
    await put("after-2.txt", "2\n");
    await commitAll("small two");

    const history = await readHistory(root);

    expect(history.entries.map((entry) => entry.subject)).toEqual(["small two", "small one"]);
    expect(history.entries.map((entry) => entry.changedFileCount)).toEqual([1, 1]);
    expect(history.truncated).toBe(true);
    // Load more continues from the number of entries received, so the cut commit comes next.
    const next = await readHistory(root, `&skip=${String(history.entries.length)}&limit=1`);
    expect(next.entries.map((entry) => entry.changedFileCount)).toEqual([3000]);
  });

  it("drops only the last record of a cut read, and keeps every record of a whole one", () => {
    const head = syntheticHead("subject");
    const whole = `${head}\na\0b\0\0`;
    const cut = `${whole}${head}\nc\0d`;

    expect(parseHistory(whole).map((entry) => entry.changedFileCount)).toEqual([2]);
    expect(parseHistory(cut, { truncated: true }).map((entry) => entry.changedFileCount)).toEqual([
      2,
    ]);
    expect(parseHistory(cut).map((entry) => entry.changedFileCount)).toEqual([2, 2]);
  });

  it("counts a path holding a newline once", () => {
    const head = syntheticHead("subject");

    expect(parseHistory(`${head}\nwe\nird.txt\0plain.txt\0`)[0]?.changedFileCount).toBe(2);
  });
});
