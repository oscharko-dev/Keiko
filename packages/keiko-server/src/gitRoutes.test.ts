import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { handleGitDiff, handleGitStatus, type GitProcessRunner } from "./gitRoutes.js";

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
      .mockResolvedValueOnce(ok(`${root}\n`))
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
    expect(runner.mock.calls[1]?.[0]).toEqual(expect.arrayContaining(["--", "workspace"]));
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

  it("handles detached-at headers, ignored/unknown status codes, and copy old paths outside the selected root", async () => {
    const selectedRoot = join(root, "workspace");
    await mkdir(selectedRoot);
    store.createProject(selectedRoot, "nested fixture");
    const runner = vi
      .fn<GitProcessRunner>()
      .mockResolvedValueOnce(ok(`${root}\n`))
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
          staged: true,
          unstaged: true,
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
