import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitProcessRunner, type GitProcessRunner } from "@oscharko-dev/keiko-git";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { captureActivityLog } from "./activityLogCapture.test-support.js";

let root = "";

beforeEach(() => {
  root = nodeWorkspaceFs.realPath(mkdtempSync(join(tmpdir(), "keiko-worktree-runtime-")));
  for (const dir of ["a", "z"]) {
    mkdirSync(join(root, dir));
    writeFileSync(
      join(root, dir, "validation.ts"),
      "export function validation() { return true; }\n",
    );
  }
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function git(args: readonly string[]): Promise<void> {
  const result = await defaultGitProcessRunner(args, {
    cwd: root,
    maxBytes: 65_536,
    timeoutMs: 3_000,
  });
  expect(result.exitCode).toBe(0);
}

async function repository(): Promise<void> {
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
}

function input(filesReadMax = 1): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "recency-runtime",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
    },
    query: {
      kind: "natural-language",
      text: "Explain validation.ts",
      caseSensitive: false,
      maxResults: 20,
      emittedAtMs: 0,
    },
    budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax },
  };
}

function nestedRoot(depth: number): string {
  const selectedRoot = join(root, ...Array.from({ length: depth }, () => "nested"));
  for (const dir of ["a", "z"]) {
    mkdirSync(join(selectedRoot, dir), { recursive: true });
    writeFileSync(join(selectedRoot, dir, "validation.ts"), "export const validation = 1;\n");
  }
  return selectedRoot;
}

function connectedRoot(selectedRoot: string): OrchestratorInput {
  const original = input();
  return {
    ...original,
    workspaceRoot: selectedRoot,
    scope: { ...original.scope, workspaceRoot: selectedRoot },
  };
}

describe("production working-tree retrieval hints", () => {
  it.each([32, 72])(
    "observes edits from a directly connected Git folder %i levels below the repository",
    async (depth) => {
      const selectedRoot = nestedRoot(depth);
      await repository();
      writeFileSync(join(selectedRoot, "z/validation.ts"), "export const validation = 42;\n");
      const runner = vi.fn<GitProcessRunner>(defaultGitProcessRunner);
      const log = captureActivityLog();
      const retrieved = await retrieveConnectedContextPack(connectedRoot(selectedRoot), {
        answerer: { answer: () => Promise.resolve("") },
        correlationId: "worktree-deep-folder",
        worktreeGitRunner: runner,
        activityLog: log.sink,
      });
      expect(retrieved.pack.scope.workspaceRoot).toBe(selectedRoot);
      expect(
        log.events.find((event) => event.op === "search.connected-context.selection-details")
          ?.extra,
      ).toMatchObject({
        worktreeStatusDisposition: "applied",
        recentPathHintCount: 1,
        recentPathHitCount: 1,
      });
      expect(retrieved.pack.files.map((file) => file.scopePath)).toEqual(["z/validation.ts"]);
      expect(runner).toHaveBeenCalled();
      expect(runner.mock.calls.every(([, options]) => options.cwd === selectedRoot)).toBe(true);
      expect(retrieved.pack.usage.filesRead).toBe(1);
    },
  );

  it("spawns no Git process for an ordinary folder 72 levels below its root", async () => {
    const selectedRoot = nestedRoot(72);
    const runner = vi.fn<GitProcessRunner>(defaultGitProcessRunner);
    const log = captureActivityLog();
    const retrieved = await retrieveConnectedContextPack(connectedRoot(selectedRoot), {
      answerer: { answer: () => Promise.resolve("") },
      correlationId: "worktree-deep-ordinary",
      worktreeGitRunner: runner,
      activityLog: log.sink,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(retrieved.pack.scope.workspaceRoot).toBe(selectedRoot);
    expect(retrieved.pack.files).toHaveLength(1);
    expect(
      log.events.find((event) => event.op === "search.connected-context.selection-details")?.extra,
    ).toMatchObject({ worktreeStatusDisposition: "not-git", recentPathHintCount: 0 });
  });

  it("retains cancellation between ancestor metadata checks", async () => {
    const selectedRoot = nestedRoot(72);
    const controller = new AbortController();
    const runner = vi.fn<GitProcessRunner>(defaultGitProcessRunner);
    const crossingPath = join(selectedRoot, "..", "..", ".git");
    const exists = vi.fn((path: string): boolean => {
      const result = nodeWorkspaceFs.exists(path);
      if (path === crossingPath) controller.abort();
      return result;
    });
    await expect(
      retrieveConnectedContextPack(connectedRoot(selectedRoot), {
        answerer: { answer: () => Promise.resolve("") },
        correlationId: "worktree-ancestor-cancel",
        fs: { ...nodeWorkspaceFs, exists },
        signal: controller.signal,
        worktreeGitRunner: runner,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(controller.signal.aborted).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    expect(exists.mock.calls.at(-1)).toEqual([crossingPath]);
  });

  it("retains the original deadline between ancestor metadata checks", async () => {
    const selectedRoot = nestedRoot(72);
    const runner = vi.fn<GitProcessRunner>(defaultGitProcessRunner);
    const crossingPath = join(selectedRoot, "..", "..", ".git");
    let nowMs = 0;
    const exists = vi.fn((path: string): boolean => {
      const result = nodeWorkspaceFs.exists(path);
      if (path === crossingPath) nowMs = 1;
      return result;
    });
    const original = connectedRoot(selectedRoot);
    const retrieved = await retrieveConnectedContextPack(
      { ...original, budget: { ...original.budget, elapsedMsMax: 1 } },
      {
        answerer: { answer: () => Promise.resolve("") },
        correlationId: "worktree-ancestor-deadline",
        fs: { ...nodeWorkspaceFs, exists },
        nowMs: () => nowMs,
        worktreeGitRunner: runner,
      },
    );
    expect(nowMs).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(exists.mock.calls.at(-1)).toEqual([crossingPath]);
    expect(retrieved.pack.files).toEqual([]);
    expect(retrieved.pack.usage.elapsedMs).toBe(1);
  });
  it("prefers an actually edited same-basename source over an equivalent unedited decoy", async () => {
    await repository();
    writeFileSync(
      join(root, "z/validation.ts"),
      "// working change\nexport function validation() { return true; }\n",
    );
    const log = captureActivityLog();
    const retrieved = await retrieveConnectedContextPack(input(), {
      answerer: { answer: () => Promise.resolve("") },
      correlationId: "worktree-runtime",
      activityLog: log.sink,
    });
    expect(retrieved.pack.files.map((file) => file.scopePath)).toEqual(["z/validation.ts"]);
    expect(
      log.events.find((event) => event.op === "search.connected-context.selection-details")?.extra,
    ).toMatchObject({
      worktreeStatusDisposition: "applied",
      recentPathHintCount: 1,
      recentPathHitCount: 1,
    });
    expect(retrieved.pack.usage.filesRead).toBe(1);
  });

  it("spawns no worktree process for a non-Git folder", async () => {
    const runner = vi.fn<GitProcessRunner>(defaultGitProcessRunner);
    const log = captureActivityLog();
    await retrieveConnectedContextPack(input(), {
      answerer: { answer: () => Promise.resolve("") },
      correlationId: "worktree-folder",
      worktreeGitRunner: runner,
      activityLog: log.sink,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(
      log.events.find((event) => event.op === "search.connected-context.selection-details")?.extra,
    ).toMatchObject({ worktreeStatusDisposition: "not-git", recentPathHintCount: 0 });
  });

  it("observes Git changes in a directly connected repository subfolder without widening its root", async () => {
    await repository();
    const selectedRoot = join(root, "z");
    writeFileSync(join(selectedRoot, "validation.ts"), "export const validation = 42;\n");
    const original = input();
    const selected = {
      ...original,
      workspaceRoot: selectedRoot,
      scope: { ...original.scope, workspaceRoot: selectedRoot },
    };
    const runner = vi.fn<GitProcessRunner>(defaultGitProcessRunner);
    const log = captureActivityLog();
    const retrieved = await retrieveConnectedContextPack(selected, {
      answerer: { answer: () => Promise.resolve("") },
      correlationId: "worktree-subfolder",
      worktreeGitRunner: runner,
      activityLog: log.sink,
    });
    expect(retrieved.pack.scope.workspaceRoot).toBe(selectedRoot);
    expect(retrieved.pack.files.map((file) => file.scopePath)).toEqual(["validation.ts"]);
    expect(
      log.events.find((event) => event.op === "search.connected-context.selection-details")?.extra,
    ).toMatchObject({ worktreeStatusDisposition: "applied", recentPathHintCount: 1 });
    expect(runner).toHaveBeenCalled();
    expect(runner.mock.calls.every(([, options]) => options.cwd === selectedRoot)).toBe(true);
  });

  it("keeps retrieval available after a structured worktree dependency failure", async () => {
    await repository();
    const runner = vi.fn<GitProcessRunner>(() =>
      Promise.reject(new TypeError("private status failure")),
    );
    const diagnostics: ServerDiagnosticRecord[] = [];
    const log = captureActivityLog();
    const retrieved = await retrieveConnectedContextPack(input(), {
      answerer: { answer: () => Promise.resolve("") },
      correlationId: "worktree-fault",
      worktreeGitRunner: runner,
      activityLog: log.sink,
      diagnostics: {
        record: (record): void => {
          diagnostics.push(record);
        },
      },
    });
    expect(retrieved.pack.files.length).toBe(1);
    expect(
      log.events.find((event) => event.op === "search.connected-context.selection-details")?.extra,
    ).toMatchObject({ worktreeStatusDisposition: "unavailable", recentPathHintCount: 0 });
    expect(runner).toHaveBeenCalled();
    expect(diagnostics[0]).toMatchObject({ operation: "worktree-status", errorClass: "TypeError" });
    expect(diagnostics[0]?.frames?.length).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostics)).not.toContain("private status failure");
    expect(JSON.stringify(log.events)).not.toContain("private status failure");
  });

  it("does not observe the worktree with a zero read grant", async () => {
    await repository();
    const runner = vi.fn<GitProcessRunner>(defaultGitProcessRunner);
    const retrieved = await retrieveConnectedContextPack(input(0), {
      answerer: { answer: () => Promise.resolve("") },
      correlationId: "worktree-zero",
      worktreeGitRunner: runner,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(retrieved.pack.files).toEqual([]);
  });
});
