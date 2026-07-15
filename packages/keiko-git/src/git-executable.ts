import { constants, accessSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

const UNTRUSTED_WRITE_BITS = 0o022;

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

function trustedCandidate(
  candidate: string,
  cwd: string,
  platform: NodeJS.Platform,
): string | undefined {
  try {
    accessSync(candidate, constants.X_OK);
    const real = realpathSync(candidate);
    if (isContained(realpathSync(cwd), real)) return undefined;
    if (platform !== "win32") {
      if ((statSync(real).mode & UNTRUSTED_WRITE_BITS) !== 0) return undefined;
      if ((statSync(dirname(real)).mode & UNTRUSTED_WRITE_BITS) !== 0) return undefined;
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
): string | undefined {
  const names = executableNames(env, platform);
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    for (const name of names) {
      const resolved = trustedCandidate(join(entry, name), cwd, platform);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}
