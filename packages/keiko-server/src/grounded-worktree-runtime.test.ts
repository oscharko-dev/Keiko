import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitProcessRunner, type GitProcessRunner } from "@oscharko-dev/keiko-git";
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

describe("production working-tree retrieval hints", () => {
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
