import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseGitEditorBlameResponse,
  parseGitEditorDiffResponse,
} from "@oscharko-dev/keiko-contracts";
import { defaultGitProcessRunner } from "@oscharko-dev/keiko-git";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import type { RouteContext } from "./routes.js";
import type { UiStore } from "./store/index.js";
import { mockRequest, mockResponse } from "./_support.js";
import {
  handleGitBranches,
  handleGitBlame,
  handleGitDiff,
  handleGitStructuredDiff,
  handleGitStatus,
  type GitProcessRunner,
} from "./gitRoutes.js";

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

function ctx(path: string, correlationId?: string): RouteContext {
  return {
    req: mockRequest(),
    res: mockResponse().res,
    params: {},
    url: new URL(`http://localhost${path}`),
    ...(correlationId === undefined ? {} : { correlationId }),
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

async function runRealGit(args: readonly string[]): Promise<void> {
  const result = await defaultGitProcessRunner(args, {
    cwd: root,
    maxBytes: 4096,
    timeoutMs: 5_000,
  });
  expect(result.exitCode, result.stderr).toBe(0);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "keiko-git-route-"));
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/git/status", () => {
  it("returns a clean branch status", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok("## main\0"));

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "available",
      available: true,
      branch: "main",
      detached: false,
      clean: true,
      changes: [],
    });
  });

  it("parses staged, unstaged, untracked, branch, and detached porcelain states", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(
        ok("## HEAD (no branch)\0M  src/staged.ts\0 M src/dirty.ts\0?? src/new.ts\0"),
      );

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "available",
      detached: true,
      clean: false,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 1,
    });
    expect(result.body).toMatchObject({
      changes: [
        { path: "src/staged.ts", staged: true },
        { path: "src/dirty.ts", unstaged: true },
        { path: "src/new.ts", untracked: true },
      ],
    });
  });

  it("parses unborn branches, rename metadata, conflicts, selected-root prefixes, and max-change truncation", async () => {
    const selectedRoot = join(root, "workspace");
    await mkdir(selectedRoot);
    store.createProject(selectedRoot, "nested fixture");
    const runner = vi
      .fn<GitProcessRunner>()
      // rev-parse --show-toplevel --show-prefix: git reports the prefix with a trailing slash.
      .mockResolvedValueOnce(ok(`${root}\nworkspace/\n`))
      .mockResolvedValueOnce(
        ok(
          [
            "## No commits yet on main",
            "R  workspace/src/new-name.ts",
            "workspace/src/old-name.ts",
            "AA workspace/src/conflict.ts",
            "M  other-package/hidden.ts",
          ].join("\0") + "\0",
        ),
      );

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(selectedRoot)}`),
      deps(runner, (value) => value),
      { runner, maxStatusBytes: 4096, maxChanges: 2 },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "available",
      branch: "main",
      clean: false,
      truncated: true,
      maxChanges: 2,
      stagedCount: 2,
      unstagedCount: 1,
      untrackedCount: 0,
      conflictedCount: 1,
      changes: [
        {
          path: "src/new-name.ts",
          oldPath: "src/old-name.ts",
          indexStatus: "R",
          worktreeStatus: " ",
          staged: true,
        },
        {
          path: "src/conflict.ts",
          indexStatus: "A",
          worktreeStatus: "A",
          staged: true,
          unstaged: true,
          conflicted: true,
        },
      ],
    });
    expect(runner.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(["--", ":(literal)workspace"]),
    );
  });

  it("marks process-truncated status output as truncated even when change count is below cap", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce({
        ...ok("## main\0M  src/app.ts\0"),
        truncated: true,
      });

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "available",
      truncated: true,
      changes: [{ path: "src/app.ts" }],
    });
  });

  it("skips the old-path field of worktree-side renames and reports typechanges as modifications", async () => {
    // Y=R (unstaged rename detection, git >= 2.18) also emits a NUL-separated original-path
    // field; failing to skip it used to surface the old path as a phantom change record. T
    // (typechange) is not part of the wire vocabulary and must degrade to M, not to clean.
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(
        ok(
          [
            "## main",
            " R src/renamed-in-worktree.ts",
            "src/original-name.ts",
            " T src/now-a-symlink.ts",
            "T  src/staged-typechange.ts",
          ].join("\0") + "\0",
        ),
      );

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "available",
      changes: [
        { path: "src/renamed-in-worktree.ts", worktreeStatus: "R", unstaged: true },
        { path: "src/now-a-symlink.ts", worktreeStatus: "M", unstaged: true },
        { path: "src/staged-typechange.ts", indexStatus: "M", staged: true },
      ],
    });
    const paths = (result.body as { changes: readonly { path: string }[] }).changes.map(
      (change) => change.path,
    );
    expect(paths).not.toContain("src/original-name.ts");
  });

  it("handles detached-at headers, ignored/unknown status codes, and copy old paths outside the selected root", async () => {
    const selectedRoot = join(root, "workspace");
    await mkdir(selectedRoot);
    store.createProject(selectedRoot, "nested fixture");
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\nworkspace/\n`))
      .mockResolvedValueOnce(
        ok(
          [
            "## HEAD detached at abc123",
            "!! workspace/build/cache.bin",
            "Z  workspace/src/unknown.ts",
            "C  workspace/src/copied.ts",
            "other-package/source.ts",
            "short",
          ].join("\0") + "\0",
        ),
      );

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(selectedRoot)}`),
      deps(runner, (value) => value),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "available",
      detached: true,
      clean: false,
      changes: [
        {
          path: "build/cache.bin",
          indexStatus: "!",
          worktreeStatus: "!",
          staged: false,
          unstaged: false,
        },
        {
          path: "src/unknown.ts",
          indexStatus: " ",
          worktreeStatus: " ",
          staged: false,
          unstaged: false,
        },
        {
          path: "src/copied.ts",
          oldPath: undefined,
          indexStatus: "C",
          staged: true,
        },
      ],
    });
  });

  it("opts into ignored entries without counting ignored-only paths as dirty", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok("## main\0!! build/cache.bin\0"));

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(root)}&includeIgnored=true`),
      deps(runner),
    );

    expect(result.body).toMatchObject({
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      changes: [{ path: "build/cache.bin", indexStatus: "!", worktreeStatus: "!" }],
    });
    expect(runner.mock.calls[1]?.[0]).toEqual(expect.arrayContaining(["--ignored=matching"]));
  });

  it("preserves the default status invocation and rejects invalid ignored options", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok("## main\0"));

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.body).toMatchObject({ clean: true, changes: [] });
    expect(runner.mock.calls[1]?.[0]).not.toContain("--ignored=matching");

    const invalid = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(root)}&includeIgnored=yes`),
      deps(vi.fn<GitProcessRunner>()),
    );
    expect(invalid).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
  });

  it("surfaces non-repositories as a clean unavailable state", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(fail("fatal: not a git repository"));

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "unavailable",
      available: false,
      reason: "not-a-repository",
      clean: true,
      changes: [],
    });
  });

  it("surfaces unsafe ownership without bypassing Git safe.directory protections", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(fail("fatal: detected dubious ownership in repository at '/secret'"));

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "unsafe",
      available: false,
      reason: "unsafe-repository",
    });
    expect(JSON.stringify(result.body)).not.toContain("/secret");
  });

  it("surfaces repository roots outside the selected folder as unavailable", async () => {
    const selectedRoot = join(root, "workspace");
    const outsideRoot = join(root, "outside");
    await mkdir(selectedRoot);
    await mkdir(outsideRoot);
    store.createProject(selectedRoot, "nested fixture");
    const runner = vi.fn<GitProcessRunner>().mockResolvedValueOnce(ok(`${outsideRoot}\n`));

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(selectedRoot)}`),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "unavailable",
      available: false,
      reason: "repository-root-outside-root",
      clean: true,
    });
  });

  it("redacts generic status failures and maps missing Git separately", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(fail("fatal: could not read /secret/repo/config"));
    const redactor = buildRedactor({ GIT_CONFIG_SECRET: "/secret/repo/config" });

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(root)}`),
      deps(runner, redactor),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "unavailable",
      reason: "git-error",
      message: "Git status is unavailable for this folder.",
    });
    expect(JSON.stringify(result.body)).not.toContain("/secret/repo/config");
  });

  it("maps missing Git status failures to a git-missing unavailable state", async () => {
    const runner = vi.fn<GitProcessRunner>().mockResolvedValueOnce(fail("spawn git ENOENT", 127));

    const result = await handleGitStatus(
      ctx(`/api/git/status?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "unavailable",
      reason: "git-missing",
      available: false,
    });
  });
});

describe("GET /api/git/branches", () => {
  it("returns local branches with current marker and head refs", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok("main\0aaa111\0*\0release\0bbb222\0\0"));

    const result = await handleGitBranches(
      ctx(`/api/git/branches?root=${encodeURIComponent(root)}`),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      schemaVersion: "1",
      root,
      available: true,
      state: "available",
      branches: [
        { name: "main", headRefHash: "aaa111", current: true },
        { name: "release", headRefHash: "bbb222", current: false },
      ],
      truncated: false,
    });
    expect(runner.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(["for-each-ref", "refs/heads"]),
    );
  });
});

describe("GET /api/git/diff", () => {
  it("rejects path traversal before invoking Git diff", async () => {
    const runner = vi.fn<GitProcessRunner>();

    const result = await handleGitDiff(
      ctx(`/api/git/diff?root=${encodeURIComponent(root)}&path=..%2Fsecret`),
      deps(runner),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "BAD_PATH" } });
    expect(runner).not.toHaveBeenCalled();
  });

  it("uses fixed no-external-diff Git args and returns bounded diff text", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok("diff --git a/src/app.ts b/src/app.ts\n-secret\n+redacted\n"));

    const result = await handleGitDiff(
      ctx(`/api/git/diff?root=${encodeURIComponent(root)}&path=src%2Fapp.ts&scope=worktree`),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "available",
      available: true,
      path: "src/app.ts",
      scope: "worktree",
      truncated: false,
    });
    const diffArgs = runner.mock.calls[1]?.[0] ?? [];
    expect(diffArgs).toEqual(
      expect.arrayContaining(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--"]),
    );
    expect(diffArgs).not.toContain("--ext-diff");
    expect(diffArgs).not.toContain("--textconv");
  });

  it("literalizes selected diff paths so Git pathspec magic cannot expand", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok("diff --git a/:(top)* b/:(top)*\n+literal\n"));

    const result = await handleGitDiff(
      ctx(
        `/api/git/diff?root=${encodeURIComponent(root)}&path=${encodeURIComponent(
          ":(top)*",
        )}&scope=worktree`,
      ),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ path: ":(top)*", scope: "worktree" });
    const diffArgs = runner.mock.calls[1]?.[0] ?? [];
    expect(diffArgs.slice(-2)).toEqual(["--", ":(literal):(top)*"]);
  });

  it("returns staged diffs with cached Git args and no path when only a nested root is selected", async () => {
    const selectedRoot = join(root, "workspace");
    await mkdir(selectedRoot);
    store.createProject(selectedRoot, "nested fixture");
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${selectedRoot}\n`))
      .mockResolvedValueOnce(ok("diff --git a/file.ts b/file.ts\n+staged\n"));

    const result = await handleGitDiff(
      ctx(`/api/git/diff?root=${encodeURIComponent(selectedRoot)}&scope=staged`),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      state: "available",
      scope: "staged",
      path: undefined,
      diff: "diff --git a/file.ts b/file.ts\n+staged\n",
    });
    expect(runner.mock.calls[1]?.[0]).toEqual(expect.arrayContaining(["--cached"]));
  });

  it("returns unavailable diff envelopes for non-repositories and unsafe diff failures", async () => {
    const nonRepoRunner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(fail("fatal: not a git repository"));

    const nonRepoResult = await handleGitDiff(
      ctx(`/api/git/diff?root=${encodeURIComponent(root)}&scope=worktree`),
      deps(nonRepoRunner),
    );

    expect(nonRepoResult.status).toBe(200);
    expect(nonRepoResult.body).toMatchObject({
      state: "unavailable",
      available: false,
      reason: "not-a-repository",
      diff: "",
    });

    const unsafeRunner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(fail("fatal: detected dubious ownership in repository"));

    const unsafeResult = await handleGitDiff(
      ctx(`/api/git/diff?root=${encodeURIComponent(root)}&scope=worktree`),
      deps(unsafeRunner),
    );

    expect(unsafeResult.status).toBe(200);
    expect(unsafeResult.body).toMatchObject({
      state: "unsafe",
      available: false,
      reason: "unsafe-repository",
      diff: "",
    });

    const missingRunner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(fail("git executable unavailable", 127));

    const missingResult = await handleGitDiff(
      ctx(`/api/git/diff?root=${encodeURIComponent(root)}&scope=staged`),
      deps(missingRunner),
    );

    expect(missingResult.status).toBe(200);
    expect(missingResult.body).toMatchObject({
      state: "unavailable",
      available: false,
      reason: "git-missing",
      diff: "",
    });
  });

  it("rejects invalid diff scopes and converts ordinary diff failures to error envelopes", async () => {
    const invalidScope = await handleGitDiff(
      ctx(`/api/git/diff?root=${encodeURIComponent(root)}&scope=remote`),
      deps(vi.fn<GitProcessRunner>()),
    );

    expect(invalidScope.status).toBe(400);
    expect(invalidScope.body).toMatchObject({ error: { code: "BAD_REQUEST" } });

    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(fail("fatal: ambiguous argument"));

    const result = await handleGitDiff(
      ctx(`/api/git/diff?root=${encodeURIComponent(root)}&scope=worktree`),
      deps(runner),
    );

    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ error: { code: "GIT_DIFF_FAILED" } });
  });

  it("caps combined all-scope diff output", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(ok("staged-output"))
      .mockResolvedValueOnce(ok("worktree-output"));

    const result = await handleGitDiff(
      ctx(`/api/git/diff?root=${encodeURIComponent(root)}&scope=all`),
      deps(runner, (value) => value),
      { maxDiffBytes: 12, runner, maxStatusBytes: 4096, maxChanges: 10 },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ truncated: true, diff: "staged-outpu" });
  });
});

describe("GET /api/git/diff/structured", () => {
  it("returns contract-valid staged hunks and fixed hardened diff arguments", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(
        ok(
          [
            "diff --git a/src/app.ts b/src/app.ts",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1 +1,2 @@",
            "-old",
            "+new",
            "+more",
            "",
          ].join("\n"),
        ),
      );

    const result = await handleGitStructuredDiff(
      ctx(
        `/api/git/diff/structured?root=${encodeURIComponent(root)}&scope=staged&path=src%2Fapp.ts`,
      ),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(parseGitEditorDiffResponse(result.body)).toMatchObject({ ok: true });
    expect(result.body).toMatchObject({
      schemaVersion: "1",
      scope: "staged",
      files: [
        {
          path: "src/app.ts",
          layer: "staged",
          hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 2 }],
        },
      ],
    });
    expect(runner.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--cached",
        "--",
        ":(literal)src/app.ts",
      ]),
    );
  });

  it("reports process truncation and drops the incomplete final hunk", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce({
        ...ok("diff --git a/src/app.ts b/src/app.ts\n@@ -1,2 +1,2 @@\n line\n-old\n+new"),
        truncated: true,
      });

    const result = await handleGitStructuredDiff(
      ctx(`/api/git/diff/structured?root=${encodeURIComponent(root)}&scope=unstaged`),
      deps(runner),
    );

    expect(parseGitEditorDiffResponse(result.body)).toMatchObject({ ok: true });
    expect(result.body).toMatchObject({
      truncated: true,
      files: [{ path: "src/app.ts", hunks: [], truncated: true }],
    });
  });

  it("rejects hostile paths and returns content-free correlated failures", async () => {
    const traversalRunner = vi.fn<GitProcessRunner>();
    const traversal = await handleGitStructuredDiff(
      ctx(`/api/git/diff/structured?root=${encodeURIComponent(root)}&scope=staged&path=..%2Fx`),
      deps(traversalRunner),
    );
    expect(traversal.status).toBe(400);
    expect(traversalRunner).not.toHaveBeenCalled();

    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(fail("fatal: leaked diff /private/repo"));
    const failed = await handleGitStructuredDiff(
      ctx(
        `/api/git/diff/structured?root=${encodeURIComponent(root)}&scope=staged`,
        "cid-diff-2228",
      ),
      deps(runner),
    );
    expect(failed).toMatchObject({
      status: 500,
      body: { error: { code: "GIT_DIFF_FAILED", correlationId: "cid-diff-2228" } },
    });
    expect(JSON.stringify(failed.body)).not.toContain("private/repo");
  });
});

describe("GET /api/git/blame", () => {
  it("returns bounded contract-valid metadata with no email or source text", async () => {
    const hash = "a".repeat(40);
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(
        ok(
          [
            `${hash} 3 3 1`,
            "author Ada Lovelace",
            "author-mail <private@example.test>",
            "author-time 1752172800",
            "author-tz +0000",
            "summary Add route",
            "filename src/app.ts",
            "\tconst privateSource = true;",
            "",
          ].join("\n"),
        ),
      );

    const result = await handleGitBlame(
      ctx(
        `/api/git/blame?root=${encodeURIComponent(root)}&path=src%2Fapp.ts&startLine=3&maxLines=20`,
      ),
      deps(runner),
    );

    expect(result.status).toBe(200);
    expect(parseGitEditorBlameResponse(result.body)).toMatchObject({ ok: true });
    expect(result.body).toMatchObject({
      path: "src/app.ts",
      startLine: 3,
      lines: [{ line: 3, commitHash: hash, author: "Ada Lovelace", summary: "Add route" }],
    });
    expect(JSON.stringify(result.body)).not.toContain("private@example.test");
    expect(JSON.stringify(result.body)).not.toContain("privateSource");
    expect(runner.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        "blame",
        "--line-porcelain",
        "--no-textconv",
        "-L",
        "3,22",
        "--",
        "src/app.ts",
      ]),
    );
  });

  it("executes real blame for a leading-dash filename and redacts an email author name", async () => {
    await runRealGit(["init", "-q"]);
    await runRealGit(["config", "user.email", "private@example.invalid"]);
    await runRealGit(["config", "user.name", "private@example.invalid"]);
    await runRealGit(["config", "commit.gpgsign", "false"]);
    await writeFile(join(root, "-leading.ts"), "export const value = 1;\n", "utf8");
    await runRealGit(["add", "--", "-leading.ts"]);
    await runRealGit(["commit", "-q", "-m", "Add leading filename"]);

    const result = await handleGitBlame(
      ctx(
        `/api/git/blame?root=${encodeURIComponent(root)}&path=-leading.ts&startLine=1&maxLines=1`,
      ),
      deps(defaultGitProcessRunner),
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        path: "-leading.ts",
        lines: [{ line: 1, author: "Private author", summary: "Add leading filename" }],
      },
    });
    expect(JSON.stringify(result.body)).not.toContain("private@example.invalid");
  });

  it("rejects traversal and symlink escapes before blame execution", async () => {
    const traversalRunner = vi.fn<GitProcessRunner>();
    const traversal = await handleGitBlame(
      ctx(`/api/git/blame?root=${encodeURIComponent(root)}&path=..%2Fx&startLine=1&maxLines=1`),
      deps(traversalRunner),
    );
    expect(traversal.status).toBe(400);
    expect(traversalRunner).not.toHaveBeenCalled();

    const outside = await mkdtemp(join(tmpdir(), "keiko-git-route-outside-"));
    await symlink(outside, join(root, "escape"));
    const symlinkRunner = vi.fn<GitProcessRunner>().mockResolvedValueOnce(ok(`${root}\n`));
    const escaped = await handleGitBlame(
      ctx(
        `/api/git/blame?root=${encodeURIComponent(root)}&path=escape%2Fsecret.ts&startLine=1&maxLines=1`,
      ),
      deps(symlinkRunner),
    );
    await rm(outside, { recursive: true, force: true });
    expect(escaped.status).toBe(400);
    expect(symlinkRunner).toHaveBeenCalledTimes(1);
  });

  it("maps ordinary blame failures to content-free correlated 500s", async () => {
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
      .mockResolvedValueOnce(fail("author-mail <secret@example.test> source /private/repo"));
    const result = await handleGitBlame(
      ctx(
        `/api/git/blame?root=${encodeURIComponent(root)}&path=src%2Fapp.ts&startLine=1&maxLines=1`,
        "cid-blame-2228",
      ),
      deps(runner),
    );

    expect(result).toMatchObject({
      status: 500,
      body: { error: { code: "GIT_BLAME_FAILED", correlationId: "cid-blame-2228" } },
    });
    expect(JSON.stringify(result.body)).not.toContain("secret@example.test");
    expect(JSON.stringify(result.body)).not.toContain("private/repo");
  });
});
