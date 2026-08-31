// Shared atomic-publish rename [issue #3352]. Every runtime-state temp-then-rename and tree-swap
// used `renameSync` bare. On Windows, `MoveFileEx` fails with EPERM/EBUSY while ANY handle is open
// on a file in the tree — a transient AV/EDR scan of a just-extracted `.exe`/`.dll`, the indexer,
// or an Explorer preview. POSIX `rename(2)` does not fail for an open destination, so the helper
// is a no-op retry on those platforms (first try is the only try).
//
// Copy+delete is not a substitute: portable promotion (ADR-0121 D5) requires same-volume atomic
// rename. This helper retries the atomic primitive, then fails closed.
//
// keiko-security is the owner for the same reason as fs-hardening.ts [GEN-MAINT-COUPLING-005]: it
// depends only on contracts and is already imported by CLI, server, vault, and evidence.

import { realpathSync, renameSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { emitSecurityLogEvent, securityErrorKind, type SecurityLogSink } from "./log-port.js";

// Tree-swap / PE-install policy: immediate first try, then exponential backoff. Six attempts,
// 620 ms worst-case wait. Passed explicitly by install and activation callers — it is NOT the
// default, because vault and JSON publishes run on HTTP request threads.
export const WINDOWS_ATOMIC_RENAME_BACKOFF_MS = [0, 20, 40, 80, 160, 320] as const;

// Default for state-file publishes (vault, JSON, sidecars): three immediate retries, no sleep.
export const WINDOWS_ATOMIC_RENAME_STATE_FILE_BACKOFF_MS = [0, 20, 40] as const;

export const WINDOWS_ATOMIC_RENAME_RETRY_CODES = ["EBUSY", "EPERM"] as const;

const RETRY_CODES: ReadonlySet<string> = new Set(WINDOWS_ATOMIC_RENAME_RETRY_CODES);

export type AtomicPublishRenameFn = (from: string, to: string) => void;

export interface AtomicPublishRenameOptions {
  readonly platform?: NodeJS.Platform;
  readonly rename?: AtomicPublishRenameFn;
  readonly sleep?: (ms: number) => void;
  readonly securityLogSink?: SecurityLogSink;
  readonly backoffMs?: readonly number[] | undefined;
}

export interface CwdOutsideTreeOptions {
  readonly cwd?: () => string;
  readonly chdir?: (path: string) => void;
  readonly resolvePath?: (path: string) => string;
}

type RenameAttempt = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isWindowsTransientRenameError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && RETRY_CODES.has(code);
}

function invokeRename(rename: AtomicPublishRenameFn, from: string, to: string): RenameAttempt {
  try {
    rename(from, to);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function throwCaughtRenameError(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new TypeError("atomic publish rename failed");
}

function renameBackoff(options: AtomicPublishRenameOptions): readonly number[] {
  const backoff = options.backoffMs ?? WINDOWS_ATOMIC_RENAME_STATE_FILE_BACKOFF_MS;
  if (backoff.length === 0) {
    throw new TypeError("atomic publish rename backoffMs must not be empty");
  }
  return backoff;
}

function sleepBeforeAttempt(
  sleep: (ms: number) => void,
  attempt: number,
  backoff: readonly number[],
): void {
  const delay = backoff[attempt];
  if (delay !== undefined && delay > 0) sleep(delay);
}

function emitRenameRetry(
  sink: SecurityLogSink | undefined,
  attempts: number,
  error: unknown,
): void {
  emitSecurityLogEvent(sink, {
    level: "info",
    category: "security",
    op: "security.fs.atomic-rename-retried",
    errorKind: securityErrorKind(error),
    extra: { attempts },
  });
}

function emitRenameFailed(
  sink: SecurityLogSink | undefined,
  attempts: number,
  error: unknown,
): void {
  emitSecurityLogEvent(sink, {
    level: "error",
    category: "security",
    op: "security.fs.atomic-rename-failed",
    errorKind: securityErrorKind(error),
    extra: { attempts },
  });
}

function retryWindowsPublishRename(
  from: string,
  to: string,
  rename: AtomicPublishRenameFn,
  options: AtomicPublishRenameOptions,
): void {
  const sleep = options.sleep ?? sleepSync;
  const backoff = renameBackoff(options);
  let lastError: unknown;
  for (let attempt = 0; attempt < backoff.length; attempt += 1) {
    sleepBeforeAttempt(sleep, attempt, backoff);
    const result = invokeRename(rename, from, to);
    if (result.ok) {
      if (attempt > 0) emitRenameRetry(options.securityLogSink, attempt + 1, lastError);
      return;
    }
    lastError = result.error;
    if (!isWindowsTransientRenameError(result.error)) {
      emitRenameFailed(options.securityLogSink, attempt + 1, result.error);
      throwCaughtRenameError(result.error);
    }
  }
  emitRenameFailed(options.securityLogSink, backoff.length, lastError);
  throwCaughtRenameError(lastError);
}

export function atomicPublishRename(
  from: string,
  to: string,
  options: AtomicPublishRenameOptions = {},
): void {
  const rename = options.rename ?? renameSync;
  if ((options.platform ?? process.platform) !== "win32") {
    try {
      rename(from, to);
    } catch (error) {
      emitRenameFailed(options.securityLogSink, 1, error);
      throwCaughtRenameError(error);
    }
    return;
  }
  retryWindowsPublishRename(from, to, rename, options);
}

export function atomicPublishTreeSwap(
  from: string,
  to: string,
  options: Omit<AtomicPublishRenameOptions, "backoffMs"> = {},
): void {
  atomicPublishRename(from, to, {
    ...options,
    backoffMs: WINDOWS_ATOMIC_RENAME_BACKOFF_MS,
  });
}

function pathIsInside(
  candidate: string,
  root: string,
  resolvePath: (value: string) => string,
): boolean {
  const rel = relative(resolvePath(root), resolvePath(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function defaultResolvePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function restoreCwd(previous: string, fallback: string, chdir: (path: string) => void): void {
  try {
    chdir(previous);
  } catch {
    chdir(fallback);
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

// Self-update (and any other in-tree process) must not keep cwd inside a directory it is about to
// rename. Windows treats the cwd handle as a lock; POSIX usually does not. chdir does not unmap
// `node.exe` loaded from the tree — the retry above still covers that residual.
export function withCwdOutsideTree<T>(
  treeRoot: string,
  run: () => T,
  options: CwdOutsideTreeOptions = {},
): T {
  const cwd = options.cwd ?? ((): string => process.cwd());
  const chdir =
    options.chdir ??
    ((path: string): void => {
      process.chdir(path);
    });
  const resolvePath = options.resolvePath ?? defaultResolvePath;
  const previous = cwd();
  const parent = dirname(resolvePath(treeRoot));
  const leftTree = pathIsInside(previous, treeRoot, resolvePath);
  if (leftTree) chdir(parent);
  try {
    const result = run();
    if (isPromiseLike(result)) {
      throw new TypeError("withCwdOutsideTree run() must complete synchronously");
    }
    return result;
  } finally {
    if (leftTree) restoreCwd(previous, parent, chdir);
  }
}
