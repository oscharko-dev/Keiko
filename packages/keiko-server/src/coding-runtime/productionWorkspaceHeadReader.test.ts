import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readProductionWorkspaceHead } from "./productionWorkspaceHeadReader.js";

const SHA1 = "a".repeat(40);
const SHA256 = "b".repeat(64);

describe("production workspace HEAD reader", () => {
  it("reads detached SHA-1 and symbolic loose SHA-256 heads", () => {
    const root = repository();
    writeFileSync(join(root, ".git", "HEAD"), `${SHA1}\n`);
    expect(readProductionWorkspaceHead(root, root)).toBe(SHA1);

    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/issue-2258\n");
    writeFileSync(join(root, ".git", "refs", "heads", "issue-2258"), `${SHA256}\n`);
    expect(readProductionWorkspaceHead(root, root)).toBe(SHA256);
  });

  it("reads a linked worktree SHA-256 head from packed refs", () => {
    const root = repository();
    const workspace = mkdir(join(root, "managed-worktree"));
    const gitDir = mkdir(join(root, ".git", "worktrees", "managed-worktree"));
    writeFileSync(join(workspace, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/issue-2258\n");
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    writeFileSync(join(root, ".git", "packed-refs"), `${SHA256} refs/heads/issue-2258\n`);

    expect(readProductionWorkspaceHead(workspace, root)).toBe(SHA256);
  });

  it.each([
    "repository-dotgit-symlink",
    "worktree-gitdir-symlink",
    "gitdir-escape",
    "commondir-escape",
    "loose-ref-symlink",
    "packed-refs-symlink",
  ] as const)("fails closed for %s", (scenario) => {
    const fixture = unsafeFixture(scenario);
    expect(readProductionWorkspaceHead(fixture.workspace, fixture.repository)).toBeUndefined();
  });
});

type UnsafeScenario =
  | "repository-dotgit-symlink"
  | "worktree-gitdir-symlink"
  | "gitdir-escape"
  | "commondir-escape"
  | "loose-ref-symlink"
  | "packed-refs-symlink";

function unsafeFixture(scenario: UnsafeScenario): { repository: string; workspace: string } {
  const base = mkdtempSync(join(tmpdir(), "keiko-head-unsafe-"));
  const repository = mkdir(join(base, "repository"));
  const external = mkdir(join(base, "external"));
  if (scenario === "repository-dotgit-symlink") {
    writeFileSync(join(external, "HEAD"), `${SHA1}\n`);
    symlinkSync(external, join(repository, ".git"), "dir");
    return { repository, workspace: repository };
  }
  const common = mkdir(join(repository, ".git"));
  const workspace = mkdir(join(repository, "workspace"));
  const gitDir = mkdir(join(common, "worktrees", "workspace"));
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/issue-2258\n");
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  writeFileSync(join(workspace, ".git"), `gitdir: ${gitDir}\n`);
  return mutateUnsafeScenario(scenario, { repository, workspace, external, common, gitDir });
}

interface UnsafeFixture {
  readonly repository: string;
  readonly workspace: string;
  readonly external: string;
  readonly common: string;
  readonly gitDir: string;
}

function mutateUnsafeScenario(scenario: UnsafeScenario, fixture: UnsafeFixture): UnsafeFixture {
  const { workspace, external, common, gitDir } = fixture;
  if (scenario === "worktree-gitdir-symlink") {
    const link = join(common, "worktrees", "linked");
    symlinkSync(gitDir, link, "dir");
    writeFileSync(join(workspace, ".git"), `gitdir: ${link}\n`);
  } else if (scenario === "gitdir-escape") {
    writeFileSync(join(external, "HEAD"), `${SHA1}\n`);
    writeFileSync(join(workspace, ".git"), `gitdir: ${external}\n`);
  } else if (scenario === "commondir-escape") {
    writeFileSync(join(gitDir, "commondir"), `${external}\n`);
  } else if (scenario === "loose-ref-symlink") {
    mkdirSync(join(common, "refs", "heads"), { recursive: true });
    writeFileSync(join(external, "head"), `${SHA1}\n`);
    symlinkSync(join(external, "head"), join(common, "refs", "heads", "issue-2258"));
  } else if (scenario === "packed-refs-symlink") {
    writeFileSync(join(external, "packed-refs"), `${SHA1} refs/heads/issue-2258\n`);
    symlinkSync(join(external, "packed-refs"), join(common, "packed-refs"));
  }
  return fixture;
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-head-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function mkdir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
