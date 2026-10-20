import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertSafeArtifactAncestors,
  assertSqliteStatePath,
  chmodIfPresent,
} from "@oscharko-dev/keiko-security/fs-hardening";
import { cliTargetIdentitySha256 } from "./cli-control-state.js";
import { resolveWithExistingAncestor } from "./launcher-paths.js";

function lifecycleGuardPath(stateDir: string): string {
  const absolute = resolve(stateDir);
  assertSafeArtifactAncestors(join(dirname(absolute), "ui.pid"), "manifest");
  const parent = resolveWithExistingAncestor(dirname(absolute));
  const canonical = join(parent, basename(absolute));
  const identity =
    process.platform === "darwin" || process.platform === "win32"
      ? canonical.toLowerCase()
      : canonical;
  return join(
    parent,
    `.keiko-lifecycle-${cliTargetIdentitySha256(identity)}`,
    ".keiko",
    "guards",
    "ui.pid",
  );
}

/** Serializes existing lifecycle tracking; the persistent PID record fences uncertain starts. */
export async function withUiLifecycleGuard<T>(
  stateDir: string,
  create: boolean,
  operation: () => Promise<T>,
): Promise<{ readonly kind: "busy" } | { readonly kind: "complete"; readonly value: T }> {
  if (!create && !existsSync(stateDir)) return { kind: "complete", value: await operation() };
  // The stable inode must survive full state removal and fence another start until it finishes.
  const path = lifecycleGuardPath(stateDir);
  assertSqliteStatePath(path);
  const { acquireSqliteFileGuard } = await import("@oscharko-dev/keiko-security/sqlite-file-guard");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertSqliteStatePath(path);
  const guard = acquireSqliteFileGuard(path, (): void => {
    chmodIfPresent(path, 0o600);
  });
  if (guard === undefined) return { kind: "busy" };
  try {
    return { kind: "complete", value: await operation() };
  } finally {
    guard.close();
  }
}
