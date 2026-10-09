import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import type { GitProcessResult, GitProcessRunner } from "@oscharko-dev/keiko-git";
import { defaultGitProcessRunner } from "@oscharko-dev/keiko-git";
import type { SearchScope } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { captureActivityLog } from "./activityLogCapture.test-support.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { observeWorktreeRecency, type WorktreeRecencyInputs } from "./grounded-worktree-recency.js";

const NOW = 1_700_000_000_000;
let root = "";

function file(path: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, "export const value = true;\n");
}

function selected(
  kind: SelectedScope["kind"] = "workspace-root",
  paths: readonly string[] = [],
): SelectedScope {
  return {
    schemaVersion: "1",
    scopeId: "worktree-test",
    workspaceRoot: root,
    kind,
    relativePaths: paths,
    conversationId: undefined,
    connectedAtMs: NOW,
  };
}

function searchScope(scope: SelectedScope, ignoreLines: readonly string[] = []): SearchScope {
  return {
    scopeId: scope.scopeId,
    relativePaths: scope.relativePaths,
    workspace: {
      root,
      selectedRoot: root,
      name: undefined,
      version: undefined,
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines,
    },
  };
}

function result(stdout: string): GitProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", truncated: false };
}

function runnerFor(records: readonly string[]): ReturnType<typeof vi.fn<GitProcessRunner>> {
  return vi.fn((args) =>
    Promise.resolve(result(args.includes("rev-parse") ? `${root}\n\n` : `${records.join("\0")}\0`)),
  );
}

function inputs(gitRunner: GitProcessRunner, scope = selected()): WorktreeRecencyInputs {
  return {
    scope,
    searchScope: searchScope(scope),
    workspaceKind: "git-repository" as const,
    fs: nodeWorkspaceFs,
    nowMs: (): number => NOW,
    deadlineAtMs: NOW + 1_500,
    gitRunner,
  };
}

function modified(path: string): string {
  return `1 .M N... 100644 100644 100644 aaa bbb ${path}`;
}

beforeEach(() => {
  root = nodeWorkspaceFs.realPath(mkdtempSync(join(tmpdir(), "keiko-worktree-recency-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("observeWorktreeRecency", () => {
  it("runs no git or filesystem observation for an ordinary folder", async () => {
    const runner = runnerFor([]);
    const realPath = vi.fn(nodeWorkspaceFs.realPath);
    const observed = await observeWorktreeRecency({
      ...inputs(runner),
      workspaceKind: "directory",
      fs: { ...nodeWorkspaceFs, realPath },
    });
    expect(observed.paths).toEqual([]);
    expect(observed.observation.worktreeStatusDisposition).toBe("not-git");
    expect(runner).not.toHaveBeenCalled();
    expect(realPath).not.toHaveBeenCalled();
  });

  it("does no I/O after the request deadline", async () => {
    const runner = runnerFor([]);
    const realPath = vi.fn(nodeWorkspaceFs.realPath);
    const observed = await observeWorktreeRecency({
      ...inputs(runner),
      deadlineAtMs: NOW,
      fs: { ...nodeWorkspaceFs, realPath },
    });
    expect(observed.observation.worktreeStatusDisposition).toBe("skipped-budget");
    expect(runner).not.toHaveBeenCalled();
    expect(realPath).not.toHaveBeenCalled();
  });

  it("does no I/O when admission has exhausted its observation allowance", async () => {
    const runner = runnerFor([]);
    const realPath = vi.fn(nodeWorkspaceFs.realPath);
    const observed = await observeWorktreeRecency({
      ...inputs(runner),
      observationAllowed: false,
      fs: { ...nodeWorkspaceFs, realPath },
    });
    expect(observed.observation.worktreeStatusDisposition).toBe("skipped-budget");
    expect(runner).not.toHaveBeenCalled();
    expect(realPath).not.toHaveBeenCalled();
  });

  it("stops metadata observation when the root lookup consumes the remaining deadline", async () => {
    let now = NOW;
    const runner = runnerFor([]);
    const realPath = vi.fn((path: string): string => {
      now = NOW + 1_500;
      return nodeWorkspaceFs.realPath(path);
    });
    const observed = await observeWorktreeRecency({
      ...inputs(runner),
      nowMs: (): number => now,
      fs: { ...nodeWorkspaceFs, realPath },
    });
    expect(observed.observation.worktreeStatusDisposition).toBe("skipped-budget");
    expect(realPath).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
  });

  it("uses the hardened production runner in a real repository", async () => {
    const initialized = await defaultGitProcessRunner(["init", "--quiet", root], {
      cwd: root,
      maxBytes: 16_384,
      timeoutMs: 1_500,
    });
    expect(initialized.exitCode).toBe(0);
    file("src/live.ts");
    file("elsewhere.ts");
    const observed = await observeWorktreeRecency({
      ...inputs(defaultGitProcessRunner, selected("directory", ["src"])),
      deadlineAtMs: Infinity,
    });
    expect(observed.paths).toEqual([{ path: "src/live.ts", status: "untracked" }]);
    expect(observed.statusDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("admits changed existing files and counts deleted files without hinting them", async () => {
    for (const path of ["src/modified.ts", "src/added.ts", "src/renamed.ts", "src/new.ts"])
      file(path);
    const runner = runnerFor([
      modified("src/modified.ts"),
      "1 A. N... 000000 100644 100644 aaa bbb src/added.ts",
      "2 R. N... 100644 100644 100644 aaa bbb R100 src/renamed.ts",
      "src/old.ts",
      "? src/new.ts",
      "1 .D N... 100644 100644 000000 aaa bbb src/deleted.ts",
    ]);
    const observed = await observeWorktreeRecency(inputs(runner));
    expect(observed.paths).toEqual([
      { path: "src/modified.ts", status: "modified" },
      { path: "src/added.ts", status: "added" },
      { path: "src/renamed.ts", status: "renamed" },
      { path: "src/new.ts", status: "untracked" },
    ]);
    expect(observed.observation).toMatchObject({
      worktreeStatusState: "available",
      worktreeStatusDisposition: "applied",
      worktreeObservedFileCount: 5,
      worktreeInScopeFileCount: 4,
      worktreeDeletedFileCount: 1,
    });
    expect(
      runner.mock.calls.every(([, options]) => options.cwd === root && options.timeoutMs <= 1_500),
    ).toBe(true);
    const status = runner.mock.calls.find(([args]) => args.includes("status"));
    expect(status?.[0]).toContain("--porcelain=v2");
    expect(status?.[0]).toContain("-z");
    expect(status?.[1].maxBytes).toBeLessThanOrEqual(512 * 1024);
  });

  it.each([
    { kind: "directory" as const, paths: ["src/Feature"] },
    { kind: "files" as const, paths: ["src/Feature/current.ts"] },
  ])("does not widen a $kind selection through prefix siblings", async ({ kind, paths }) => {
    for (const path of ["src/Feature/current.ts", "src/FeatureOther/other.ts", "elsewhere.ts"])
      file(path);
    const observed = await observeWorktreeRecency(
      inputs(
        runnerFor([
          modified("src/Feature/current.ts"),
          modified("src/FeatureOther/other.ts"),
          modified("elsewhere.ts"),
        ]),
        selected(kind, paths),
      ),
    );
    expect(observed.paths).toEqual([{ path: "src/Feature/current.ts", status: "modified" }]);
  });

  it("excludes denied, ignored, generated and escaping aliases without reading content", async () => {
    for (const path of [".env", "ignored.ts", "dist/output.ts", "src/safe.ts"]) file(path);
    symlinkSync(join(root, ".env"), join(root, "alias.ts"));
    const readFileUtf8 = vi.fn(nodeWorkspaceFs.readFileUtf8);
    const base = inputs(
      runnerFor([
        "? .env",
        "? ignored.ts",
        "? dist/output.ts",
        "? alias.ts",
        "? ../escape.ts",
        "? src/safe.ts",
      ]),
    );
    const observed = await observeWorktreeRecency({
      ...base,
      searchScope: searchScope(base.scope, ["ignored.ts"]),
      fs: { ...nodeWorkspaceFs, readFileUtf8 },
    });
    expect(observed.paths).toEqual([{ path: "src/safe.ts", status: "untracked" }]);
    expect(readFileUtf8).not.toHaveBeenCalled();
  });

  it("caps allowed paths at 64", async () => {
    const paths = Array.from({ length: 70 }, (_, index) => `src/changed-${String(index)}.ts`);
    for (const path of paths) file(path);
    const observed = await observeWorktreeRecency(inputs(runnerFor(paths.map(modified))));
    expect(observed.paths).toHaveLength(64);
    expect(new Set(observed.paths.map((entry) => entry.path)).size).toBe(64);
  });

  it("returns unavailable with body-free correlated evidence for a git failure", async () => {
    const captured = captureActivityLog();
    const runner = vi.fn<GitProcessRunner>(() =>
      Promise.resolve({
        ...result(""),
        exitCode: 128,
        stderr: "sensitive repository text /private/owner",
      }),
    );
    const observed = await observeWorktreeRecency({
      ...inputs(runner),
      activityLog: captured.sink,
      correlationId: "worktree-test-ask",
    });
    expect(observed.paths).toEqual([]);
    expect(observed.observation.worktreeStatusDisposition).toBe("unavailable");
    expect(captured.withOp("git.process.failed")).toHaveLength(1);
    expect(captured.events[0]?.correlationId).toBe("worktree-test-ask");
    expect(captured.events[0]?.errorKind).toBeDefined();
    expect(JSON.stringify(captured.events)).not.toContain("sensitive repository");
    expect(JSON.stringify(captured.events)).not.toContain("/private/owner");
  });

  it("rejects truncated status instead of claiming an available partial observation", async () => {
    const runner = vi.fn<GitProcessRunner>((args) =>
      Promise.resolve(
        args.includes("rev-parse")
          ? result(`${root}\n\n`)
          : { ...result("? src/partial.ts\0"), truncated: true },
      ),
    );
    const observed = await observeWorktreeRecency(inputs(runner));
    expect(observed.paths).toEqual([]);
    expect(observed.observation.worktreeStatusDisposition).toBe("unavailable");
  });

  it("rejects a truncated membership response before spawning status", async () => {
    const runner = vi.fn<GitProcessRunner>(() =>
      Promise.resolve({
        ...result(`${root}\n\n`),
        truncated: true,
      }),
    );
    const observed = await observeWorktreeRecency(inputs(runner));
    expect(observed.observation.worktreeStatusDisposition).toBe("unavailable");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("soft-fails a thrown runner defect with canonical body-free diagnostic evidence", async () => {
    const diagnostics: ServerDiagnosticRecord[] = [];
    const runner: GitProcessRunner = (): Promise<GitProcessResult> => {
      throw new TypeError("untrusted /private/owner message");
    };
    const observed = await observeWorktreeRecency({
      ...inputs(runner),
      correlationId: "worktree-thrown-ask",
      diagnostics: {
        record: (record): void => {
          diagnostics.push(record);
        },
      },
    });
    expect(observed.observation.worktreeStatusDisposition).toBe("unavailable");
    expect(diagnostics[0]).toMatchObject({
      correlationId: "worktree-thrown-ask",
      errorClass: "TypeError",
      diagnosticOutcome: "source-skipped",
    });
    expect(diagnostics[0]?.frames?.length).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostics)).not.toContain("/private/owner");
  });
});
