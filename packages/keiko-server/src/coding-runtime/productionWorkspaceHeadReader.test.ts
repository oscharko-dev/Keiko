import { execFileSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readProductionWorkspaceHead,
  type ProductionWorkspaceHeadFileSystem,
} from "./productionWorkspaceHeadReader.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production workspace HEAD reader", () => {
  it("reads the exact managed worktree HEAD without ambient Git lookup", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-runtime-head-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "runtime@keiko.example"]);
    git(root, ["config", "user.name", "Keiko Runtime"]);
    writeFileSync(join(root, "file.txt"), "bounded");
    git(root, ["add", "file.txt"]);
    git(root, ["commit", "-q", "-m", "fixture"]);

    expect(readProductionWorkspaceHead(root, root)).toBe(git(root, ["rev-parse", "HEAD"]));
    expect(readProductionWorkspaceHead(join(root, "missing"), root)).toBeUndefined();
  });

  it("rejects a pathname swap between lstat and handle open", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-runtime-head-swap-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "runtime@keiko.example"]);
    git(root, ["config", "user.name", "Keiko Runtime"]);
    writeFileSync(join(root, "file.txt"), "bounded");
    git(root, ["add", "file.txt"]);
    git(root, ["commit", "-q", "-m", "fixture"]);
    const headPath = join(realpathSync(root), ".git", "HEAD");
    let swapped = false;
    const fileSystem: ProductionWorkspaceHeadFileSystem = {
      close: closeSync,
      fstat: fstatSync,
      lstat: lstatSync,
      open: (path) => {
        if (path === headPath && !swapped) {
          swapped = true;
          renameSync(headPath, `${headPath}.before-swap`);
          writeFileSync(headPath, `${"f".repeat(40)}\n`, "utf8");
        }
        return openSync(path, "r");
      },
      read: readSync,
      realpath: realpathSync,
    };

    expect(readProductionWorkspaceHead(root, root, fileSystem)).toBeUndefined();
    expect(swapped).toBe(true);
  });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}
