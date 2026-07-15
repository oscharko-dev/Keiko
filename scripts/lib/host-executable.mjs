import { constants, accessSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+$/u;
const UNTRUSTED_WRITE_BITS = 0o022;

function executableNames(command, env, platform) {
  if (platform !== "win32") return [command];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function isContained(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function hasTrustedPermissions(candidate, platform) {
  if (platform === "win32") return true;
  return (
    (statSync(candidate).mode & UNTRUSTED_WRITE_BITS) === 0 &&
    (statSync(dirname(candidate)).mode & UNTRUSTED_WRITE_BITS) === 0
  );
}

function trustedCandidate(candidate, workspaceRoot, platform) {
  try {
    accessSync(candidate, constants.X_OK);
    const real = realpathSync(candidate);
    if (isContained(realpathSync(workspaceRoot), real)) return undefined;
    return hasTrustedPermissions(real, platform) ? real : undefined;
  } catch {
    return undefined;
  }
}

export function resolveHostExecutable(
  command,
  { env = process.env, platform = process.platform, workspaceRoot = repoRoot } = {},
) {
  if (!BARE_EXECUTABLE.test(command)) {
    throw new Error(`host executable name must be bare: ${command}`);
  }
  const names = executableNames(command, env, platform);
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    const resolved = resolveFromEntry(entry, names, workspaceRoot, platform);
    if (resolved !== undefined) return resolved;
  }
  throw new Error(`trusted host executable is unavailable: ${command}`);
}

function resolveFromEntry(entry, names, workspaceRoot, platform) {
  if (!isAbsolute(entry)) return undefined;
  for (const name of names) {
    const resolved = trustedCandidate(join(entry, name), workspaceRoot, platform);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}
