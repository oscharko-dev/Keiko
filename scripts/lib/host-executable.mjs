import { Buffer } from "node:buffer";
import {
  chmodSync,
  closeSync,
  constants,
  accessSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+$/u;
const GROUP_WRITE_BIT = 0o020;
const WORLD_WRITE_BIT = 0o002;
const SNAPSHOT_MODE = 0o500;
const snapshotRoots = new Set();
const formulaSnapshots = new Map();
let snapshotCleanupRegistered = false;

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

function statsWritableByCaller(stats, groupIds) {
  if ((stats.mode & WORLD_WRITE_BIT) !== 0) return true;
  return (
    (stats.mode & GROUP_WRITE_BIT) !== 0 && (groupIds === undefined || groupIds.includes(stats.gid))
  );
}

function isWritableByCaller(path, groupIds) {
  return statsWritableByCaller(statSync(path), groupIds);
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

function isOwnedBy(path, ownerUid) {
  return statSync(path).uid === ownerUid;
}

function homebrewFormulaIdentity(candidate, real, runtimeExecutable, platform, groupIds) {
  if (platform === "win32" || !lstatSync(candidate).isSymbolicLink()) return undefined;
  const runtimeReal = realpathSync(runtimeExecutable);
  const cellar = ancestorNamed(runtimeReal, "Cellar");
  if (cellar === undefined || basename(real) !== basename(candidate)) return undefined;
  const formulaEntry = join(cellar, basename(candidate));
  if (lstatSync(formulaEntry).isSymbolicLink()) return undefined;
  const formulaRoot = realpathSync(formulaEntry);
  const runtimeOwnerUid = statSync(runtimeReal).uid;
  const sourceStats = statSync(real);
  const trusted =
    isContained(formulaRoot, real) &&
    protectedFormulaPaths(formulaRoot, real).every(
      (path) => isOwnedBy(path, runtimeOwnerUid) && !isWritableByCaller(path, groupIds),
    );
  return trusted ? { sourceStats, runtimeOwnerUid } : undefined;
}

function cleanupSnapshots() {
  for (const root of snapshotRoots) rmSync(root, { force: true, recursive: true });
  snapshotRoots.clear();
  formulaSnapshots.clear();
}

function privateSnapshotRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-host-executable-"));
  chmodSync(root, 0o700);
  snapshotRoots.add(root);
  if (!snapshotCleanupRegistered) {
    snapshotCleanupRegistered = true;
    process.once("exit", cleanupSnapshots);
  }
  return root;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function copyExecutable(sourceFd, destinationFd) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
  while (bytesRead > 0) {
    let offset = 0;
    while (offset < bytesRead) {
      const written = writeSync(destinationFd, buffer, offset, bytesRead - offset);
      if (written === 0) throw new Error("trusted executable snapshot write made no progress");
      offset += written;
    }
    bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
  }
}

function snapshotHomebrewExecutable(real, identity, groupIds) {
  const snapshotKey = [
    real,
    identity.sourceStats.dev,
    identity.sourceStats.ino,
    identity.sourceStats.size,
    identity.sourceStats.mtimeMs,
  ].join(":");
  const cached = formulaSnapshots.get(snapshotKey);
  if (cached !== undefined) return cached;
  const sourceFd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationFd;
  let root;
  let complete = false;
  try {
    const openedStats = fstatSync(sourceFd);
    if (
      !openedStats.isFile() ||
      !sameFile(openedStats, identity.sourceStats) ||
      openedStats.uid !== identity.runtimeOwnerUid ||
      statsWritableByCaller(openedStats, groupIds)
    ) {
      return undefined;
    }
    root = privateSnapshotRoot();
    const snapshot = join(root, basename(real));
    destinationFd = openSync(
      snapshot,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      SNAPSHOT_MODE,
    );
    copyExecutable(sourceFd, destinationFd);
    fsyncSync(destinationFd);
    chmodSync(snapshot, SNAPSHOT_MODE);
    formulaSnapshots.set(snapshotKey, snapshot);
    complete = true;
    return snapshot;
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
    if (root !== undefined && !complete) {
      snapshotRoots.delete(root);
      rmSync(root, { force: true, recursive: true });
    }
  }
}

function trustedExecutablePath(
  candidate,
  real,
  runtimeExecutable,
  platform,
  groupIds,
  trustedRoots,
) {
  if (platform === "win32") return real;
  const protectedPaths = [dirname(candidate), real, dirname(real)];
  if (
    protectedPaths.every((path) => !isWritableByCaller(path, groupIds)) ||
    isRuntimeAnchored(candidate, real, trustedRoots)
  ) {
    return real;
  }
  const identity = homebrewFormulaIdentity(candidate, real, runtimeExecutable, platform, groupIds);
  return identity === undefined ? undefined : snapshotHomebrewExecutable(real, identity, groupIds);
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
    return trustedExecutablePath(
      candidate,
      real,
      runtimeExecutable,
      platform,
      groupIds,
      trustedRoots,
    );
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
