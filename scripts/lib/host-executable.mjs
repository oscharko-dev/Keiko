import { constants, accessSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+$/u;
const GROUP_WRITE_BIT = 0o020;
const WORLD_WRITE_BIT = 0o002;

function environmentValue(env, name, platform) {
  if (env[name] !== undefined || platform !== "win32") return env[name];
  const matchingName = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === name.toUpperCase(),
  );
  return matchingName === undefined ? undefined : env[matchingName];
}

function executableNames(command, env, platform) {
  if (platform !== "win32") return [command];
  const extensions = (environmentValue(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
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

function ancestorNamed(path, name) {
  let current = dirname(path);
  while (dirname(current) !== current) {
    if (basename(current) === name) return current;
    current = dirname(current);
  }
  return undefined;
}

function protectedFormulaPaths(formulaRoot, real) {
  const paths = [real];
  let current = dirname(real);
  while (isContained(formulaRoot, current)) {
    paths.push(current);
    if (current === formulaRoot) break;
    current = dirname(current);
  }
  return paths;
}

function isHomebrewFormulaTarget(candidate, real, runtimeExecutable, platform, groupIds) {
  if (platform === "win32" || !lstatSync(candidate).isSymbolicLink()) return false;
  const cellar = ancestorNamed(realpathSync(runtimeExecutable), "Cellar");
  if (cellar === undefined || basename(real) !== basename(candidate)) return false;
  const formulaRoot = realpathSync(join(cellar, basename(candidate)));
  return (
    isContained(formulaRoot, real) &&
    protectedFormulaPaths(formulaRoot, real).every((path) => !isWritableByCaller(path, groupIds))
  );
}

function hasTrustedPermissions(
  candidate,
  real,
  runtimeExecutable,
  platform,
  groupIds,
  trustedRoots,
) {
  if (platform === "win32") return true;
  const protectedPaths = [dirname(candidate), real, dirname(real)];
  return (
    protectedPaths.every((path) => !isWritableByCaller(path, groupIds)) ||
    isRuntimeAnchored(candidate, real, trustedRoots) ||
    isHomebrewFormulaTarget(candidate, real, runtimeExecutable, platform, groupIds)
  );
}

function trustedCandidate(
  candidate,
  workspaceRoot,
  runtimeExecutable,
  platform,
  groupIds,
  trustedRoots,
) {
  try {
    accessSync(candidate, constants.X_OK);
    const real = realpathSync(candidate);
    if (isContained(realpathSync(workspaceRoot), real)) return undefined;
    return hasTrustedPermissions(
      candidate,
      real,
      runtimeExecutable,
      platform,
      groupIds,
      trustedRoots,
    )
      ? real
      : undefined;
  } catch {
    return undefined;
  }
}

export function runtimeTrustRoots(runtimeExecutable = process.execPath) {
  try {
    return [dirname(dirname(realpathSync(runtimeExecutable)))];
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
    runtimeExecutable = process.execPath,
    trustedRoots = runtimeTrustRoots(runtimeExecutable),
    workspaceRoot = repoRoot,
  } = {},
) {
  if (!BARE_EXECUTABLE.test(command)) {
    throw new Error(`host executable name must be bare: ${command}`);
  }
  const names = executableNames(command, env, platform);
  const realTrustedRoots = trustedRoots.map((root) => realpathSync(root));
  const path = environmentValue(env, "PATH", platform);
  const resolved = resolveTrustedExecutable(
    runtimeExecutable,
    path,
    names,
    workspaceRoot,
    platform,
    groupIds,
    realTrustedRoots,
  );
  if (resolved !== undefined) return resolved;
  throw new Error(`trusted host executable is unavailable: ${command}`);
}

function resolveTrustedExecutable(
  runtimeExecutable,
  path,
  names,
  workspaceRoot,
  platform,
  groupIds,
  trustedRoots,
) {
  const runtimeResolved = runtimeExecutableFromPath(
    runtimeExecutable,
    path,
    names,
    workspaceRoot,
    platform,
    groupIds,
    trustedRoots,
  );
  if (runtimeResolved !== undefined) return runtimeResolved;
  return resolveFromPath(
    path,
    names,
    workspaceRoot,
    runtimeExecutable,
    platform,
    groupIds,
    trustedRoots,
  );
}

function runtimeExecutableFromPath(
  runtimeExecutable,
  path,
  names,
  workspaceRoot,
  platform,
  groupIds,
  trustedRoots,
) {
  const nodeRuntimeBin = runtimeBin(runtimeExecutable);
  if (nodeRuntimeBin === undefined) return undefined;
  const resolved = resolveFromEntry(
    nodeRuntimeBin,
    names,
    workspaceRoot,
    runtimeExecutable,
    platform,
    groupIds,
    trustedRoots,
  );
  return resolved !== undefined && pathSelectsExecutable(path, names, resolved)
    ? resolved
    : undefined;
}

function pathSelectsExecutable(path, names, expectedReal) {
  for (const entry of (path ?? "").split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    for (const name of names) {
      try {
        if (realpathSync(join(entry, name)) === expectedReal) return true;
      } catch {
        // Keep searching: absent and broken PATH candidates are not authoritative.
      }
    }
  }
  return false;
}

export function shellCommandForTrustedExecutable(executable, platform = process.platform) {
  return platform === "win32" ? `"${executable}"` : executable;
}

function resolveFromPath(
  path,
  names,
  workspaceRoot,
  runtimeExecutable,
  platform,
  groupIds,
  trustedRoots,
) {
  for (const entry of (path ?? "").split(delimiter)) {
    const resolved = resolveFromEntry(
      entry,
      names,
      workspaceRoot,
      runtimeExecutable,
      platform,
      groupIds,
      trustedRoots,
    );
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function runtimeBin(runtimeExecutable) {
  try {
    return dirname(realpathSync(runtimeExecutable));
  } catch {
    return undefined;
  }
}

function resolveFromEntry(
  entry,
  names,
  workspaceRoot,
  runtimeExecutable,
  platform,
  groupIds,
  trustedRoots,
) {
  if (!isAbsolute(entry)) return undefined;
  for (const name of names) {
    const resolved = trustedCandidate(
      join(entry, name),
      workspaceRoot,
      runtimeExecutable,
      platform,
      groupIds,
      trustedRoots,
    );
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}
