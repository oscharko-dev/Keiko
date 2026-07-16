import { constants, accessSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+$/u;
const GROUP_WRITE_BIT = 0o020;
const WORLD_WRITE_BIT = 0o002;

function executableNames(command, env, platform) {
  if (platform !== "win32") return [command];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function isContained(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function activeGroupIds() {
  if (typeof process.getgroups !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return [...new Set([process.getgid(), ...process.getgroups()])];
}

function isWritableByCaller(path, groupIds) {
  const stats = statSync(path);
  if ((stats.mode & WORLD_WRITE_BIT) !== 0) return true;
  return (
    (stats.mode & GROUP_WRITE_BIT) !== 0 && (groupIds === undefined || groupIds.includes(stats.gid))
  );
}

function isRuntimeAnchored(candidate, real, trustedRoots) {
  const candidateDirectory = realpathSync(dirname(candidate));
  return trustedRoots.some(
    (root) => isContained(root, candidateDirectory) && isContained(root, real),
  );
}

function hasTrustedPermissions(candidate, real, platform, groupIds, trustedRoots) {
  if (platform === "win32") return true;
  const protectedPaths = [dirname(candidate), real, dirname(real)];
  return (
    protectedPaths.every((path) => !isWritableByCaller(path, groupIds)) ||
    isRuntimeAnchored(candidate, real, trustedRoots)
  );
}

function trustedCandidate(candidate, workspaceRoot, platform, groupIds, trustedRoots) {
  try {
    accessSync(candidate, constants.X_OK);
    const real = realpathSync(candidate);
    if (isContained(realpathSync(workspaceRoot), real)) return undefined;
    return hasTrustedPermissions(candidate, real, platform, groupIds, trustedRoots)
      ? real
      : undefined;
  } catch {
    return undefined;
  }
}

function runtimeTrustRoots() {
  try {
    return [dirname(dirname(realpathSync(process.execPath)))];
  } catch {
    return [];
  }
}

export function resolveHostExecutable(
  command,
  {
    env = process.env,
    groupIds = activeGroupIds(),
    platform = process.platform,
    trustedRoots = runtimeTrustRoots(),
    workspaceRoot = repoRoot,
  } = {},
) {
  if (!BARE_EXECUTABLE.test(command)) {
    throw new Error(`host executable name must be bare: ${command}`);
  }
  const names = executableNames(command, env, platform);
  const realTrustedRoots = trustedRoots.map((root) => realpathSync(root));
  const resolved = resolveFromPath(
    env.PATH,
    names,
    workspaceRoot,
    platform,
    groupIds,
    realTrustedRoots,
  );
  if (resolved !== undefined) return resolved;
  throw new Error(`trusted host executable is unavailable: ${command}`);
}

function resolveFromPath(path, names, workspaceRoot, platform, groupIds, trustedRoots) {
  for (const entry of (path ?? "").split(delimiter)) {
    const resolved = resolveFromEntry(
      entry,
      names,
      workspaceRoot,
      platform,
      groupIds,
      trustedRoots,
    );
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function resolveFromEntry(entry, names, workspaceRoot, platform, groupIds, trustedRoots) {
  if (!isAbsolute(entry)) return undefined;
  for (const name of names) {
    const resolved = trustedCandidate(
      join(entry, name),
      workspaceRoot,
      platform,
      groupIds,
      trustedRoots,
    );
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}
