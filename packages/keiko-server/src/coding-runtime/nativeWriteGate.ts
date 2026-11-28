import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Orders the runtime's own file writes (a revert's `stage` and `clear`) against the writes a person
 * makes through Keiko (the Editor save, a rename, a delete, a create, a copy, a patch or a
 * search-and-replace apply) so that the two never run at once. The runtime writes whole files and
 * cannot be made to write conditionally, so Keiko cannot close the gap between its proof and the
 * runtime's write from inside the request. What it can do is never run a person's write inside that
 * gap: a save that arrives while the runtime writes waits and lands right after it, so the person's
 * edit wins, which is the right order. A write by a program Keiko does not control (an external
 * editor) is not ordered by this gate; that is the residual the operation notes name.
 *
 * Two writes are ordered when their roots are the same folder or one contains the other, so a Files
 * or Editor selection that is a subfolder or a parent of the run's workspace is ordered as well.
 *
 * Bounded both ways, and failing closed both ways: a person's write waits at most
 * `HUMAN_WRITE_WAIT_MS` and then does not run (`HumanWriteGateTimeoutError`, a retryable refusal); a
 * runtime write waits at most
 * `NATIVE_WRITE_WAIT_MS` for earlier runtime writes and for the person's writes already running, and
 * then throws `NativeWriteGateTimeoutError` without having sent anything.
 */
export const HUMAN_WRITE_WAIT_MS = 30_000;
export const NATIVE_WRITE_WAIT_MS = 30_000;

/** Told when a write gave up waiting: whose write, and how long it waited. */
export interface GateReport {
  readonly onTimeout?: ((side: "human" | "native", waitedMs: number) => void) | undefined;
}

export class HumanWriteGateTimeoutError extends Error {
  constructor() {
    super("human-write-gate-timeout");
    this.name = "HumanWriteGateTimeoutError";
  }
}

export class NativeWriteGateTimeoutError extends Error {
  constructor() {
    super("native-write-gate-timeout");
    this.name = "NativeWriteGateTimeoutError";
  }
}

/** One write registered with the gate, with its root normalized once. */
interface GateEntry {
  readonly key: string;
}

/** Runtime writes in arrival order: queued ones and the one running. */
const natives: GateEntry[] = [];
/** A person's writes that are running now. */
const humans = new Set<GateEntry>();
const listeners = new Set<() => void>();

/**
 * The folder a write is ordered by. `realpath.native` resolves links; it does not normalize case, so
 * the key is lowercased where the file system is case-insensitive by default (macOS, Windows). On
 * a case-sensitive volume under macOS that only orders two folders that differ by case, which is the
 * safe direction.
 */
function gateKey(root: string): string {
  const key = realpathOfExistingAncestor(resolve(root));
  return process.platform === "darwin" || process.platform === "win32" ? key.toLowerCase() : key;
}

/** The real path of the nearest existing ancestor with the missing rest appended, so both sides compare alike. */
function realpathOfExistingAncestor(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realpathOfExistingAncestor(parent), basename(path));
  }
}

function withSeparator(key: string): string {
  return key.endsWith(sep) ? key : `${key}${sep}`;
}

/** The same folder, or one inside the other. */
function related(a: GateEntry, b: GateEntry): boolean {
  return (
    a.key === b.key ||
    withSeparator(a.key).startsWith(withSeparator(b.key)) ||
    withSeparator(b.key).startsWith(withSeparator(a.key))
  );
}

function notify(): void {
  // A listener only removes itself and resolves its waiter here; the waiter registers again in a
  // later microtask, so the walk never meets an entry added during it.
  for (const listener of listeners) listener();
}

function nextChange(timeoutMs: number): Promise<void> {
  return new Promise<void>((done) => {
    const finish = (): void => {
      clearTimeout(timer);
      listeners.delete(finish);
      done();
    };
    const timer = setTimeout(finish, timeoutMs);
    listeners.add(finish);
  });
}

/**
 * Waits until `blocked` is false, looping over every change, and runs `acquire` in the same turn the
 * check passes, so nothing can slip in between the check and the registration. `false` when the
 * budget ran out; `acquire` has not run then.
 */
async function waitWhile(
  blocked: () => boolean,
  budgetMs: number,
  acquire: () => void,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!blocked()) {
      acquire();
      return true;
    }
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await nextChange(left); // NOSONAR typescript:S9382 -- each wake re-reads the whole gate
  }
}

/** True while a runtime write of a related workspace is queued or running. */
export function isNativeWorkspaceWriteRunning(root: string): boolean {
  const probe: GateEntry = { key: gateKey(root) };
  return natives.some((native) => related(native, probe));
}

/** Runs one of the runtime's own file writes after earlier related ones and running person writes. */
export async function runNativeWorkspaceWrite<Result>(
  root: string,
  write: () => Promise<Result>,
  waitMs: number = NATIVE_WRITE_WAIT_MS,
  report?: GateReport,
): Promise<Result> {
  const entry: GateEntry = { key: gateKey(root) };
  natives.push(entry);
  const startedAt = Date.now();
  try {
    const ready = await waitWhile(
      () =>
        natives.slice(0, natives.indexOf(entry)).some((earlier) => related(earlier, entry)) ||
        [...humans].some((human) => related(human, entry)),
      waitMs,
      () => undefined,
    );
    if (!ready) {
      report?.onTimeout?.("native", Date.now() - startedAt);
      throw new NativeWriteGateTimeoutError();
    }
    return await write();
  } finally {
    natives.splice(natives.indexOf(entry), 1);
    notify();
  }
}

/**
 * Waits (bounded) for every related runtime write, then runs a write the person made. Fails closed:
 * when the runtime write does not end within the bound the person's write does not run and
 * `HumanWriteGateTimeoutError` tells the route to answer with a retryable refusal.
 */
export async function runHumanWorkspaceWrite<Result>(
  root: string,
  write: () => Promise<Result>,
  waitMs: number = HUMAN_WRITE_WAIT_MS,
  report?: GateReport,
): Promise<Result> {
  const entry: GateEntry = { key: gateKey(root) };
  const startedAt = Date.now();
  const ready = await waitWhile(
    () => natives.some((native) => related(native, entry)),
    waitMs,
    () => {
      humans.add(entry);
    },
  );
  if (!ready) {
    report?.onTimeout?.("human", Date.now() - startedAt);
    throw new HumanWriteGateTimeoutError();
  }
  try {
    return await write();
  } finally {
    humans.delete(entry);
    notify();
  }
}

/** Writes currently waiting inside the gate (a test seam: waiting is observable, not slept for). */
export function nativeWriteGateWaiters(): number {
  return listeners.size;
}

/** Writes the gate still holds: none once every write has finished (a test seam for cleanup). */
export function openNativeWriteGateEntries(): number {
  return natives.length + humans.size + listeners.size;
}
