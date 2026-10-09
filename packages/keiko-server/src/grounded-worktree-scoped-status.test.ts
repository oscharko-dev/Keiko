import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultGitProcessRunner,
  GIT_BASE_ARGS,
  type GitProcessResult,
} from "@oscharko-dev/keiko-git";
import {
  DEFAULT_EXPLORATION_BUDGET,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { captureActivityLog } from "./activityLogCapture.test-support.js";
import { observeWorktreeRecency, type WorktreeRecencyInputs } from "./grounded-worktree-recency.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";

const TARGET = "src/z/validation.ts";
const DECOY = "src/a/validation.ts";
const SOURCE = "export function validation() { return true; }\n";
const LIVE = `// WORKTREE_LIVE_FACT_42\n${SOURCE}`;
let root = "";

beforeEach(() => {
  root = nodeWorkspaceFs.realPath(mkdtempSync(join(tmpdir(), "keiko-scoped-status-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

async function git(args: readonly string[]): Promise<GitProcessResult> {
  const result = await defaultGitProcessRunner([...GIT_BASE_ARGS, "-C", root, ...args], {
    cwd: root,
    maxBytes: 512 * 1024,
    timeoutMs: 3_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.truncated).toBe(false);
  return result;
}

async function repository(outsideCount: number): Promise<void> {
  write(TARGET, SOURCE);
  write(DECOY, SOURCE);
  const outside = Array.from(
    { length: outsideCount },
    (_, index) => `outside/changed-${String(index).padStart(4, "0")}.ts`,
  );
  for (const path of outside) write(path, SOURCE);
  await git(["init", "--quiet", "--template="]);
  await git(["add", "--", "."]);
  await git([
    "-c",
    "user.name=Keiko Fixture",
    "-c",
    "user.email=fixture@keiko.invalid",
    "commit",
    "--quiet",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    "fixture",
  ]);
  for (const path of outside) write(path, `// unrelated edit\n${SOURCE}`);
  write(TARGET, LIVE);
}

function inputs(): WorktreeRecencyInputs {
  const scope: SelectedScope = {
    schemaVersion: "1",
    scopeId: "scoped-status",
    workspaceRoot: root,
    kind: "directory",
    relativePaths: ["src"],
    conversationId: undefined,
    connectedAtMs: 0,
  };
  return {
    scope,
    searchScope: {
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
        ignoreLines: [],
      },
    },
    workspaceKind: "git-repository",
    fs: nodeWorkspaceFs,
    nowMs: Date.now,
    deadlineAtMs: Date.now() + 5_000,
  };
}

describe("selected-scope Git status before the raw record cap", () => {
  it.each([0, 511, 512])(
    "retains the sole in-scope edit after %i unrelated changed files",
    async (count) => {
      await repository(count);
      const raw = await git([
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--",
        ":(literal).",
      ]);
      expect(Buffer.byteLength(raw.stdout)).toBeLessThan(512 * 1024);
      expect(raw.stdout.includes(TARGET)).toBe(true);
      const observed = await observeWorktreeRecency(inputs());
      expect(observed.paths).toEqual([{ path: TARGET, status: "modified" }]);
      expect(observed.observation.worktreeInScopeFileCount).toBe(1);
      expect(observed.observation.worktreeStatusDisposition).toBe("applied");
      expect(observed.observation.worktreeObservedFileCount).toBeGreaterThanOrEqual(1);
      expect(observed.observation.worktreeObservedFileCount).toBeLessThanOrEqual(512);
    },
    20_000,
  );

  it("sends the actually edited file through public retrieval with one read grant", async () => {
    await repository(512);
    const request = inputs();
    const log = captureActivityLog();
    const retrieved = await retrieveConnectedContextPack(
      {
        workspaceRoot: root,
        scope: request.scope,
        query: {
          kind: "natural-language",
          text: "Explain validation.ts",
          caseSensitive: false,
          maxResults: 20,
          emittedAtMs: 0,
        },
        budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 1 },
      },
      {
        correlationId: "scoped-worktree-public",
        activityLog: log.sink,
        answerer: { answer: () => Promise.resolve("") },
      },
    );
    expect(retrieved.pack.files.map((file) => file.scopePath)).toEqual([TARGET]);
    expect(retrieved.pack.files[0]?.excerpts[0]?.content).toContain("WORKTREE_LIVE_FACT_42");
    expect(retrieved.pack.usage.filesRead).toBe(1);
    expect(
      log.events.find((event) => event.op === "search.connected-context.selection-details")?.extra,
    ).toMatchObject({
      recentPathHintCount: 1,
      recentPathHitCount: 1,
      worktreeStatusDisposition: "applied",
    });
    expect(JSON.stringify(log.events)).not.toContain("WORKTREE_LIVE_FACT_42");
  }, 20_000);
});
