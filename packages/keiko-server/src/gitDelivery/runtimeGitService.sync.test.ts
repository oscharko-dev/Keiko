import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createCodingRuntimeSnapshotStore } from "../coding-runtime/codingRuntimeSnapshotStore.js";
import { defaultGitProcessRunner, type GitProcessRunner } from "../gitRoutes.js";
import type { GovernedSyncHead } from "../coding-runtime/governedSyncHeads.js";
import { runMigrations } from "../store/schema.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import { RuntimeGitService } from "./runtimeGitService.js";
import { GIT_SYNC_EVIDENCE_RUNID_PREFIX } from "./syncEvidence.js";
import { foreignOriginDigest } from "./verifiedRepositoryIdentity.js";
import type { VerifiedCommitRunContext } from "./verifiedCommitTypes.js";

// #3902 AC2 (PR #4064 review 4373825976): the coding runtime fetches and fast-forwards through the
// Git sync owner, against a real fixture-owned bare remote. A second clone moves the remote ahead.

const DIGEST = "a".repeat(64);
let base: string;
let remote: string;
let root: string;
let other: string;
let live: boolean;
let db: DatabaseSync;
let events: ServerLogEvent[];
let evidence: Map<string, string>;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: base,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Keiko Test",
      GIT_AUTHOR_EMAIL: "keiko@example.test",
      GIT_COMMITTER_NAME: "Keiko Test",
      GIT_COMMITTER_EMAIL: "keiko@example.test",
    },
  }).trim();
}

function context(): VerifiedCommitRunContext {
  return {
    runId: "run-sync",
    envelopeDigest: "b".repeat(64),
    runtimeAuthorityDigest: DIGEST,
    workspaceDigest: DIGEST,
    // The fixture's origin is a local bare repository, which carries a foreign-origin identity.
    repositoryDigest: foreignOriginDigest(remote),
    workspace: {
      root,
      selectedRoot: root,
      name: "test",
      version: undefined,
      testFramework: "vitest",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
    baseRef: "dev",
    headRef: "codex/task",
    correlationId: "runtime-git-sync-test",
    buffersClean: () => true,
    stillAuthorized: () => live,
  };
}

let syncedHeads: GovernedSyncHead[];

function service(runner?: GitProcessRunner): RuntimeGitService {
  return new RuntimeGitService({
    ...(runner === undefined ? {} : { sync: { runner } }),
    recordGovernedSyncHead: (head): void => {
      syncedHeads.push(head);
    },
    context,
    snapshots: createCodingRuntimeSnapshotStore(db),
    mutationDeps: {
      redactor: (value): unknown => value,
      evidenceStore: {
        put: (id, body): string => {
          evidence.set(id, body);
          return id;
        },
        get: (id): string | undefined => evidence.get(id),
        list: (): readonly string[] => [...evidence.keys()],
        delete: (id): void => {
          evidence.delete(id);
        },
      },
    },
    messageAllowed: (): Promise<boolean> => Promise.resolve(true),
    execution: {
      processEnv: { PATH: process.env.PATH, HOME: base },
      approvalStore: createInMemoryGitDeliveryApprovalStore(),
      activityLog: {
        write: (event): void => {
          events.push(event);
        },
      },
    },
    mode: (): "supervised-coding" => "supervised-coding",
    invalidateVerification: (): void => undefined,
  });
}

function sync(
  gitService: RuntimeGitService,
  operation: "fetch" | "pull",
): ReturnType<RuntimeGitService["execute"]> {
  return gitService.execute(
    { action: "git", actionId: operation, idempotencyKey: operation, operation },
    { check: (): boolean => true },
  );
}

function syncLines(): readonly ServerLogEvent[] {
  return events.filter(
    (event) =>
      event.op === "git.runtime-action" &&
      (event.extra?.phase === "fetch" || event.extra?.phase === "pull"),
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-git-sync-")));
  remote = join(base, "remote.git");
  root = join(base, "work");
  other = join(base, "other");
  mkdirSync(root);
  git(base, ["init", "-q", "--bare", "-b", "dev", remote]);
  git(root, ["init", "-qb", "dev"]);
  writeFileSync(join(root, "code.js"), "export const value = 1;\n");
  git(root, ["add", "code.js"]);
  git(root, ["commit", "-qm", "base"]);
  git(root, ["checkout", "-qb", "codex/task"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-q", "-u", "origin", "codex/task"]);
  git(base, ["clone", "-q", "-b", "codex/task", remote, other]);
  writeFileSync(join(other, "code.js"), "export const value = 2;\n");
  git(other, ["commit", "-qam", "remote change"]);
  git(other, ["push", "-q", "origin", "codex/task"]);
  live = true;
  syncedHeads = [];
  events = [];
  evidence = new Map();
  db = new DatabaseSync(":memory:");
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe("governed fetch and pull through the Git sync owner (#3902 AC2)", () => {
  it("fetches, fast-forwards and then finds the branch up to date, each with its evidence", async () => {
    const gitService = service();
    await expect(sync(gitService, "fetch")).resolves.toEqual({
      kind: "fetch",
      status: "succeeded",
      branch: "codex/task",
      ahead: 0,
      behind: 1,
      truncated: false,
    });
    // A fetch moves only the remote-tracking ref, and records no head of its own.
    expect(git(root, ["show", "HEAD:code.js"])).toBe("export const value = 1;");
    expect(syncedHeads).toEqual([]);
    await expect(sync(gitService, "pull")).resolves.toMatchObject({
      kind: "pull",
      status: "succeeded",
      ahead: 0,
      behind: 0,
    });
    expect(git(root, ["rev-parse", "HEAD"])).toBe(git(other, ["rev-parse", "HEAD"]));
    // The fast-forward wrote the run's new head; the run's authority may now stand on it.
    expect(syncedHeads).toEqual([
      { runId: "run-sync", headSha: git(other, ["rev-parse", "HEAD"]), workspaceDigest: DIGEST },
    ]);
    await expect(sync(gitService, "pull")).resolves.toMatchObject({ status: "up-to-date" });
    expect(syncedHeads).toHaveLength(1);

    expect(syncLines().map((event) => [event.extra?.phase, event.extra?.syncOutcome])).toEqual([
      ["fetch", "succeeded"],
      ["pull", "succeeded"],
      ["pull", "up-to-date"],
    ]);
    const persisted = expectActivityLogProof(
      "git.runtime-action.emitted-line",
      formatActivityLogProofLine(syncLines()[0] ?? {}),
    );
    expect(persisted).toMatchObject({
      phase: "fetch",
      state: "succeeded",
      syncOutcome: "succeeded",
      runId: "run-sync",
    });
    expect(syncLines()[0]?.correlationId).toBe("runtime-git-sync-test");
    const ledger = [...evidence.entries()].filter(([id]) =>
      id.startsWith(GIT_SYNC_EVIDENCE_RUNID_PREFIX),
    );
    expect(ledger.length).toBeGreaterThan(0);
    const recorded = ledger.map(([, body]) => body).join("\n");
    expect(recorded).toContain('"operation":"fetch"');
    expect(recorded).toContain('"operation":"pull"');
    expect(recorded).not.toContain(root);
  });

  it("reports a pull it may not perform instead of changing the worktree", async () => {
    const gitService = service();
    writeFileSync(join(root, "code.js"), "export const value = 3;\n");
    await expect(sync(gitService, "pull")).resolves.toMatchObject({
      kind: "pull",
      status: "dirty-worktree",
    });
    expect(git(root, ["show", "HEAD:code.js"])).toBe("export const value = 1;");
    git(root, ["checkout", "-q", "--", "code.js"]);
    git(root, ["branch", "--unset-upstream"]);
    await expect(sync(gitService, "pull")).resolves.toMatchObject({ status: "no-upstream" });
    expect(syncLines().map((event) => [event.level, event.extra?.state])).toEqual([
      ["warn", "blocked"],
      ["warn", "blocked"],
    ]);
  });

  // The run's authority is proven again immediately before the remote is contacted. A run whose
  // authority closes after the sync owner's own readiness read reaches no remote and is refused.
  it("contacts no remote once the run's authority has closed", async () => {
    const calls: string[] = [];
    const runner: GitProcessRunner = async (args, options) => {
      calls.push(args.find((arg) => !arg.startsWith("-")) ?? "");
      const result = await defaultGitProcessRunner(args, options);
      live = false;
      return result;
    };
    const tracking = git(root, ["rev-parse", "refs/remotes/origin/codex/task"]);
    await expect(sync(service(runner), "fetch")).resolves.toEqual({
      kind: "refused",
      reason: "authority-revoked",
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).not.toContain("fetch");
    expect(git(root, ["rev-parse", "refs/remotes/origin/codex/task"])).toBe(tracking);
    expect(syncLines().map((event) => [event.extra?.state, event.extra?.syncOutcome])).toEqual([
      ["refused", "authority-denied"],
      ["withheld", undefined],
    ]);
  });
});
