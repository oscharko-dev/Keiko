import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import type { RouteContext } from "./routes.js";
import type { UiStore } from "./store/index.js";
import { handleGitHistory, handleGitRemotes, handleGitSummary } from "./gitRepositoryReads.js";
import { gitEnv, networkGitEnv, type GitProcessRunner } from "./gitRoutes.js";

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "keiko-git-reads-"));
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
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
      .mockResolvedValueOnce(fail("fatal: detected dubious ownership"));

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
// network-sync env inherits the real environment so a fetch/pull can authenticate, but never prompts.
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

  it("keeps the network-sync env credential-capable but non-interactive and fail-closed", () => {
    // Stub a sentinel real-env var and HOME so the assertion holds regardless of ambient HOME and a
    // mutation dropping the `...process.env` inheritance is caught deterministically.
    const sentinelKey = "KEIKO_NETWORK_ENV_SENTINEL";
    vi.stubEnv(sentinelKey, "inherited-value");
    vi.stubEnv("HOME", "/home/keiko-test-user");
    try {
      const env = networkGitEnv();
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      // Inherits the real environment (credential.helper + SSH identities are discoverable) — it is
      // NOT the hardened "/nonexistent" sentinel the local reads use.
      expect(env[sentinelKey]).toBe("inherited-value");
      expect(env.HOME).toBe("/home/keiko-test-user");
      expect(env.HOME).not.toBe("/nonexistent");
      // SSH runs in BatchMode and requires known host keys, so it fails closed instead of prompting
      // or silently trusting a first-use host.
      expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
      expect(env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
      expect(env.GIT_SSH_COMMAND).not.toContain("accept-new");
      // The network env does NOT isolate the user's global git config (that would hide credentials).
      expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
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
      .mockResolvedValueOnce(statusResult);
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
