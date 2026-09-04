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
  parseHistory,
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
    timeoutMs: 10_000,
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

describe("GET /api/git/history", () => {
  function logRecord(fields: {
    sha: string;
    short: string;
    parents: string;
    author: string;
    date: string;
    refs: string;
    subject: string;
    shortstat?: string;
  }): string {
    const head = [
      fields.sha,
      fields.short,
      fields.parents,
      fields.author,
      fields.date,
      fields.refs,
      fields.subject,
    ].join("\x1f");
    return `\x1e${head}\n${fields.shortstat ?? ""}`;
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
            shortstat: " 3 files changed, 10 insertions(+), 2 deletions(-)\n",
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

  it("treats a merge commit with no shortstat as parentCount 2 and zero changed files", async () => {
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
      .mockResolvedValueOnce({ ...ok(""), truncated: true });

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

  it("uses the hardened network env at the actual fetch and pull spawn boundary", async () => {
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
      await defaultGitNetworkProcessRunner(["fetch", "--no-tags"], {
        cwd: root,
        maxBytes: 4096,
        timeoutMs: 5_000,
      });
      await defaultGitNetworkProcessRunner(["pull", "--ff-only"], {
        cwd: root,
        maxBytes: 4096,
        timeoutMs: 5_000,
      });
      const records = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: readonly string[]; env: NodeJS.ProcessEnv });
      expect(
        records.map((record) => record.args.find((arg) => arg === "fetch" || arg === "pull")),
      ).toEqual(["fetch", "pull"]);
      for (const record of records) {
        expect(record.args).toContain("protocol.ext.allow=never");
        expect(record.args).toContain("credential.helper=");
        expect(record.env.GIT_TERMINAL_PROMPT).toBe("0");
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
  });
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
describe("parseRemotes / parseHistory — bounded regex safety (S8786)", () => {
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
    const head = ["sha1", "sh1", "", "author", "date", "", "subject"].join("\x1f");
    // Shape that made the previous `(\d+)\s+files?\s+changed` regex quadratic: a long digit run
    // followed by a long whitespace run, with no "files changed" text anywhere.
    const remainder = `${"1".repeat(20000)}${" ".repeat(20000)}x`;
    const record = `\x1e${head}\n${remainder}`;

    const start = Date.now();
    const entries = parseHistory(record);
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
        errorKind: "not-a-repository",
        extra: { subcommand: "rev-parse" },
      });
      expect(JSON.stringify(result.body)).not.toContain("not a git repository");
    },
  );
});
