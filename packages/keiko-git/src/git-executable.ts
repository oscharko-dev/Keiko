import { constants, accessSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

const GROUP_WRITE_BIT = 0o020;
const WORLD_WRITE_BIT = 0o002;

function executableNames(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly string[] {
  if (platform !== "win32") return ["git"];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension.length > 0);
  return ["git", ...extensions.map((extension) => `git${extension.toLowerCase()}`)];
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function activeGroupIds(): ReadonlySet<number> | undefined {
  if (typeof process.getgroups !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return new Set([process.getgid(), ...process.getgroups()]);
}

function isWritableByCaller(path: string, groupIds: ReadonlySet<number> | undefined): boolean {
  const stats = statSync(path);
  if ((stats.mode & WORLD_WRITE_BIT) !== 0) return true;
  return (
    (stats.mode & GROUP_WRITE_BIT) !== 0 && (groupIds === undefined || groupIds.has(stats.gid))
  );
}

function trustedCandidate(
  candidate: string,
  cwd: string,
  platform: NodeJS.Platform,
  groupIds: ReadonlySet<number> | undefined,
): string | undefined {
  try {
    accessSync(candidate, constants.X_OK);
    const real = realpathSync(candidate);
    if (isContained(realpathSync(cwd), real)) return undefined;
    if (platform !== "win32") {
      const protectedPaths = [dirname(candidate), real, dirname(real)];
      if (protectedPaths.some((path) => isWritableByCaller(path, groupIds))) return undefined;
    }
    return real;
  } catch {
    return undefined;
  }
}

export function resolveGitExecutable(
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  groupIds: ReadonlySet<number> | undefined = activeGroupIds(),
): string | undefined {
  const names = executableNames(env, platform);
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    for (const name of names) {
      const resolved = trustedCandidate(join(entry, name), cwd, platform, groupIds);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}
