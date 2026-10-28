import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activityLogOperationSchema } from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";
import {
  recordNativeGitMetadataResolution,
  resolveNativeGitMetadata,
} from "./opencodeNativeGitMetadata.js";

let root: string;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ""} failed`);
}

/** A repository with one commit and a linked worktree of it; both under the test's own root. */
function repositoryWithWorktree(name: string): {
  readonly repository: string;
  readonly worktree: string;
} {
  const repository = join(root, `${name}-repository`);
  const worktree = join(root, `${name}-worktree`);
  mkdirSync(repository);
  git(repository, "init", "-q", "-b", "main");
  writeFileSync(join(repository, "app.js"), "module.exports = 1;\n");
  git(repository, "add", "app.js");
  git(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  git(repository, "worktree", "add", "-q", worktree);
  return { repository, worktree: realpathSync(worktree) };
}

function access(
  kind: "ordinary" | "managed-task",
  canonicalRoot: string,
  repositoryRoot = "",
): WorkspaceRootAccess {
  return kind === "ordinary"
    ? { kind, canonicalRoot, fs: nodeWorkspaceFs }
    : { kind, canonicalRoot, fs: nodeWorkspaceFs, repositoryRoot };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-git-metadata-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("native Git metadata of the task workspace (#3897 review)", () => {
  it("names a managed task worktree's common Git directory, proven against its own repository", () => {
    const { repository, worktree } = repositoryWithWorktree("managed");
    expect(
      resolveNativeGitMetadata(worktree, access("managed-task", worktree, repository)),
    ).toEqual({
      layout: "linked-worktree",
      binding: "managed-task",
      readRoots: [realpathSync(join(repository, ".git"))],
    });
  });

  it("names an ordinary linked worktree's common Git directory after the reciprocal proof", () => {
    const { repository, worktree } = repositoryWithWorktree("ordinary");
    expect(resolveNativeGitMetadata(worktree, access("ordinary", worktree))).toEqual({
      layout: "linked-worktree",
      binding: "ordinary",
      readRoots: [realpathSync(join(repository, ".git"))],
    });
  });

  it("needs nothing for a repository with its own Git directory or a folder without Git", () => {
    const { repository } = repositoryWithWorktree("plain");
    const folder = join(root, "folder");
    mkdirSync(folder);
    expect(resolveNativeGitMetadata(repository, undefined)).toEqual({
      layout: "repository",
      binding: "unresolved",
      readRoots: [],
    });
    expect(resolveNativeGitMetadata(folder, access("ordinary", folder))).toEqual({
      layout: "none",
      binding: "ordinary",
      readRoots: [],
    });
  });

  it("names nothing for a forged pointer to a directory outside any registration", () => {
    const forged = join(root, "forged");
    const target = join(root, "credentials", ".git", "worktrees", "forged");
    mkdirSync(forged);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(forged, ".git"), `gitdir: ${target}\n`);
    expect(resolveNativeGitMetadata(forged, access("ordinary", forged))).toEqual({
      layout: "unproven",
      binding: "ordinary",
      readRoots: [],
    });
  });

  it("names nothing for a pointer to another worktree's registration (stale or misdirected)", () => {
    const { repository, worktree } = repositoryWithWorktree("victim");
    const misdirected = join(root, "misdirected");
    mkdirSync(misdirected);
    writeFileSync(
      join(misdirected, ".git"),
      `gitdir: ${join(repository, ".git", "worktrees", "victim-worktree")}\n`,
    );
    expect(resolveNativeGitMetadata(worktree, access("ordinary", worktree)).layout).toBe(
      "linked-worktree",
    );
    expect(resolveNativeGitMetadata(misdirected, access("ordinary", misdirected))).toEqual({
      layout: "unproven",
      binding: "ordinary",
      readRoots: [],
    });
  });

  it("names nothing for a managed task whose pointer leads into a different repository", () => {
    const { worktree } = repositoryWithWorktree("elsewhere");
    const { repository: bound } = repositoryWithWorktree("bound");
    expect(resolveNativeGitMetadata(worktree, access("managed-task", worktree, bound))).toEqual({
      layout: "unproven",
      binding: "managed-task",
      readRoots: [],
    });
  });

  it("names nothing for a `.git` that is a link", () => {
    const { repository } = repositoryWithWorktree("linked");
    const workspace = join(root, "link-workspace");
    mkdirSync(workspace);
    symlinkSync(join(repository, ".git"), join(workspace, ".git"));
    expect(resolveNativeGitMetadata(workspace, undefined).layout).toBe("unproven");
  });

  function recorded(layout: "linked-worktree" | "unproven"): readonly ServerLogEvent[] {
    const events: ServerLogEvent[] = [];
    recordNativeGitMetadataResolution({ write: (event) => events.push(event) }, "run-git-0001", {
      layout,
      binding: "managed-task",
      readRoots: layout === "linked-worktree" ? [join(root, "PRIVATE_REPOSITORY", ".git")] : [],
    });
    return events;
  }

  it("records the layout body-free and warns only when a pointer could not be proven", () => {
    const [proven] = recorded("linked-worktree");
    const [unproven] = recorded("unproven");
    expect(proven).toMatchObject({ level: "info", correlationId: "run-git-0001" });
    expect(unproven).toMatchObject({ level: "warn", errorKind: "conflict" });
    expect(JSON.stringify([proven, unproven])).not.toContain("PRIVATE_REPOSITORY");
  });

  it.skipIf(activityLogOperationSchema("coding-runtime.git-metadata.resolved") === undefined)(
    "persists the resolution through the registered production sink with closed fields",
    () => {
      const [event] = recorded("linked-worktree");
      const line = expectActivityLogProof(
        "coding-runtime.git-metadata.resolved.emitted-line",
        formatActivityLogProofLine(event ?? {}),
      );
      expect(line).toMatchObject({
        op: "coding-runtime.git-metadata.resolved",
        correlationId: "run-git-0001",
        layout: "linked-worktree",
        binding: "managed-task",
        readRootCount: 1,
      });
      expect(JSON.stringify(line)).not.toContain("PRIVATE_REPOSITORY");
    },
  );
});
