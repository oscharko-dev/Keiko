import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

/**
 * Durable CLI activity state that is independent from a workspace's removable runtime state.
 *
 * The path deliberately ignores environment overrides: commands use it while auditing or
 * deleting an operator-selected state tree, so steering it through that tree would defeat the
 * evidence boundary it exists to preserve.
 */
export function resolveCliControlStateDir(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    return win32.join(home, "AppData", "Local", "Keiko", "control");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Keiko", "control");
  }
  return join(home, ".local", "state", "keiko", "control");
}

function canonicalizeWithMissingTail(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync.native(cursor), ...missing);
}

/** True when writing the control log would write at or below the selected target tree. */
export function cliControlStateWouldMutateTarget(
  controlStateDir: string,
  targetDir: string,
): boolean {
  const control = canonicalizeWithMissingTail(controlStateDir);
  const target = canonicalizeWithMissingTail(targetDir);
  const fromTarget = relative(target, control);
  return (
    fromTarget === "" ||
    (fromTarget !== ".." && !fromTarget.startsWith(`..${sep}`) && !isAbsolute(fromTarget))
  );
}
