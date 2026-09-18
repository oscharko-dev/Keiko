import { createHash } from "node:crypto";
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

/** Stable body-free identity for an operator-selected filesystem target. */
export function cliTargetIdentitySha256(targetDir: string): string {
  return createHash("sha256").update(resolve(targetDir), "utf8").digest("hex");
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

function pathForComparison(path: string, platform: NodeJS.Platform): string {
  return platform === "darwin" || platform === "win32" ? path.toLowerCase() : path;
}

function isAtOrBelow(candidate: string, target: string, platform: NodeJS.Platform): boolean {
  const fromTarget = relative(
    pathForComparison(target, platform),
    pathForComparison(candidate, platform),
  );
  return (
    fromTarget === "" ||
    (fromTarget !== ".." && !fromTarget.startsWith(`..${sep}`) && !isAbsolute(fromTarget))
  );
}

/** True when either the control state or selected target contains the other. */
export function cliControlStateConflictsWithTarget(
  controlStateDir: string,
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const control = canonicalizeWithMissingTail(controlStateDir);
  const target = canonicalizeWithMissingTail(targetDir);
  return isAtOrBelow(control, target, platform) || isAtOrBelow(target, control, platform);
}
