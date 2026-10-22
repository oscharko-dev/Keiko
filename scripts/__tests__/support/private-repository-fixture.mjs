import { spawnSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { collectWorkspacePackages } from "../../workspace-graph.mjs";

function copyPackageFixtureLink(source, destination, sourceRoot, fixtureRoot) {
  const resolvedTarget = realpathSync(source);
  const targetPath = relative(sourceRoot, resolvedTarget);
  const isOwned =
    targetPath !== ".." && !targetPath.startsWith(`..${sep}`) && !isAbsolute(targetPath);
  const target = isOwned ? join(fixtureRoot, targetPath) : resolvedTarget;
  const directory = statSync(source).isDirectory();
  symlinkSync(
    process.platform === "win32" && directory ? target : relative(dirname(destination), target),
    destination,
    directory ? "junction" : "file",
  );
}

export function copyPackageFixtureEntry(source, destination, sourceRoot, fixtureRoot) {
  mkdirSync(dirname(destination), { recursive: true });
  const entry = lstatSync(source);
  if (entry.isSymbolicLink()) {
    copyPackageFixtureLink(source, destination, sourceRoot, fixtureRoot);
  } else if (entry.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const child of readdirSync(source)) {
      copyPackageFixtureEntry(
        join(source, child),
        join(destination, child),
        sourceRoot,
        fixtureRoot,
      );
    }
  } else if (entry.isFile()) {
    copyFileSync(source, destination, constants.COPYFILE_FICLONE);
  } else {
    throw new Error("unsupported package fixture entry");
  }
}

export async function copyPackageFixtureSources(sourceRoot, fixtureRoot) {
  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: sourceRoot, encoding: "utf8" });
  if (tracked.status !== 0) throw new Error("package fixture source inventory failed");
  const workspaces = await collectWorkspacePackages(sourceRoot);
  const generated = ["node_modules", "dist"];
  for (const workspace of workspaces) {
    const path = relative(sourceRoot, workspace.dir);
    generated.push(join(path, "node_modules"), join(path, "dist"));
  }
  for (const path of [...tracked.stdout.split("\0").filter(Boolean), ...generated]) {
    const source = join(sourceRoot, path);
    if (existsSync(source)) {
      copyPackageFixtureEntry(source, join(fixtureRoot, path), sourceRoot, fixtureRoot);
    }
  }
  for (const workspace of workspaces) {
    const link = join(fixtureRoot, "node_modules", workspace.name);
    if (
      realpathSync(link) !== realpathSync(join(fixtureRoot, relative(sourceRoot, workspace.dir)))
    ) {
      throw new Error("package fixture workspace escaped its private root");
    }
  }
}
