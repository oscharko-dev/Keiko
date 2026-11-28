import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repositoryRootsAreSameFolder } from "./repositoryRootIdentity.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-root-identity-")));
  roots.push(root);
  return root;
}

describe("repository root identity", () => {
  it("takes the same spelling, a trailing separator and an empty root as the text says", () => {
    const root = scratch();

    expect(repositoryRootsAreSameFolder(root, root)).toBe(true);
    expect(repositoryRootsAreSameFolder(root, `${root}/`)).toBe(true);
    expect(repositoryRootsAreSameFolder("", "")).toBe(false);
    expect(repositoryRootsAreSameFolder(root, "")).toBe(false);
  });

  it("calls two folders that differ in case one folder only when the filesystem says so", () => {
    const root = scratch();
    const upper = join(root, "Repo");
    const lower = join(root, "repo");
    mkdirSync(upper);
    // The filesystem decides, not the platform: a volume that folds case already resolves the
    // lower-case spelling to the folder just made.
    const foldsCase = existsSync(lower);
    if (!foldsCase) mkdirSync(lower);

    expect(repositoryRootsAreSameFolder(upper, lower)).toBe(foldsCase);
  });

  it("never accepts a differently cased spelling of a folder that does not exist", () => {
    const root = scratch();
    const upper = join(root, "Repo");
    mkdirSync(upper);
    const foldsCase = existsSync(join(root, "repo"));

    expect(repositoryRootsAreSameFolder(upper, join(root, "repo", "missing"))).toBe(false);
    expect(repositoryRootsAreSameFolder(upper, join(root, foldsCase ? "other" : "REPO"))).toBe(
      false,
    );
  });

  it("recognises two aliases of one repository and keeps two repositories apart", () => {
    const root = scratch();
    const repository = join(root, "repository");
    const other = join(root, "other");
    mkdirSync(repository);
    mkdirSync(other);
    const alias = join(root, "alias");
    symlinkSync(repository, alias, "dir");

    expect(repositoryRootsAreSameFolder(repository, alias)).toBe(true);
    expect(repositoryRootsAreSameFolder(repository, other)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "keeps a folder named with a literal backslash apart from the nested folder it resembles",
    () => {
      const root = scratch();
      mkdirSync(join(root, "a", "b"), { recursive: true });
      mkdirSync(join(root, "a\\b"));

      expect(repositoryRootsAreSameFolder(join(root, "a\\b"), join(root, "a", "b"))).toBe(false);
      expect(repositoryRootsAreSameFolder(join(root, "a\\b"), `${join(root, "a\\b")}/`)).toBe(true);
    },
  );
});
