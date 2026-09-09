import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isGitObjectId } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import { nodeWorkspaceFs } from "./fs.js";
import { resolveGitdir } from "./gitHistory.js";
import { isWithinWorkspace } from "./paths.js";

export interface GitPublishView {
  readonly gitDirectory: string;
  readonly objectDirectory: string;
  readonly isCurrent: () => boolean;
}

function metadataText(base: string, name: string, limit: number): string {
  const read = nodeWorkspaceFs.readFileUtf8WithinRootSameDescriptor;
  if (read === undefined) throw new Error("git-publish-metadata-read-unavailable");
  return read(base, join(base, name), limit, "reject", "complete").rawText;
}

/** Linked worktrees share only their canonical parent repository's object database. */
function commonDirectory(gitDirectory: string): string {
  if (!nodeWorkspaceFs.exists(join(gitDirectory, "commondir"))) return gitDirectory;
  if (
    basename(dirname(gitDirectory)) !== "worktrees" ||
    basename(dirname(dirname(gitDirectory))) !== ".git" ||
    metadataText(gitDirectory, "commondir", 64).trim() !== "../.."
  )
    throw new Error("git-publish-common-directory-unsupported");
  const common = dirname(dirname(gitDirectory));
  if (nodeWorkspaceFs.realPath(common) !== common)
    throw new Error("git-publish-common-directory-drift");
  return common;
}

function objectDirectory(common: string): string {
  const objects = join(common, "objects");
  const canonical = nodeWorkspaceFs.realPath(objects);
  if (
    canonical !== objects ||
    !lstatSync(objects).isDirectory() ||
    lstatSync(objects).isSymbolicLink()
  )
    throw new Error("git-publish-object-directory-invalid");
  return objects;
}

function writeView(view: string, common: string, commit: string): ReadonlyMap<string, string> {
  mkdirSync(join(view, "refs"), { mode: 0o700 });
  mkdirSync(join(view, "objects"), { mode: 0o700 });
  writeFileSync(join(view, "HEAD"), `${commit}\n`, { flag: "wx", mode: 0o600 });
  const format = commit.length === 64 ? 1 : 0;
  const extension = format === 1 ? "[extensions]\nobjectFormat = sha256\n" : "";
  const config = `[core]\nrepositoryFormatVersion = ${String(format)}\nbare = true\n${extension}`;
  writeFileSync(join(view, "config"), config, { flag: "wx", mode: 0o600 });
  const expected = new Map([
    ["HEAD", `${commit}\n`],
    ["config", config],
  ]);
  if (!nodeWorkspaceFs.exists(join(common, "shallow"))) return expected;
  const shallow = metadataText(common, "shallow", 1_048_576);
  const lines = shallow.trimEnd().split("\n");
  if (
    lines.length > 10_000 ||
    lines.some((line) => !isGitObjectId(line) || line.length !== commit.length)
  )
    throw new Error("git-publish-shallow-metadata-invalid");
  writeFileSync(join(view, "shallow"), shallow, { flag: "wx", mode: 0o600 });
  expected.set("shallow", shallow);
  return expected;
}

function privateRootOutsideRepository(root: string, scopes: readonly string[]): string {
  const canonical = nodeWorkspaceFs.realPath(root);
  if (
    scopes.some(
      (scope) => isWithinWorkspace(scope, canonical) || isWithinWorkspace(canonical, scope),
    )
  )
    throw new Error("git-publish-private-root-overlap");
  directoryIdentity(canonical);
  return canonical;
}

function metadataCurrent(view: string, expected: ReadonlyMap<string, string>): boolean {
  try {
    return (
      [...expected].every(([name, value]) => metadataText(view, name, 1_048_576) === value) &&
      (expected.has("shallow") || !nodeWorkspaceFs.exists(join(view, "shallow")))
    );
  } catch {
    return false;
  }
}

function directoryIdentity(path: string): () => boolean {
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new Error("git-publish-directory-invalid");
  return (): boolean => {
    const after = lstatSync(path, { throwIfNoEntry: false });
    return (
      after?.isDirectory() === true &&
      !after.isSymbolicLink() &&
      after.dev === before.dev &&
      after.ino === before.ino
    );
  };
}

/** Private effect metadata reuses the authorized Git object store, never live remote configuration. */
export async function withGitPublishView<T>(
  workspaceRoot: string,
  commit: string,
  publish: (view: GitPublishView) => Promise<T>,
  privateRoot: string,
): Promise<T> {
  if (!isGitObjectId(commit)) throw new TypeError("git-publish-commit-invalid");
  const git = await resolveGitdir(nodeWorkspaceFs, workspaceRoot);
  if (git === undefined) throw new Error("git-publish-metadata-unavailable");
  const checkGit = directoryIdentity(git.path);
  const common = commonDirectory(git.path);
  const checkCommon = directoryIdentity(common);
  const objects = objectDirectory(common);
  const checkObjects = directoryIdentity(objects);
  const temporary = privateRootOutsideRepository(privateRoot, [workspaceRoot, git.path, common]);
  const checkPrivateRoot = directoryIdentity(temporary);
  const view = mkdtempSync(join(temporary, ".keiko-publish-"));
  const checkView = directoryIdentity(view);
  const directoriesCurrent = (): boolean =>
    checkGit() && checkCommon() && checkObjects() && checkPrivateRoot() && checkView();
  try {
    if (!directoriesCurrent()) throw new Error("git-publish-metadata-drift");
    const expected = writeView(view, common, commit);
    const isCurrent = (): boolean => directoriesCurrent() && metadataCurrent(view, expected);
    if (!isCurrent()) throw new Error("git-publish-metadata-drift");
    return await publish({ gitDirectory: view, objectDirectory: objects, isCurrent });
  } finally {
    if (checkPrivateRoot() && checkView()) rmSync(view, { recursive: true, force: true });
  }
}
