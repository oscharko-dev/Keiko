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

/**
 * Independent fallback for a refusal that cannot safely use the primary control tree.
 *
 * Keeping this on a separate platform location lets an overlap refusal remain reconstructable
 * without writing into the audit/uninstall target that caused the refusal.
 */
export function resolveCliControlFailureStateDir(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    return win32.join(home, "AppData", "Local", "KeikoControlFailures");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "Keiko", "control-failures");
  }
  return join(home, ".cache", "keiko", "control-failures");
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

function isAtOrBelow(candidate: string, target: string): boolean {
  const fromTarget = relative(target, candidate);
  return (
    fromTarget === "" ||
    (fromTarget !== ".." && !fromTarget.startsWith(`..${sep}`) && !isAbsolute(fromTarget))
  );
}

/** Conservative lexical fallback used only when canonical target validation itself failed. */
export function cliControlStateLexicallyWouldMutateTarget(
  controlStateDir: string,
  targetDir: string,
): boolean {
  return isAtOrBelow(resolve(controlStateDir), resolve(targetDir));
}

/** True when writing the control log would write at or below the selected target tree. */
export function cliControlStateWouldMutateTarget(
  controlStateDir: string,
  targetDir: string,
): boolean {
  const control = canonicalizeWithMissingTail(controlStateDir);
  const target = canonicalizeWithMissingTail(targetDir);
  return isAtOrBelow(control, target);
}
